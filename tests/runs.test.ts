import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  deleteRun,
  discardRunWorkspace,
  pruneCompletedRuns,
} from '../src/runs.ts';
import { createIsolatedWorktree, currentCommit, execute } from '../src/git.ts';
import { RunStateStore, type SavedRun } from '../src/state.ts';

function runFixture(
  id: string,
  outputDirectory: string,
  updatedAt: string,
  workspace?: string,
): SavedRun {
  return {
    version: 3,
    id,
    createdAt: updatedAt,
    updatedAt,
    status: 'completed',
    task: 'task',
    originalCwd: '/project',
    agentCwd: '/project',
    projectKind: 'git',
    outputDirectory,
    workspace,
    workflow: { kind: 'review', maxRounds: 2 },
    judge: 'codex',
    retries: 1,
    timeoutMinutes: 30,
    untilAgreement: true,
    requireAgreement: false,
    noTranscript: false,
    verification: [],
    protectedPaths: [],
    protectedPathFingerprints: {},
    completedCycles: 1,
    codexPrevious: '',
    claudePrevious: '',
    handoff: '',
    converged: true,
    rounds: [],
  };
}

test('deletes exact run artifacts while preserving editable workspaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-runs-'));
  const stateDirectory = join(root, 'state');
  try {
    const store = new RunStateStore(stateDirectory);
    const run = runFixture(
      'delete-me',
      root,
      '2026-01-01T00:00:00.000Z',
      '/preserved-workspace',
    );
    await store.save(run);
    await writeFile(join(root, 'delete-me.md'), 'private');
    await writeFile(
      join(root, 'delete-me.preexisting.patch'),
      'private recovery',
    );
    const result = await deleteRun({ run, store });
    assert.equal(result.workspacePreserved, '/preserved-workspace');
    await assert.rejects(() => readFile(join(root, 'delete-me.md')), /ENOENT/);
    await assert.rejects(
      () => readFile(join(root, 'delete-me.preexisting.patch')),
      /ENOENT/,
    );
    await assert.rejects(() => store.load('delete-me'), /Saved run not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('prunes only old completed runs without retained workspaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-runs-'));
  const store = new RunStateStore(join(root, 'state'));
  try {
    await store.save(runFixture('old-run', root, '2025-01-01T00:00:00.000Z'));
    await store.save(
      runFixture(
        'workspace-run',
        root,
        '2025-01-01T00:00:00.000Z',
        '/workspace',
      ),
    );
    const result = await pruneCompletedRuns({
      store,
      olderThanDays: 30,
      now: Date.now() + 31 * 24 * 60 * 60 * 1_000,
    });
    assert.deepEqual(result, { deleted: 1, skippedWorkspaces: 1 });
    assert.equal((await store.list()).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('discards only terminal registered workspaces and updates saved state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-runs-'));
  const store = new RunStateStore(join(root, 'state'));
  try {
    const run = runFixture(
      'workspace-run',
      root,
      '2026-01-01T00:00:00.000Z',
      '/safe/workspace',
    );
    await store.save(run);
    const removals: Array<{ repository: string; workspace: string }> = [];
    const removed = await discardRunWorkspace({
      run,
      store,
      removeWorkspace: async (options) => {
        removals.push(options);
      },
      plan: () => Promise.resolve({ removable: true }),
    });

    assert.equal(removed, '/safe/workspace');
    assert.deepEqual(removals, [
      { repository: '/project', workspace: '/safe/workspace' },
    ]);
    assert.equal((await store.load('workspace-run')).workspace, undefined);

    await assert.rejects(
      () =>
        discardRunWorkspace({
          run: { ...run, status: 'reviewing' },
          store,
          removeWorkspace: async () => {},
        }),
      /Only completed or cancelled/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a run whose completion was declined can still be discarded', async () => {
  // The durable consequence of D1: pressing Ctrl+D at the completion menu used
  // to leave a failed checkpoint, and discardRunWorkspace refuses those.
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-runs-'));
  const stateDirectory = join(root, 'state');
  try {
    const store = new RunStateStore(stateDirectory);
    const run: SavedRun = {
      ...runFixture(
        'declined-run',
        root,
        '2026-08-11T00:00:00.000Z',
        '/workspaces/declined-run',
      ),
      completion: {
        outcome: 'declined',
        recordedAt: '2026-08-11T00:00:00.000Z',
      },
    };
    await store.save(run);

    const removed: { repository: string; workspace: string }[] = [];
    const discarded = await discardRunWorkspace({
      run: await store.load('declined-run'),
      store,
      removeWorkspace: (request) => {
        removed.push(request);
        return Promise.resolve();
      },
      plan: () => Promise.resolve({ removable: true }),
    });

    assert.equal(discarded, '/workspaces/declined-run');
    assert.deepEqual(removed, [
      { repository: '/project', workspace: '/workspaces/declined-run' },
    ]);
    const reloaded = await store.load('declined-run');
    assert.equal(reloaded.workspace, undefined);
    assert.equal(reloaded.agentCwd, '/project');
    // Run management never rewrites how the run's own completion resolved.
    assert.deepEqual(reloaded.completion, run.completion);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('run management refuses to remove a workspace holding unanchored commits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-runs-gate-'));
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
    const baseRevision = await currentCommit(repository);
    const workspace = await createIsolatedWorktree({
      repository,
      runsDirectory: join(root, 'runs'),
      runId: 'gate-run',
    });
    await writeFile(join(workspace, 'tracked.txt'), 'after\n');
    await execute('git', ['commit', '--all', '-m', 'inside'], {
      cwd: workspace,
    });

    const store = new RunStateStore(join(root, 'state'));
    const run: SavedRun = {
      ...runFixture('gate-run', root, '2026-08-11T00:00:00.000Z', workspace),
      originalCwd: repository,
      agentCwd: workspace,
      baseRevision,
    };
    await store.save(run);

    let removed = 0;
    await assert.rejects(
      () =>
        discardRunWorkspace({
          run,
          store,
          removeWorkspace: () => {
            removed += 1;
            return Promise.resolve();
          },
        }),
      /no branch or tag contains those commits/,
    );

    assert.equal(removed, 0);
    assert.equal((await store.load('gate-run')).workspace, workspace);
    // The refusal still leaves a complete patch behind.
    assert.match(
      await readFile(join(root, 'gate-run.patch'), 'utf8'),
      /tracked\.txt/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('run management removes a workspace once its history is anchored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-runs-gate-'));
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
    const baseRevision = await currentCommit(repository);
    const workspace = await createIsolatedWorktree({
      repository,
      runsDirectory: join(root, 'runs'),
      runId: 'anchored-run',
    });
    await writeFile(join(workspace, 'tracked.txt'), 'after\n');
    await execute('git', ['commit', '--all', '-m', 'inside'], {
      cwd: workspace,
    });
    await execute('git', ['branch', 'keep-my-work'], { cwd: workspace });

    const store = new RunStateStore(join(root, 'state'));
    const run: SavedRun = {
      ...runFixture(
        'anchored-run',
        root,
        '2026-08-11T00:00:00.000Z',
        workspace,
      ),
      originalCwd: repository,
      agentCwd: workspace,
      baseRevision,
    };
    await store.save(run);

    const removed = await discardRunWorkspace({ run, store });

    assert.equal(removed, workspace);
    const reloaded = await store.load('anchored-run');
    assert.equal(reloaded.workspace, undefined);
    assert.equal(reloaded.agentCwd, repository);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
