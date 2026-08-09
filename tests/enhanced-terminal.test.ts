import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createEnhancedTerminalRenderer,
  printableWidth,
  renderEnhancedFrame,
  sanitizeTerminalText,
} from '../src/enhanced-terminal.ts';
import {
  createTerminalViewModel,
  reducePresentationModel,
} from '../src/presentation-model.ts';

function viewModel() {
  let model = createTerminalViewModel({
    session: {
      id: 'chat-20260729-abcdef12',
      projectLabel: 'sample-project',
      status: 'active',
    },
    messages: [
      {
        sequence: 1,
        createdAt: new Date(0).toISOString(),
        role: 'user',
        text: 'Review the responsive interface.',
      },
      {
        sequence: 2,
        createdAt: new Date(1000).toISOString(),
        role: 'codex',
        text: 'The first review is complete.',
        decision: 'continue',
      },
    ],
  });
  model = reducePresentationModel(model, {
    type: 'agent-started',
    agent: 'claude',
    model: 'test-model',
    startedAt: 0,
  });
  model = reducePresentationModel(model, {
    type: 'provider-event',
    agent: 'claude',
    event: { type: 'activity', message: 'searching the project' },
  });
  model = reducePresentationModel(model, {
    type: 'provider-event',
    agent: 'claude',
    event: { type: 'text-delta', text: 'Checking narrow layouts.' },
  });
  model = reducePresentationModel(model, {
    type: 'provider-event',
    agent: 'claude',
    event: {
      type: 'usage',
      inputTokens: 12_345,
      cachedInputTokens: 4_567,
      outputTokens: 789,
    },
  });
  model = reducePresentationModel(model, {
    type: 'agent-heartbeat',
    agent: 'claude',
    now: 60_000,
  });
  return model;
}

function visibleLines(frame: string): string[] {
  const clearAndHome = '\u001B[2J\u001B[H';
  const visible = frame.startsWith(clearAndHome)
    ? frame.slice(clearAndHome.length)
    : frame;
  return visible.replace(/\n$/, '').split('\n');
}

test('measures graphemes and neutralizes untrusted terminal controls', () => {
  assert.equal(printableWidth('a界👨‍👩‍👧‍👦e\u0301'), 6);
  assert.equal(printableWidth('1️⃣'), 2);
  assert.equal(
    sanitizeTerminalText(
      'safe\u001B[31mred\u001B[0m\u001B]8;;https://example.com\u0007link\u001B]8;;\u0007\u202Ereversed\u2066isolated\u2069',
    ),
    'saferedlinkreversedisolated',
  );
});

test('renders compact, stacked, and wide frames within terminal bounds', () => {
  const model = viewModel();
  for (const dimensions of [
    { columns: 40, rows: 10 },
    { columns: 80, rows: 20 },
    { columns: 120, rows: 24 },
    { columns: 10, rows: 3 },
  ]) {
    const lines = visibleLines(renderEnhancedFrame(model, dimensions));
    assert.ok(lines.length <= dimensions.rows - 1);
    assert.ok(
      lines.every((line) => printableWidth(line) <= dimensions.columns),
    );
    assert.match(lines.join('\n'), /Agent Brid/);
    assert.match(lines.join('\n'), /Claude/);
  }

  assert.doesNotMatch(
    renderEnhancedFrame(model, { columns: 40, rows: 10 }),
    /│/,
  );
  assert.match(
    renderEnhancedFrame(model, { columns: 80, rows: 20 }),
    /Conversation[\s\S]+Activity/,
  );
  assert.match(
    renderEnhancedFrame(model, { columns: 120, rows: 24 }),
    /Conversation\s+│ Activity/,
  );
});

test('enhanced empty state explains discussion and editing commands', () => {
  const model = createTerminalViewModel({
    session: {
      id: 'chat-20260729-empty',
      projectLabel: 'sample-project',
      status: 'active',
    },
    messages: [],
  });
  const frame = renderEnhancedFrame(model, { columns: 100, rows: 20 });

  assert.match(frame, /Type a message to discuss; files stay unchanged/);
  assert.match(frame, /Make safe changes: \/edit/);
  assert.match(frame, /Advanced roles: \/implement or \/collaborate/);
  assert.match(frame, /Ready · read-only chat · \/edit changes/);
});

test('enhanced status shows animated progress, model, usage, and safety mode', () => {
  const first = renderEnhancedFrame(viewModel(), { columns: 160, rows: 24 });
  const nextModel = reducePresentationModel(viewModel(), {
    type: 'agent-tick',
    agent: 'claude',
    now: 60_250,
  });
  const next = renderEnhancedFrame(nextModel, { columns: 160, rows: 24 });

  assert.match(first, /⠋ Claude/);
  assert.match(next, /⠙ Claude/);
  assert.match(next, /test-model/);
  assert.match(next, /in 12k \/ cached 4\.6k \/ out 789/);
  assert.match(next, /read-only/);

  const completed = reducePresentationModel(nextModel, {
    type: 'agent-response',
    agent: 'claude',
    message: {
      sequence: 3,
      createdAt: new Date(61_000).toISOString(),
      role: 'claude',
      text: 'Final response.',
      decision: 'done',
    },
  });
  const pairedDone = reducePresentationModel(completed, {
    type: 'exchange-status',
    status: 'both-done',
  });
  const queued = reducePresentationModel(pairedDone, {
    type: 'queued-input',
    count: 2,
  });
  assert.match(
    renderEnhancedFrame(queued, { columns: 160, rows: 24 }),
    /Ready · read-only chat · 2 queued · pair both done · last in 12k \/ cached 4\.6k \/ out 789/,
  );
});

test('enhanced live conversation follows the newest response text', () => {
  let model = createTerminalViewModel({
    session: {
      id: 'chat-20260729-streaming',
      projectLabel: 'sample-project',
      status: 'active',
    },
    messages: [],
  });
  model = reducePresentationModel(model, {
    type: 'agent-started',
    agent: 'codex',
    startedAt: 0,
  });
  model = reducePresentationModel(model, {
    type: 'provider-event',
    agent: 'codex',
    event: {
      type: 'text-delta',
      text: [
        'oldest-marker',
        ...Array.from({ length: 100 }, (_, index) => `middle-${index}`),
        'newest-marker',
      ].join('\n'),
    },
  });

  const frame = renderEnhancedFrame(model, { columns: 80, rows: 20 });

  assert.match(frame, /Codex \[Live\]/);
  assert.match(frame, /newest-marker/);
  assert.doesNotMatch(frame, /oldest-marker/);
  assert.match(frame, /…/);
});

test('enhanced renderer owns and restores only presentation state', () => {
  const model = viewModel();
  let now = 0;
  const renderer = createEnhancedTerminalRenderer({
    dimensions: () => ({ columns: 80, rows: 20 }),
    now: () => now,
  });

  assert.equal(
    renderer.start(model).startsWith('\u001B[?1049h\u001B[2J'),
    true,
  );
  assert.equal(renderer.start(model), '');
  const textDelta = {
    type: 'provider-event',
    agent: 'claude',
    event: { type: 'text-delta', text: 'next chunk' },
  } as const;
  assert.equal(renderer.render(textDelta, model).startsWith('\u001B[H'), true);
  now = 20;
  assert.equal(renderer.render(textDelta, model), '');
  now = 50;
  assert.equal(renderer.render(textDelta, model).startsWith('\u001B[H'), true);
  assert.equal(
    renderer
      .render(
        {
          type: 'provider-event',
          agent: 'claude',
          event: { type: 'text-end' },
        },
        model,
      )
      .startsWith('\u001B[H'),
    true,
  );
  assert.equal(renderer.redraw(model).startsWith('\u001B[2J'), true);
  assert.equal(renderer.suspend(), '\u001B[?1049l');
  assert.equal(renderer.suspend(), '');
  assert.equal(renderer.redraw(model), '');
  assert.equal(
    renderer.resume(model).startsWith('\u001B[?1049h\u001B[2J'),
    true,
  );
  assert.equal(renderer.resume(model), '');
  assert.equal(renderer.stop(), '\u001B[?1049l');
  assert.equal(renderer.stop(), '');
});
