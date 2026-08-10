import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { isSavedRun, RunStateStore, type SavedRun } from '../src/state.ts';

const makeRun = (id: string, status: SavedRun['status']): SavedRun => ({
  version: 3,
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
      JSON.stringify({ version: 3, id: 'broken' }),
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

test('refuses a superseded checkpoint without touching it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-state-'));
  try {
    const store = new RunStateStore(directory);
    const previous = { ...makeRun('v2-run', 'reviewing'), version: 2 };
    const serialized = JSON.stringify(previous);
    await writeFile(store.pathFor('v2-run'), serialized);

    await assert.rejects(
      () => store.load('v2-run'),
      (error: Error) => {
        assert.match(error.message, /checkpoint version 2/);
        assert.match(error.message, /version 3 is the supported baseline/);
        assert.match(error.message, /Nothing was changed or deleted/);
        assert.match(error.message, new RegExp(store.pathFor('v2-run')));
        return true;
      },
    );

    assert.equal(await readFile(store.pathFor('v2-run'), 'utf8'), serialized);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('names every superseded version it can recognize', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-state-'));
  try {
    const store = new RunStateStore(directory);
    for (const version of [1, 2]) {
      await writeFile(
        store.pathFor(`old-${version}`),
        JSON.stringify({ version, id: `old-${version}` }),
      );
      await assert.rejects(
        () => store.load(`old-${version}`),
        new RegExp(`checkpoint version ${version}`),
      );
    }

    // Not a version this build superseded: it is simply invalid.
    await writeFile(
      store.pathFor('future'),
      JSON.stringify({ version: 4, id: 'future' }),
    );
    await assert.rejects(() => store.load('future'), /Invalid saved run/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a superseded checkpoint is skipped rather than failing the run list', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-state-'));
  const warnings: string[] = [];
  try {
    const store = new RunStateStore(directory, (message) =>
      warnings.push(message),
    );
    await store.save(makeRun('current-run', 'completed'));
    await writeFile(
      store.pathFor('old-run'),
      JSON.stringify({ ...makeRun('old-run', 'completed'), version: 2 }),
    );

    const listed = await store.list();
    assert.deepEqual(
      listed.map((run) => run.id),
      ['current-run'],
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /checkpoint version 2/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('round-trips a version 3 checkpoint that recorded a completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-state-'));
  try {
    const store = new RunStateStore(directory);
    const run: SavedRun = {
      ...makeRun('v3-run', 'completed'),
      workspace: '/tmp/runs/workspaces/v3-run',
      completion: {
        outcome: 'apply-refused',
        recordedAt: '2026-08-10T00:00:00.000Z',
        reason: 'The patch conflicts with the original checkout.',
      },
    };
    await store.save(run);

    const loaded = await store.load('v3-run');
    assert.deepEqual(loaded.completion, run.completion);
    assert.equal(loaded.version, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects a completion record that is structurally wrong', () => {
  const base = makeRun('completion-shape', 'completed');
  const withCompletion = (completion: unknown): unknown => ({
    ...base,
    workspace: '/tmp/workspace',
    completion,
  });

  assert.equal(
    isSavedRun(
      withCompletion({
        outcome: 'kept',
        recordedAt: '2026-08-10T00:00:00.000Z',
      }),
    ),
    true,
  );
  assert.equal(
    isSavedRun(
      withCompletion({
        outcome: 'shipped-it',
        recordedAt: '2026-08-10T00:00:00.000Z',
      }),
    ),
    false,
  );
  assert.equal(
    isSavedRun(withCompletion({ outcome: 'kept', recordedAt: 'yesterday' })),
    false,
  );
  assert.equal(
    isSavedRun(
      withCompletion({
        outcome: 'kept',
        recordedAt: '2026-08-10T00:00:00.000Z',
        unexpected: true,
      }),
    ),
    false,
  );
  assert.equal(isSavedRun(withCompletion({ outcome: 'kept' })), false);
});

test('rejects a completion record that contradicts the rest of the run', () => {
  const completed = makeRun('completion-fields', 'completed');
  const recordedAt = '2026-08-10T00:00:00.000Z';
  const workspace = '/tmp/runs/workspaces/completion-fields';

  // 1. A completion belongs only to a run that finished.
  assert.equal(
    isSavedRun({
      ...makeRun('completion-fields', 'failed'),
      completion: { outcome: 'kept', recordedAt },
    }),
    false,
  );

  // 3. A refusal or failure must say why.
  for (const outcome of [
    'apply-refused',
    'apply-failed',
    'discard-failed',
    'patch-failed',
  ]) {
    assert.equal(
      isSavedRun({
        ...completed,
        workspace,
        completion: { outcome, recordedAt },
      }),
      false,
      `${outcome} must require a reason`,
    );
    assert.equal(
      isSavedRun({
        ...completed,
        workspace,
        completion: { outcome, recordedAt, reason: '   ' },
      }),
      false,
      `${outcome} must reject a blank reason`,
    );
  }

  // 4. A succeeded action must not carry failure data.
  for (const outcome of ['no-changes', 'kept', 'declined', 'applied']) {
    assert.equal(
      isSavedRun({
        ...completed,
        workspace,
        completion: { outcome, recordedAt, reason: 'why would this be here' },
      }),
      false,
      `${outcome} must reject a reason`,
    );
  }

  // 5. Discarded means the workspace is gone and the agent path was restored.
  assert.equal(
    isSavedRun({
      ...completed,
      workspace,
      completion: { outcome: 'discarded', recordedAt },
    }),
    false,
  );
  assert.equal(
    isSavedRun({
      ...completed,
      workspace: undefined,
      agentCwd: '/tmp/runs/workspaces/completion-fields',
      completion: { outcome: 'discarded', recordedAt },
    }),
    false,
  );
  assert.equal(
    isSavedRun({
      ...completed,
      workspace: undefined,
      completion: { outcome: 'discarded', recordedAt },
    }),
    true,
  );

  // 6. Nothing reached a patch, so the workspace is the only copy.
  assert.equal(
    isSavedRun({
      ...completed,
      workspace: undefined,
      completion: { outcome: 'no-changes', recordedAt },
    }),
    false,
  );
  assert.equal(
    isSavedRun({
      ...completed,
      workspace: undefined,
      completion: { outcome: 'patch-failed', recordedAt, reason: 'git failed' },
    }),
    false,
  );
});

test('rejects an oversized or unsanitized completion reason', () => {
  const completed = {
    ...makeRun('completion-reason', 'completed'),
    workspace: '/tmp/workspace',
  };
  const recordedAt = '2026-08-10T00:00:00.000Z';
  const withReason = (reason: string): unknown => ({
    ...completed,
    completion: { outcome: 'apply-failed', recordedAt, reason },
  });

  assert.equal(isSavedRun(withReason('a'.repeat(2_000))), true);
  assert.equal(isSavedRun(withReason('a'.repeat(2_001))), false);
  assert.equal(isSavedRun(withReason('git apply said \u001B[31mred')), false);
  assert.equal(isSavedRun(withReason('git apply said red')), true);
});

test('a completion survives a workspace discarded later by run management', () => {
  // Invariant 5 is one-directional: discarded implies no workspace, but an
  // absent workspace does not imply the run discarded it.
  assert.equal(
    isSavedRun({
      ...makeRun('kept-then-discarded', 'completed'),
      workspace: undefined,
      completion: {
        outcome: 'kept',
        recordedAt: '2026-08-10T00:00:00.000Z',
      },
    }),
    true,
  );
});
