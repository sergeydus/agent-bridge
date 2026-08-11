import assert from 'node:assert/strict';
import test from 'node:test';

import {
  boundedCompletionReason,
  completionFailureReason,
  completionOutcomeFailed,
  completionOutcomeRequiresReason,
  COMPLETION_OUTCOMES,
  MAX_COMPLETION_REASON_CHARS,
  deriveCurrentPairedExchangeStatus,
  deriveHistoricalPairedExchangeStatus,
  editorForRound,
  estimateCalls,
  formatDuration,
  isSafeRunId,
  isTransientAgentFailure,
  otherAgent,
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

test('only completion outcomes whose action failed change the exit code', () => {
  const failed = COMPLETION_OUTCOMES.filter(completionOutcomeFailed);

  assert.deepEqual(failed, ['apply-failed', 'discard-failed', 'patch-failed']);
  // A refusal is a decision the user saw, not a failure of the tool.
  assert.equal(completionOutcomeFailed('apply-refused'), false);
  assert.equal(completionOutcomeFailed('declined'), false);
  assert.equal(completionOutcomeFailed('no-changes'), false);
});

test('only refusals and failures may carry a reason', () => {
  assert.deepEqual(
    COMPLETION_OUTCOMES.filter(completionOutcomeRequiresReason),
    ['apply-refused', 'apply-failed', 'discard-failed', 'patch-failed'],
  );
});

test('completion reasons are bounded and safe to print', () => {
  const reason = boundedCompletionReason(
    `git said \u001B[31mred\u001B[0m ${'x'.repeat(5_000)}`,
  );

  assert.equal(reason.length, MAX_COMPLETION_REASON_CHARS);
  assert.equal(reason.includes('\u001B'), false);
  assert.match(reason, /^git said red /);
});

test('a failure reason truncates the error, never the guidance', () => {
  const guidance =
    'The patch is still at /tmp/run.patch. Retry with git apply.';
  const reason = completionFailureReason({
    summary: 'The patch could not be applied:',
    error: 'x'.repeat(5_000),
    guidance,
  });

  assert.equal(reason.length <= MAX_COMPLETION_REASON_CHARS, true);
  assert.match(reason, /^The patch could not be applied:/);
  assert.ok(reason.endsWith(guidance));
  assert.match(reason, /…/);
});

test('a short failure reason keeps the error intact', () => {
  const reason = completionFailureReason({
    summary: 'It failed:',
    error: 'permission denied',
    guidance: 'Try again.',
  });

  assert.equal(reason, 'It failed: permission denied Try again.');
});

test('run ids accepted by isSafeRunId need no shell quoting', () => {
  // Recovery messages print run ids inside a suggested command unquoted. That
  // is only safe because the accepted character set contains nothing any shell
  // splits or interprets, on POSIX or on Windows.
  for (const id of ['run-20260811-abc123', 'r', 'A.b_c-1']) {
    assert.ok(isSafeRunId(id));
    assert.ok(/^[A-Za-z0-9._-]+$/.test(id));
  }
  for (const id of ['a b', 'a;b', 'a&b', 'a|b', 'a$b', 'a"b', "a'b", '-a']) {
    assert.equal(isSafeRunId(id), false);
  }
});
