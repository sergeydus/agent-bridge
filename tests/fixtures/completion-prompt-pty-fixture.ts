import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { finishIsolatedRun } from '../../src/artifacts.ts';
import {
  createIsolatedWorktree,
  currentCommit,
  execute,
} from '../../src/git.ts';
import { ProgressReporter } from '../../src/ui.ts';

/**
 * Drives the real completion menu on a real terminal. The PTY test presses
 * Ctrl+D at the menu, which is the reproduction for D1: before Phase 4 that
 * rejected out of the completion step and marked a finished run failed.
 */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-completion-pty-'));
  const repository = join(root, 'repository');
  try {
    await execute('git', ['init', repository], { cwd: root });
    for (const [key, value] of [
      ['user.name', 'Agent Bridge Test'],
      ['user.email', 'test@example.com'],
      ['commit.gpgsign', 'false'],
    ] as [string, string][]) {
      await execute('git', ['config', key, value], { cwd: repository });
    }
    await writeFile(join(repository, 'tracked.txt'), 'before\n');
    await execute('git', ['add', 'tracked.txt'], { cwd: repository });
    await execute('git', ['commit', '-m', 'initial'], { cwd: repository });

    const workspace = await createIsolatedWorktree({
      repository,
      runsDirectory: join(root, 'runs'),
      runId: 'pty-run',
    });
    await writeFile(join(workspace, 'tracked.txt'), 'after\n');

    process.stdout.write(
      `__AB_TTY__${String(Boolean(process.stdin.isTTY))}:${String(Boolean(process.stdout.isTTY))}\r\n`,
    );
    const finished = await finishIsolatedRun({
      repository,
      workspace,
      patchPath: join(root, 'pty-run.patch'),
      baseRevision: await currentCommit(repository),
      reporter: new ProgressReporter({ silent: true }),
    });
    process.stdout.write(`\r\n__AB_OUTCOME__${finished.outcome}\r\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
