import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ClaudeEventStream,
  CodexEventStream,
  type ProviderEvent,
} from '../src/provider-events.ts';

function pushInPieces(
  stream: { push(chunk: string): void },
  content: string,
  pieceSize: number,
): void {
  for (let index = 0; index < content.length; index += pieceSize) {
    stream.push(content.slice(index, index + pieceSize));
  }
}

test('normalizes Codex JSONL without exposing reasoning or the final response', () => {
  const events: ProviderEvent[] = [];
  const stream = new CodexEventStream('turn', (event) => events.push(event));
  const lines = [
    { type: 'thread.started', thread_id: 'thread-1' },
    {
      type: 'item.completed',
      item: { type: 'reasoning', text: 'private chain of thought' },
    },
    {
      type: 'item.started',
      item: {
        type: 'command_execution',
        command: 'print-a-secret',
        status: 'in_progress',
      },
    },
    {
      type: 'item.updated',
      item: {
        type: 'command_execution',
        command: 'print-a-secret',
        status: 'in_progress',
      },
    },
    {
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: JSON.stringify({
          decision: 'continue',
          text: 'I found the relevant module.',
        }),
      },
    },
    {
      type: 'item.completed',
      item: {
        type: 'file_change',
        changes: [{ path: '/private/project/file.ts' }],
        status: 'completed',
      },
    },
    {
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: JSON.stringify({
          decision: 'done',
          text: 'Authoritative final answer.',
        }),
      },
    },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 12,
        cached_input_tokens: 3,
        output_tokens: 7,
      },
    },
  ];

  pushInPieces(
    stream,
    `${lines.map((line) => JSON.stringify(line)).join('\r\n')}\r\n`,
    11,
  );
  stream.finish();

  assert.deepEqual(events, [
    { type: 'activity', message: 'running a project command' },
    { type: 'activity', message: 'updated project files' },
    {
      type: 'text-completed',
      text: 'I found the relevant module.',
    },
    {
      type: 'usage',
      inputTokens: 12,
      cachedInputTokens: 3,
      outputTokens: 7,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /private chain|print-a-secret/);
  assert.doesNotMatch(JSON.stringify(events), /Authoritative final answer/);
  assert.doesNotMatch(JSON.stringify(events), /private\/project/);
});

test('normalizes Claude stream-json and returns only the final result', () => {
  const events: ProviderEvent[] = [];
  const stream = new ClaudeEventStream('turn', (event) => events.push(event));
  const lines = [
    { type: 'system', subtype: 'init' },
    {
      type: 'stream_event',
      event: { type: 'message_start', message: {} },
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'private reasoning' },
      },
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Inspecting ' },
      },
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'the project.' },
      },
    },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Inspecting the project.' }],
      },
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: {
          type: 'tool_use',
          name: 'StructuredOutput',
          input: { decision: 'done' },
        },
      },
    },
    {
      type: 'stream_event',
      event: { type: 'message_stop' },
    },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Inspecting the project.' }],
      },
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        content_block: {
          type: 'tool_use',
          name: 'Read',
          input: { file_path: '/private/project/secret.ts' },
        },
      },
    },
    {
      type: 'result',
      subtype: 'success',
      structured_output: {
        decision: 'done',
        text: 'Authoritative final answer.',
      },
      usage: {
        input_tokens: 20,
        cache_read_input_tokens: 4,
        output_tokens: 9,
      },
    },
  ];

  pushInPieces(
    stream,
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    7,
  );
  const result = stream.finish();

  assert.deepEqual(result, {
    decision: 'done',
    text: 'Authoritative final answer.',
  });
  assert.deepEqual(events, [
    { type: 'text-delta', text: 'Inspecting ' },
    { type: 'text-delta', text: 'the project.' },
    { type: 'text-end' },
    { type: 'activity', message: 'reading project files' },
    {
      type: 'usage',
      inputTokens: 20,
      cachedInputTokens: 4,
      outputTokens: 9,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /private reasoning|secret\.ts/);
});

test('uses a complete Claude assistant message when partial events are absent', () => {
  const events: ProviderEvent[] = [];
  const stream = new ClaudeEventStream('synthesis', (event) =>
    events.push(event),
  );
  stream.push(
    [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Visible progress.' }],
        },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_start', message: {} },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        structured_output: { text: 'Final synthesis.' },
      }),
      '',
    ].join('\n'),
  );

  assert.deepEqual(stream.finish(), { text: 'Final synthesis.' });
  assert.deepEqual(events[0], {
    type: 'text-completed',
    text: 'Visible progress.',
  });
});

test('does not duplicate a trailing Claude assistant message and final result', () => {
  const events: ProviderEvent[] = [];
  const stream = new ClaudeEventStream('synthesis', (event) =>
    events.push(event),
  );
  stream.push(
    [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Final synthesis.' }],
        },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        structured_output: { text: 'Final synthesis.' },
      }),
      '',
    ].join('\n'),
  );

  assert.deepEqual(stream.finish(), { text: 'Final synthesis.' });
  assert.deepEqual(events, []);
});

test('rejects malformed or incomplete provider event streams', () => {
  const malformed = new CodexEventStream('turn');
  assert.throws(() => malformed.push('{"type":\n'), /malformed JSONL/);

  const incomplete = new ClaudeEventStream('turn');
  incomplete.push(`${JSON.stringify({ type: 'system', subtype: 'init' })}\n`);
  assert.throws(() => incomplete.finish(), /without a final result/);

  const failed = new ClaudeEventStream('turn');
  failed.push(
    `${JSON.stringify({ type: 'result', subtype: 'error_max_turns' })}\n`,
  );
  assert.throws(() => failed.finish(), /error_max_turns/);

  const codexFailure = new CodexEventStream('turn');
  codexFailure.push(
    `${JSON.stringify({
      type: 'turn.failed',
      error: { message: 'provider unavailable' },
    })}\n`,
  );
  assert.throws(() => codexFailure.finish(), /provider unavailable/);
});

test('rejects an oversized JSONL event even when its newline is present', () => {
  const stream = new CodexEventStream('turn');
  assert.throws(
    () => stream.push(`${'x'.repeat(2_000_001)}\n`),
    /exceeded 2000000 characters/,
  );
});
