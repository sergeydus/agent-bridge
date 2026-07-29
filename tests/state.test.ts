import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { isSavedRun, RunStateStore, type SavedRun } from '../src/state.ts';

const makeRun = (id: string, status: SavedRun['status']): SavedRun => ({
  version: 2,
  id,
  createdAt: '2026-07-29T00:00:00.000Z',
  updatedAt: '2026-07-29T00:00:00.000Z',
  status,
  task: 'test task',
  originalCwd: '/tmp/project',
  agentCwd: '/tmp/project',
  projectKind: 'git',
  outputDirectory: '/tmp/runs',
  workflow: {
    kind: 'collaborative',
    firstAgent: 'claude',
    maxRounds: 6,
  },
  judge: 'codex',
  retries: 1,
  timeoutMinutes: 30,
  untilAgreement: true,
  requireAgreement: false,
  noTranscript: false,
  verification: [],
  protectedPaths: [],
  protectedPathFingerprints: {},
  completedCycles: 0,
  codexPrevious: '',
  claudePrevious: '',
  handoff: '',
  converged: false,
  rounds: [],
});

test('saves, loads, and finds the latest incomplete run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-state-'));
  try {
    const store = new RunStateStore(directory);
    await store.save(makeRun('run-001', 'completed'));
    await store.save(makeRun('run-002', 'reviewing'));

    assert.equal((await store.load('run-002')).task, 'test task');
    assert.equal((await store.latestIncomplete())?.id, 'run-002');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects unsafe run ids', () => {
  const store = new RunStateStore('/tmp/agent-bridge-state');
  assert.throws(() => store.pathFor('../escape'));
});

test('rejects malformed saved state instead of trusting a JSON cast', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-state-'));
  try {
    const store = new RunStateStore(directory);
    await writeFile(
      store.pathFor('broken'),
      JSON.stringify({ version: 1, id: 'broken' }),
    );
    await assert.rejects(() => store.load('broken'), /Invalid saved run/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects unsafe checkpoint limits and protected-path records', () => {
  const run = makeRun('validate-run', 'created');
  assert.equal(isSavedRun(run), true);
  assert.equal(
    isSavedRun({
      ...run,
      protectedPathFingerprints: [],
    }),
    false,
  );
  assert.equal(isSavedRun({ ...run, retries: 4 }), false);
  assert.equal(isSavedRun({ ...run, timeoutMinutes: 181 }), false);
  assert.equal(isSavedRun({ ...run, unexpected: true }), false);
  assert.equal(isSavedRun({ ...run, updatedAt: 'not-a-date' }), false);
  assert.equal(
    isSavedRun({
      ...run,
      protectedPaths: ['../outside'],
      protectedPathFingerprints: { '../outside': 'hash' },
    }),
    false,
  );
});

test('locks a run against concurrent resume and releases it safely', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-state-'));
  try {
    const store = new RunStateStore(directory);
    const lock = await store.acquireLock('run-locked');
    await assert.rejects(
      () => store.acquireLock('run-locked'),
      /already active/,
    );
    await lock.release();
    const nextLock = await store.acquireLock('run-locked');
    await nextLock.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('migrates valid version 1 checkpoints with safe defaults', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-state-'));
  try {
    const store = new RunStateStore(directory);
    const legacy = {
      version: 1,
      id: 'legacy-run',
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z',
      status: 'reviewing',
      task: 'legacy',
      originalCwd: '/tmp/project',
      agentCwd: '/tmp/project',
      workflow: { kind: 'review', maxRounds: 2 },
      completedImplementationRounds: 1,
      codexPrevious: '<status>DONE</status>',
      claudePrevious: '<status>CONTINUE</status>',
      handoff: '',
      converged: false,
      rounds: [
        {
          phase: 'Discussion',
          round: 1,
          codex: '<status>DONE</status>',
          claude: '<status>CONTINUE</status>',
        },
      ],
    };
    await writeFile(store.pathFor('legacy-run'), JSON.stringify(legacy));
    const migrated = await store.load('legacy-run');
    assert.equal(migrated.version, 2);
    assert.equal(migrated.completedCycles, 1);
    assert.equal(migrated.rounds[0]?.codexDecision, 'done');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
