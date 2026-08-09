import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveCurrentPairedExchangeStatus,
  deriveHistoricalPairedExchangeStatus,
  editorForRound,
  estimateCalls,
  formatDuration,
  isSafeRunId,
  isTransientAgentFailure,
  otherAgent,
  legacyDecision,
  summarizePorcelainStatus,
  type PairedExchangeMessage,
} from '../src/core.ts';

function exchangeMessage(
  sequence: number,
  role: PairedExchangeMessage['role'],
  decision?: PairedExchangeMessage['decision'],
): PairedExchangeMessage {
  return {
    sequence,
    role,
    ...(decision === undefined ? {} : { decision }),
  };
}

test('alternates collaborative editors deterministically', () => {
  assert.equal(editorForRound('claude', 1), 'claude');
  assert.equal(editorForRound('claude', 2), 'codex');
  assert.equal(editorForRound('claude', 3), 'claude');
  assert.equal(otherAgent('codex'), 'claude');
  assert.throws(() => editorForRound('codex', 0));
});

test('derives pending and legacy paired exchange state deterministically', () => {
  const codex = exchangeMessage(2, 'codex', 'done');
  const claude = exchangeMessage(3, 'claude', 'done');

  assert.equal(
    deriveCurrentPairedExchangeStatus({
      messages: [codex],
      pendingStage: 'awaiting-peer',
    }),
    'pending-peer',
  );
  assert.equal(
    deriveCurrentPairedExchangeStatus({
      messages: [codex, claude],
      pendingStage: 'awaiting-confirmation',
    }),
    'pending-confirmation',
  );
  assert.equal(
    deriveCurrentPairedExchangeStatus({ messages: [codex, claude] }),
    'both-done',
  );
  assert.equal(
    deriveCurrentPairedExchangeStatus({
      messages: [codex, { ...claude, decision: 'continue' }],
    }),
    'open',
  );
  assert.equal(
    deriveCurrentPairedExchangeStatus({
      messages: [exchangeMessage(1, 'user'), codex],
    }),
    'none',
  );
});

test('separates current exchange state from historical paired evidence', () => {
  const recorded = {
    firstMessageSequence: 2,
    secondMessageSequence: 3,
    confirmationMessageSequence: 4,
    outcome: 'confirmed' as const,
  };
  const confirmedMessages = [
    exchangeMessage(1, 'user'),
    exchangeMessage(2, 'codex', 'done'),
    exchangeMessage(3, 'claude', 'done'),
    exchangeMessage(4, 'codex', 'done'),
  ];

  assert.equal(
    deriveCurrentPairedExchangeStatus({
      messages: confirmedMessages,
      latestExchange: recorded,
    }),
    'confirmed',
  );
  for (const role of ['user', 'system', 'claude'] as const) {
    const messages = [...confirmedMessages, exchangeMessage(5, role)];
    assert.equal(
      deriveCurrentPairedExchangeStatus({
        messages,
        latestExchange: recorded,
      }),
      'none',
      `${role} opens a new current conversational context`,
    );
    assert.equal(
      deriveHistoricalPairedExchangeStatus({
        messages,
        latestExchange: recorded,
      }),
      'confirmed',
      `${role} does not erase historical paired evidence`,
    );
  }
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
