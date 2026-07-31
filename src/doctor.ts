import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { AppPaths } from './paths.ts';
import { runProcess } from './process.ts';
import { CLAUDE_OPTIONAL_FLAGS, type ProviderMap } from './providers.ts';

export interface DoctorReport {
  passed: boolean;
  lines: string[];
}

async function settle<T>(
  promise: Promise<T>,
): Promise<PromiseSettledResult<T>> {
  try {
    return { status: 'fulfilled', value: await promise };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runDoctor({
  appPaths,
  providers,
}: {
  appPaths: AppPaths;
  providers: ProviderMap;
}): Promise<DoctorReport> {
  const lines = [`Node: ${process.version}`, `User data: ${appPaths.root}`];
  let passed = true;

  const gitCheck = runProcess('git', ['--version'], { timeoutMs: 10_000 });
  const storageCheck = (async () => {
    await mkdir(appPaths.root, { recursive: true, mode: 0o700 });
    const probe = await mkdtemp(join(appPaths.root, '.doctor-'));
    await rm(probe, { recursive: true, force: true });
  })();
  const [
    git,
    storage,
    codexVersion,
    claudeVersion,
    codexAuth,
    claudeAuth,
    codexHelp,
    claudeHelp,
  ] = await Promise.all([
    settle(gitCheck),
    settle(storageCheck),
    settle(providers.codex.version()),
    settle(providers.claude.version()),
    settle(providers.codex.authStatus()),
    settle(providers.claude.authStatus()),
    settle(runProcess('codex', ['exec', '--help'], { timeoutMs: 10_000 })),
    settle(runProcess('claude', ['--help'], { timeoutMs: 10_000 })),
  ]);

  if (git.status === 'fulfilled') {
    lines.push(`Git: ${git.value.stdout.trim()}`);
  } else {
    passed = false;
    lines.push(`Git: unavailable (${errorMessage(git.reason)})`);
  }
  if (storage.status === 'fulfilled') {
    lines.push('User data: writable');
  } else {
    passed = false;
    lines.push(`User data: not writable (${errorMessage(storage.reason)})`);
  }

  for (const [provider, check] of [
    [providers.codex, codexVersion] as const,
    [providers.claude, claudeVersion] as const,
  ]) {
    if (check.status === 'fulfilled') {
      lines.push(`${provider.label}: ${check.value.stdout.trim()}`);
    } else {
      passed = false;
      lines.push(
        `${provider.label}: unavailable (${errorMessage(check.reason)})`,
      );
    }
  }

  if (codexAuth.status === 'fulfilled') {
    const output = [codexAuth.value.stdout, codexAuth.value.stderr]
      .join('\n')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    lines.push(
      `Codex auth: ${output.find((line) => line.startsWith('Logged in')) ?? output.at(-1) ?? 'unknown'}`,
    );
  } else {
    passed = false;
    lines.push(`Codex auth: unavailable (${errorMessage(codexAuth.reason)})`);
  }

  if (claudeAuth.status === 'fulfilled') {
    try {
      const parsed: unknown = JSON.parse(claudeAuth.value.stdout);
      const status =
        parsed && typeof parsed === 'object'
          ? (parsed as { loggedIn?: boolean; authMethod?: string })
          : {};
      if (!status.loggedIn) {
        passed = false;
      }
      lines.push(
        `Claude auth: ${
          status.loggedIn
            ? (status.authMethod ?? 'authenticated')
            : 'not logged in'
        }`,
      );
    } catch (error) {
      passed = false;
      lines.push(`Claude auth: invalid response (${errorMessage(error)})`);
    }
  } else {
    passed = false;
    lines.push(`Claude auth: unavailable (${errorMessage(claudeAuth.reason)})`);
  }

  const codexCapabilities =
    codexHelp.status === 'fulfilled' &&
    ['--output-schema', '--sandbox', '--ignore-user-config'].every((flag) =>
      codexHelp.value.stdout.includes(flag),
    );
  const claudeCapabilities =
    claudeHelp.status === 'fulfilled' &&
    ['--json-schema', '--permission-mode', '--allowedTools'].every((flag) =>
      claudeHelp.value.stdout.includes(flag),
    );
  passed &&= codexCapabilities && claudeCapabilities;
  lines.push(
    `Codex capabilities: ${codexCapabilities ? 'compatible' : 'missing required flags'}`,
  );
  lines.push(
    `Claude capabilities: ${claudeCapabilities ? 'compatible' : 'missing required flags'}`,
  );

  // Optional flags vary between provider releases and are used only when the
  // installed CLI advertises them, so a missing one is reported, never fatal.
  const claudeHelpText =
    claudeHelp.status === 'fulfilled' ? claudeHelp.value.stdout : '';
  const optional = Object.entries(CLAUDE_OPTIONAL_FLAGS).map(
    ([, flag]) => `${flag} ${claudeHelpText.includes(flag) ? 'yes' : 'no'}`,
  );
  lines.push(`Claude optional flags: ${optional.join(', ')}`);

  return { passed, lines };
}
