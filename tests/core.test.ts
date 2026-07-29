import assert from 'node:assert/strict';
import test from 'node:test';

import {
  editorForRound,
  estimateCalls,
  formatDuration,
  isSafeRunId,
  isTransientAgentFailure,
  otherAgent,
  legacyDecision,
  summarizePorcelainStatus,
} from '../src/core.ts';

test('alternates collaborative editors deterministically', () => {
  assert.equal(editorForRound('claude', 1), 'claude');
  assert.equal(editorForRound('claude', 2), 'codex');
  assert.equal(editorForRound('claude', 3), 'claude');
  assert.equal(otherAgent('codex'), 'claude');
  assert.throws(() => editorForRound('codex', 0));
});

test('migrates only one unambiguous legacy status tag', () => {
  assert.equal(legacyDecision('Looks done'), null);
  assert.equal(legacyDecision('<status>CONTINUE</status>'), 'continue');
  assert.equal(legacyDecision('Result\n<status>DONE</status>'), 'done');
  assert.equal(
    legacyDecision(
      'Peer said <status>DONE</status>\n<status>CONTINUE</status>',
    ),
    null,
  );
  assert.equal(legacyDecision('Result\n<status>CONTINUE</status>'), 'continue');
});

test('estimates the maximum subscription calls', () => {
  assert.deepEqual(
    estimateCalls({
      kind: 'collaborative',
      firstAgent: 'claude',
      maxRounds: 6,
    }),
    {
      minimum: 7,
      maximum: 17,
      description:
        'Four planning calls, two calls per implementation cycle, and one synthesis call.',
    },
  );
});

test('summarizes porcelain status without losing paths', () => {
  const summary = summarizePorcelainStatus(
    [' M src/a.ts', 'M  src/b.ts', '?? src/new file.ts'].join('\n'),
  );
  assert.deepEqual(summary, {
    files: ['src/a.ts', 'src/b.ts', 'src/new file.ts'],
    stagedFiles: 1,
    modifiedFiles: 1,
    untrackedFiles: 1,
  });
});

test('formats durations and validates run ids', () => {
  assert.equal(formatDuration(5_000), '5s');
  assert.equal(formatDuration(65_000), '1m 5s');
  assert.equal(isSafeRunId('2026-07-29T12-00-00-000Z-a1b2c3d4'), true);
  assert.equal(isSafeRunId('../escape'), false);
});

test('retries only failures that look transient', () => {
  assert.equal(isTransientAgentFailure(new Error('503 overloaded')), true);
  assert.equal(
    isTransientAgentFailure(new Error('authentication failed')),
    false,
  );
});
