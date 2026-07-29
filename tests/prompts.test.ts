import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clip,
  interactiveChatPrompt,
  MAX_CONTEXT_CHARS,
  participantPrompt,
  reviewPrompt,
} from '../src/prompts.ts';

test('clips oversized evidence while preserving both ends', () => {
  const value = `START${'x'.repeat(MAX_CONTEXT_CHARS)}END`;
  const result = clip(value);
  assert.match(result, /^START/);
  assert.match(result, /middle truncated/);
  assert.match(result, /END$/);
  assert.equal(result.length, MAX_CONTEXT_CHARS);
  assert.throws(() => clip(value, 20), /at least 100/);
});

test('interactive chat prompt preserves role, history, and read-only scope', () => {
  const prompt = interactiveChatPrompt({
    agent: 'claude',
    history: [
      {
        sequence: 1,
        createdAt: '2026-07-29T00:00:00.000Z',
        role: 'user',
        text: 'Explain this module',
      },
    ],
    projectInstructions: 'Keep changes small',
    currentPeerResponse: {
      sequence: 2,
      createdAt: '2026-07-29T00:00:01.000Z',
      role: 'codex',
      text: 'Initial analysis',
      decision: 'continue',
    },
  });
  assert.match(prompt, /persistent, human-guided/);
  assert.match(prompt, /read-only/);
  assert.match(prompt, /Explain this module/);
  assert.match(prompt, /Initial analysis/);
});

test('discussion and review prompts carry explicit convergence contracts', () => {
  const discussion = participantPrompt({
    agent: 'codex',
    task: 'Review the change',
    round: 2,
    ownPrevious: 'own',
    peerPrevious: 'peer',
    untilAgreement: true,
  });
  assert.match(discussion, /Claude's latest answer/);
  assert.match(discussion, /decision to "done"/);

  const review = reviewPrompt({
    agent: 'claude',
    task: 'Implement it',
    round: 1,
    implementerAnswer: 'Changed one file',
    snapshot: 'diff --git',
  });
  assert.match(review, /read-only reviewer/);
  assert.match(review, /diff --git/);
});
