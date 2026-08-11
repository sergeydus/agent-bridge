import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { producePrivateFileAtomic } from './filesystem.ts';
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
    captureStdout,
    onStdoutChunk,
  }: {
    cwd: string;
    allowedExitCodes?: number[];
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    captureStdout?: boolean;
    onStdoutChunk?: (chunk: string) => void;
  },
): Promise<CommandResult> {
  return runProcess(command, args, {
    cwd,
    allowedExitCodes,
    env,
    signal,
    captureStdout,
    onStdoutChunk,
  });
}

export async function repositoryRoot(cwd: string): Promise<string> {
  const result = await execute('git', ['rev-parse', '--show-toplevel'], {
    cwd,
  });
  return realpath(result.stdout.trim());
}

export async function initializeRepository(cwd: string): Promise<string> {
  await execute('git', ['init'], { cwd });
  return repositoryRoot(cwd);
}

export async function repositoryHasHead(cwd: string): Promise<boolean> {
  const result = await execute(
    'git',
    ['rev-parse', '--verify', '--quiet', 'HEAD'],
    {
      cwd,
      allowedExitCodes: [0, 1],
    },
  );
  return result.exitCode === 0;
}

/**
 * Creates the workspace at an explicit revision rather than at symbolic `HEAD`.
 * The caller records a baseline before this runs, and every later patch, apply,
 * and removal decision is made against it; resolving `HEAD` again here would
 * let the source move in between and silently build the workspace from a
 * different commit than the one recorded.
 */
export async function createIsolatedWorktree({
  repository,
  runsDirectory,
  runId,
  revision,
}: {
  repository: string;
  runsDirectory: string;
  runId: string;
  revision: string;
}): Promise<string> {
  const workspace = join(runsDirectory, 'workspaces', runId);
  await mkdir(dirname(workspace), { recursive: true, mode: 0o700 });
  await execute('git', ['worktree', 'add', '--detach', workspace, revision], {
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

/**
 * Captures a workspace against an explicit baseline. The baseline is required
 * rather than implied from `HEAD`, because a workspace whose `HEAD` has moved
 * would otherwise produce a patch that silently omits every committed change.
 */
export async function createPatch({
  workspace,
  destination,
  baseRevision,
}: {
  workspace: string;
  destination: string;
  baseRevision: string;
}): Promise<boolean> {
  return producePrivateFileAtomic({
    destination: resolve(destination),
    produce: (temporaryPath) =>
      runCompleteWorkspaceDiff(workspace, {
        baseRevision,
        outputPath: temporaryPath,
      }),
    keep: async (temporaryPath) => (await stat(temporaryPath)).size > 0,
  });
}

/**
 * Streams a complete diff without touching the worktree's real Git index.
 * An alternate temporary index makes untracked files portable on every OS.
 */
async function runCompleteWorkspaceDiff(
  workspace: string,
  {
    baseRevision,
    outputPath,
    onStdoutChunk,
  }: {
    baseRevision: string;
    outputPath?: string;
    onStdoutChunk?: (chunk: string) => void;
  },
): Promise<void> {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), 'agent-bridge-index-'),
  );
  const temporaryIndex = join(temporaryDirectory, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
  try {
    await execute('git', ['read-tree', baseRevision], { cwd: workspace, env });
    await execute('git', ['add', '--all', '--', '.'], { cwd: workspace, env });
    await execute(
      'git',
      [
        'diff',
        '--cached',
        '--binary',
        '--no-ext-diff',
        ...(outputPath ? [`--output=${outputPath}`] : []),
        baseRevision,
      ],
      {
        cwd: workspace,
        env,
        captureStdout: outputPath === undefined && onStdoutChunk === undefined,
        onStdoutChunk,
      },
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/**
 * Reports whether any branch or tag contains the commit, which is what decides
 * whether removing a worktree drops the last reference to its history. Refs are
 * shared across worktrees, so this is correct from inside the workspace.
 */
export async function isCommitAnchored({
  workspace,
  revision,
}: {
  workspace: string;
  revision: string;
}): Promise<boolean> {
  const result = await execute(
    'git',
    [
      'for-each-ref',
      `--contains=${revision}`,
      '--count=1',
      '--format=%(refname)',
      'refs/heads',
      'refs/tags',
    ],
    { cwd: workspace },
  );
  return result.stdout.trim() !== '';
}

/**
 * Describes how far a workspace has moved from its baseline. `baseRevision` is
 * not necessarily an ancestor of `HEAD` — a reset or rebase inside the
 * workspace breaks that — so a commit count is reported only when it is.
 */
export async function describeCommitsSinceBase({
  workspace,
  baseRevision,
}: {
  workspace: string;
  baseRevision: string;
}): Promise<{ head: string; commits?: number; diverged: boolean }> {
  const head = await currentCommit(workspace);
  if (head === baseRevision) {
    return { head, commits: 0, diverged: false };
  }
  const ancestry = await execute(
    'git',
    ['merge-base', '--is-ancestor', baseRevision, head],
    { cwd: workspace, allowedExitCodes: [0, 1] },
  );
  if (ancestry.exitCode !== 0) {
    return { head, diverged: true };
  }
  const counted = await execute(
    'git',
    ['rev-list', '--count', `${baseRevision}..${head}`],
    { cwd: workspace },
  );
  return { head, commits: Number(counted.stdout.trim()), diverged: false };
}

export async function currentCommit(cwd: string): Promise<string> {
  const result = await execute('git', ['rev-parse', 'HEAD'], { cwd });
  return result.stdout.trim();
}

/**
 * Fingerprints a workspace against a fixed baseline. Against the moving `HEAD`,
 * committing an edit returned the fingerprint to its clean value; against a
 * fixed base it keeps the value the edit gave it, so committed and uncommitted
 * work compare the same.
 */
export async function workspaceFingerprint({
  workspace,
  baseRevision,
}: {
  workspace: string;
  baseRevision: string;
}): Promise<string> {
  const hash = createHash('sha256');
  await runCompleteWorkspaceDiff(workspace, {
    baseRevision,
    onStdoutChunk: (chunk) => hash.update(chunk),
  });
  return hash.digest('hex');
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

/**
 * How many files a patch touches, without applying it. Reported after a
 * successful apply so the user knows the size of what landed; the patch itself,
 * not the diff, is what keeps the agents' changes distinguishable afterwards.
 */
export async function countPatchedFiles({
  repository,
  patchPath,
}: {
  repository: string;
  patchPath: string;
}): Promise<number> {
  const result = await execute('git', ['apply', '--numstat', patchPath], {
    cwd: repository,
  });
  return result.stdout.split('\n').filter((line) => line.trim() !== '').length;
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
