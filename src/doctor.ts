import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { errorMessage } from './core.ts';
import type { AppPaths } from './paths.ts';
import { combinedProcessOutput, runProcess } from './process.ts';
import {
  CLAUDE_MINIMUM_VERSION,
  CLAUDE_OPTIONAL_FLAGS,
  CLAUDE_REQUIRED_FLAGS,
  CLAUDE_REQUIRED_HIDDEN_FLAGS,
  CODEX_REQUIRED_FLAGS,
  meetsMinimumVersion,
  parseAdvertisedFlags,
  type ProviderMap,
} from './providers.ts';

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

  const missingFlags = (
    help: PromiseSettledResult<{ stdout: string; stderr: string }>,
    required: readonly string[],
  ): string[] | undefined => {
    if (help.status !== 'fulfilled') {
      return undefined;
    }
    // Whole tokens only: a substring search would accept `--json` merely
    // because the CLI advertises `--json-schema`.
    const advertised = parseAdvertisedFlags(combinedProcessOutput(help.value));
    return required.filter((flag) => !advertised.has(flag));
  };

  for (const [label, help, required] of [
    ['Codex', codexHelp, CODEX_REQUIRED_FLAGS] as const,
    ['Claude', claudeHelp, CLAUDE_REQUIRED_FLAGS] as const,
  ]) {
    const missing = missingFlags(help, required);
    if (missing === undefined) {
      passed = false;
      lines.push(`${label} capabilities: help output unavailable`);
      continue;
    }
    if (missing.length > 0) {
      passed = false;
      lines.push(`${label} capabilities: missing ${missing.join(', ')}`);
      continue;
    }
    lines.push(`${label} capabilities: compatible`);
  }

  // Claude implements these but omits them from help, so a flag probe can never
  // confirm them. The tested-version floor is the check that stands in for it.
  const claudeVersionMeetsMinimum =
    claudeVersion.status === 'fulfilled'
      ? meetsMinimumVersion(
          combinedProcessOutput(claudeVersion.value),
          CLAUDE_MINIMUM_VERSION,
        )
      : false;
  if (claudeVersionMeetsMinimum === false) {
    passed = false;
    lines.push(
      `Claude hidden required flags (${CLAUDE_REQUIRED_HIDDEN_FLAGS.join(', ')}): ` +
        `unsupported below Claude Code ${CLAUDE_MINIMUM_VERSION}`,
    );
  } else if (claudeVersionMeetsMinimum === undefined) {
    // The version floor is the only check standing behind these flags, so an
    // unreadable version means compatibility was never established. Reporting
    // that as a pass would be the silent failure this check exists to prevent.
    passed = false;
    lines.push(
      `Claude hidden required flags (${CLAUDE_REQUIRED_HIDDEN_FLAGS.join(', ')}): ` +
        'unverified, could not read a version number',
    );
  } else {
    lines.push(
      `Claude hidden required flags (${CLAUDE_REQUIRED_HIDDEN_FLAGS.join(', ')}): ` +
        `covered by Claude Code >= ${CLAUDE_MINIMUM_VERSION}`,
    );
  }

  // Optional flags vary between provider releases and are used only when the
  // installed CLI advertises them, so a missing one is reported, never fatal.
  const claudeAdvertised =
    claudeHelp.status === 'fulfilled'
      ? parseAdvertisedFlags(combinedProcessOutput(claudeHelp.value))
      : new Set<string>();
  const optional = Object.entries(CLAUDE_OPTIONAL_FLAGS).map(
    ([, flag]) => `${flag} ${claudeAdvertised.has(flag) ? 'yes' : 'no'}`,
  );
  lines.push(`Claude optional flags: ${optional.join(', ')}`);

  return { passed, lines };
}
