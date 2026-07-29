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
import { RunStateStore, type SavedRun } from '../src/state.ts';

function runFixture(
  id: string,
  outputDirectory: string,
  updatedAt: string,
  workspace?: string,
): SavedRun {
  return {
    version: 2,
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
