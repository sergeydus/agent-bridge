import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { runProcess } from './process.ts';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function execute(
  command: string,
  args: string[],
  {
    cwd,
    allowedExitCodes = [0],
    env,
    signal,
  }: {
    cwd: string;
    allowedExitCodes?: number[];
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  },
): Promise<CommandResult> {
  return runProcess(command, args, {
    cwd,
    allowedExitCodes,
    env,
    signal,
  });
}

export async function repositoryRoot(cwd: string): Promise<string> {
  const result = await execute('git', ['rev-parse', '--show-toplevel'], {
    cwd,
  });
  return realpath(result.stdout.trim());
}

export async function createIsolatedWorktree({
  repository,
  runsDirectory,
  runId,
}: {
  repository: string;
  runsDirectory: string;
  runId: string;
}): Promise<string> {
  const workspace = join(runsDirectory, 'workspaces', runId);
  await mkdir(dirname(workspace), { recursive: true, mode: 0o700 });
  await execute('git', ['worktree', 'add', '--detach', workspace, 'HEAD'], {
    cwd: repository,
  });
  return workspace;
}

export async function removeIsolatedWorktree({
  repository,
  workspace,
}: {
  repository: string;
  workspace: string;
}): Promise<void> {
  const root = resolve(repository);
  const target = resolve(workspace);
  const canonicalRoot = await realpath(root);
  const canonicalTarget = await realpath(target);
  const registered = await execute('git', ['worktree', 'list', '--porcelain'], {
    cwd: root,
  });
  const worktrees = await Promise.all(
    registered.stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => realpath(line.slice('worktree '.length))),
  );
  if (
    canonicalTarget === canonicalRoot ||
    !worktrees.includes(canonicalTarget)
  ) {
    throw new Error(`Refusing to remove unsafe worktree path: ${target}`);
  }
  await execute('git', ['worktree', 'remove', '--force', canonicalTarget], {
    cwd: canonicalRoot,
  });
}

export async function createPatch({
  workspace,
  destination,
}: {
  workspace: string;
  destination: string;
}): Promise<string> {
  const patch = await completeWorkspacePatch(workspace);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  if (!patch) {
    await rm(destination, { force: true });
    return '';
  }
  await writeFile(destination, patch, { mode: 0o600 });
  return patch;
}

/**
 * Builds a complete patch without touching the worktree's real Git index.
 * An alternate temporary index makes untracked files portable on every OS.
 */
export async function completeWorkspacePatch(
  workspace: string,
): Promise<string> {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'agent-bridge-index-'),
  );
  const temporaryIndex = join(temporaryDirectory, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
  try {
    await execute('git', ['read-tree', 'HEAD'], { cwd: workspace, env });
    await execute('git', ['add', '--all', '--', '.'], { cwd: workspace, env });
    const result = await execute(
      'git',
      ['diff', '--cached', '--binary', '--no-ext-diff', 'HEAD'],
      { cwd: workspace, env },
    );
    return result.stdout ? `${result.stdout.trimEnd()}\n` : '';
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function currentCommit(cwd: string): Promise<string> {
  const result = await execute('git', ['rev-parse', 'HEAD'], { cwd });
  return result.stdout.trim();
}

export async function workspaceFingerprint(workspace: string): Promise<string> {
  const patch = await completeWorkspacePatch(workspace);
  return createHash('sha256').update(patch).digest('hex');
}

export async function canApplyPatch({
  repository,
  patchPath,
}: {
  repository: string;
  patchPath: string;
}): Promise<boolean> {
  const result = await execute(
    'git',
    ['apply', '--check', '--whitespace=nowarn', patchPath],
    { cwd: repository, allowedExitCodes: [0, 1] },
  );
  return result.exitCode === 0;
}

export async function applyPatch({
  repository,
  patchPath,
}: {
  repository: string;
  patchPath: string;
}): Promise<void> {
  await execute('git', ['apply', '--whitespace=nowarn', patchPath], {
    cwd: repository,
  });
}
