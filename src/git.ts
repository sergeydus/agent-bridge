import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
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
}): Promise<boolean> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const absoluteDestination = resolve(destination);
  await writeFile(absoluteDestination, '', { mode: 0o600 });
  try {
    await runCompleteWorkspaceDiff(workspace, {
      outputPath: absoluteDestination,
    });
    if ((await stat(absoluteDestination)).size === 0) {
      await rm(absoluteDestination, { force: true });
      return false;
    }
    await chmod(absoluteDestination, 0o600);
    return true;
  } catch (error) {
    await rm(absoluteDestination, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Streams a complete diff without touching the worktree's real Git index.
 * An alternate temporary index makes untracked files portable on every OS.
 */
async function runCompleteWorkspaceDiff(
  workspace: string,
  {
    outputPath,
    onStdoutChunk,
  }: {
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
    await execute('git', ['read-tree', 'HEAD'], { cwd: workspace, env });
    await execute('git', ['add', '--all', '--', '.'], { cwd: workspace, env });
    await execute(
      'git',
      [
        'diff',
        '--cached',
        '--binary',
        '--no-ext-diff',
        ...(outputPath ? [`--output=${outputPath}`] : []),
        'HEAD',
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

export async function currentCommit(cwd: string): Promise<string> {
  const result = await execute('git', ['rev-parse', 'HEAD'], { cwd });
  return result.stdout.trim();
}

export async function workspaceFingerprint(workspace: string): Promise<string> {
  const hash = createHash('sha256');
  await runCompleteWorkspaceDiff(workspace, {
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
