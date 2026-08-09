import assert from 'node:assert/strict';
import test from 'node:test';

import {
  boundedChatHistory,
  clip,
  interactiveChatPrompt,
  MAX_CHAT_HISTORY_CHARS,
  MAX_CONTEXT_CHARS,
  participantPrompt,
  reviewPrompt,
} from '../src/prompts.ts';
import { buildChatWorkflowTask } from '../src/chat-workflow.ts';

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

test('bounded chat history omits whole messages while preserving valid JSON', () => {
  const history = Array.from({ length: 6 }, (_, index) => ({
    sequence: index + 1,
    createdAt: '2026-07-29T00:00:00.000Z',
    role: index === 0 ? ('user' as const) : ('codex' as const),
    text: `${index}:${'x'.repeat(120)}`,
    ...(index > 0 ? { decision: 'continue' as const } : {}),
  }));
  const serialized = boundedChatHistory(history, 500);
  const parsed = JSON.parse(serialized) as Array<Record<string, unknown>>;

  assert.ok(serialized.length <= 500);
  assert.equal(parsed[0]?.sequence, 1);
  assert.equal(parsed.at(-1)?.sequence, 6);
  assert.ok(
    parsed.some(
      (entry) => entry.type === 'omitted' && entry.omittedMessages === 4,
    ),
  );
});

test('bounded chat history marks truncation of one oversized recent message', () => {
  const serialized = boundedChatHistory(
    [
      {
        sequence: 1,
        createdAt: '2026-07-29T00:00:00.000Z',
        role: 'user',
        text: `START${'x'.repeat(1_000)}END`,
      },
    ],
    500,
  );
  const [message] = JSON.parse(serialized) as Array<Record<string, unknown>>;

  assert.ok(serialized.length <= 500);
  assert.match(String(message?.text), /^START/);
  assert.match(String(message?.text), /characters omitted/);
  assert.match(String(message?.text), /END$/);
  assert.equal(typeof message?.truncatedCharacters, 'number');
});

test('bounded chat history rejects limits too small for its metadata', () => {
  const history = [
    {
      sequence: 1,
      createdAt: '2026-07-29T00:00:00.000Z',
      role: 'user' as const,
      text: 'x'.repeat(1_000),
    },
  ];

  assert.throws(() => boundedChatHistory(history, 199), /at least 200/);
  assert.doesNotThrow(() => boundedChatHistory(history, 200));
});

test('chat prompt and workflow handoff contain parseable bounded history', () => {
  const messages = Array.from({ length: 5 }, (_, index) => ({
    sequence: index + 1,
    createdAt: '2026-07-29T00:00:00.000Z',
    role: index % 2 === 0 ? ('user' as const) : ('claude' as const),
    text: `${index}:${'x'.repeat(MAX_CHAT_HISTORY_CHARS / 2)}`,
    ...(index % 2 === 1 ? { decision: 'continue' as const } : {}),
  }));
  const prompt = interactiveChatPrompt({
    agent: 'codex',
    history: messages,
    projectInstructions: '',
  });
  const promptPayload = /bounded conversation history:\n([^\n]+)/.exec(
    prompt,
  )?.[1];
  assert.ok(promptPayload);
  assert.doesNotThrow(() => JSON.parse(JSON.parse(promptPayload) as string));
  assert.match(prompt, /type "omitted" reports how many complete messages/);
  assert.match(prompt, /type "omitted" entry is bookkeeping/);
  assert.match(
    prompt,
    /truncatedCharacters is a real participant message[\s\S]+shortened/,
  );

  const workflowTask = buildChatWorkflowTask(
    {
      version: 3,
      id: 'chat-history-test',
      projectRoot: '/tmp/project',
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z',
      status: 'active',
      projectKind: 'git',
      maxAutoRounds: 6,
      maxWorkflowRounds: 4,
      retries: 1,
      timeoutMinutes: 15,
      noTranscript: false,
      ui: 'plain',
      nextFirstAgent: 'codex',
      messages,
      workflows: [],
    },
    'review',
  );
  const workflowPayload =
    /resolve later messages over earlier ones:\n\n([^\n]+)/.exec(
      workflowTask,
    )?.[1];
  assert.ok(workflowPayload);
  assert.doesNotThrow(() => JSON.parse(JSON.parse(workflowPayload) as string));
  assert.match(
    workflowTask,
    /type "omitted" reports how many complete messages/,
  );
  assert.match(workflowTask, /type "omitted" entry is bookkeeping/);
  assert.match(
    workflowTask,
    /truncatedCharacters is a real participant message[\s\S]+shortened/,
  );
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
