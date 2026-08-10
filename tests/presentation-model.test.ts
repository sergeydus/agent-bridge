import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_PRESENTED_LIVE_TEXT_CHARS,
  MAX_PRESENTED_MESSAGES,
  createTerminalViewModel,
  reducePresentationModel,
  type PresentedMessage,
} from '../src/presentation-model.ts';
import {
  createProviderEventPresenter,
  createPlainTerminalRenderer,
  formatAgentHeartbeat,
  formatAgentResponse,
  formatAgentStarted,
  PresentationController,
  type TerminalRenderer,
} from '../src/presentation.ts';

function message(sequence: number): PresentedMessage {
  return {
    sequence,
    createdAt: new Date(sequence * 1000).toISOString(),
    role: 'user',
    text: `Message ${sequence}`,
  };
}

function initialModel(messages: readonly PresentedMessage[] = []) {
  return createTerminalViewModel({
    session: {
      id: 'chat-test',
      projectLabel: 'example-project',
      status: 'active',
    },
    messages,
  });
}

test('creates a bounded renderer-neutral view of persisted chat state', () => {
  const messages = Array.from(
    { length: MAX_PRESENTED_MESSAGES + 5 },
    (_, index) => message(index + 1),
  );
  const model = initialModel(messages);

  assert.equal(model.messages.length, MAX_PRESENTED_MESSAGES);
  assert.equal(model.messages[0]?.sequence, 6);
  assert.equal(model.messages.at(-1)?.sequence, MAX_PRESENTED_MESSAGES + 5);
  assert.deepEqual(model.session, {
    id: 'chat-test',
    projectLabel: 'example-project',
    status: 'active',
  });
  assert.equal(model.activity, undefined);
  assert.equal(model.exchangeStatus, 'none');
  assert.equal(model.queuedInputCount, 0);
});

test('reduces and announces paired exchange status without claiming agreement', () => {
  const output: string[] = [];
  const controller = new PresentationController({
    initialModel: initialModel(),
    renderer: createPlainTerminalRenderer({
      screenReader: true,
      color: false,
    }),
    write: (text) => output.push(text),
  });

  controller.dispatch({ type: 'exchange-status', status: 'pending-peer' });
  controller.dispatch({
    type: 'exchange-status',
    status: 'pending-confirmation',
  });
  controller.dispatch({ type: 'exchange-status', status: 'both-done' });
  controller.dispatch({ type: 'exchange-status', status: 'confirmed' });
  controller.dispatch({ type: 'exchange-status', status: 'abandoned' });

  assert.equal(controller.model.exchangeStatus, 'abandoned');
  assert.match(output.join(''), /waiting for peer response/);
  assert.match(output.join(''), /waiting for reciprocal confirmation/);
  assert.match(
    output.join(''),
    /both agents marked the legacy pair done; not reciprocally confirmed/,
  );
  assert.match(
    output.join(''),
    /both agents reciprocally marked this exchange done/,
  );
  assert.match(
    output.join(''),
    /exchange left unfinished when the session was completed/,
  );
  assert.doesNotMatch(output.join(''), /verified/i);
});

test('reduces and announces only queued input counts', () => {
  const output: string[] = [];
  const controller = new PresentationController({
    initialModel: initialModel(),
    renderer: createPlainTerminalRenderer({
      screenReader: true,
      color: false,
    }),
    write: (text) => output.push(text),
  });

  controller.dispatch({ type: 'queued-input', count: 2 });
  controller.dispatch({ type: 'queued-input', count: 0 });

  assert.equal(controller.model.queuedInputCount, 0);
  assert.match(output.join(''), /2 lines will be handled at the next prompt/);
});

test('reduces safe provider activity without making it authoritative', () => {
  let model = initialModel([message(1)]);
  model = reducePresentationModel(model, {
    type: 'agent-started',
    agent: 'codex',
    model: 'test-model',
    startedAt: 1_000,
  });
  model = reducePresentationModel(model, {
    type: 'provider-event',
    agent: 'codex',
    event: { type: 'activity', message: 'searching the project' },
  });
  model = reducePresentationModel(model, {
    type: 'provider-event',
    agent: 'codex',
    event: {
      type: 'text-delta',
      text: `oldest-${'x'.repeat(MAX_PRESENTED_LIVE_TEXT_CHARS)}-newest`,
    },
  });
  model = reducePresentationModel(model, {
    type: 'agent-heartbeat',
    agent: 'codex',
    now: 61_000,
  });
  model = reducePresentationModel(model, {
    type: 'agent-tick',
    agent: 'codex',
    now: 61_250,
  });
  model = reducePresentationModel(model, {
    type: 'provider-event',
    agent: 'codex',
    event: {
      type: 'usage',
      inputTokens: 12,
      cachedInputTokens: 5,
      outputTokens: 7,
    },
  });

  assert.equal(model.messages.length, 1);
  assert.equal(model.activity?.agent, 'codex');
  assert.equal(model.activity?.model, 'test-model');
  assert.equal(model.activity?.message, 'searching the project');
  assert.equal(model.activity?.liveText.length, MAX_PRESENTED_LIVE_TEXT_CHARS);
  assert.equal(model.activity?.liveTextTruncated, true);
  assert.equal(model.activity?.liveText.startsWith('oldest-'), false);
  assert.equal(model.activity?.liveText.endsWith('-newest'), true);
  assert.equal(model.activity?.observedAt, 61_250);
  assert.deepEqual(model.activity?.usage, {
    inputTokens: 12,
    cachedInputTokens: 5,
    outputTokens: 7,
  });

  model = reducePresentationModel(model, {
    type: 'agent-retry',
    agent: 'codex',
    attempt: 1,
    retryLimit: 2,
  });
  assert.equal(model.activity?.state, 'retrying');
  assert.equal(model.activity?.retryAttempt, 1);
  assert.equal(model.activity?.retryLimit, 2);
  assert.equal(model.activity?.liveText, '');
  assert.equal(model.activity?.message, undefined);

  model = reducePresentationModel(model, {
    type: 'provider-event',
    agent: 'codex',
    event: { type: 'text-end' },
  });
  assert.equal(model.activity?.state, 'working');
  assert.equal(model.activity?.liveTextComplete, true);

  model = reducePresentationModel(model, {
    type: 'agent-response',
    agent: 'codex',
    message: {
      sequence: 2,
      createdAt: new Date(2_000).toISOString(),
      role: 'codex',
      text: 'Authoritative final response.',
      decision: 'done',
    },
  });
  assert.equal(model.activity, undefined);
  assert.deepEqual(model.lastUsage, {
    inputTokens: 12,
    cachedInputTokens: 5,
    outputTokens: 7,
  });
  assert.equal(model.messages.length, 2);
  assert.equal(model.messages.at(-1)?.decision, 'done');

  model = reducePresentationModel(model, {
    type: 'session-status',
    status: 'completed',
  });
  assert.equal(model.session.status, 'completed');
});

test('controller preserves plain streaming output while updating the model', () => {
  const output: string[] = [];
  const preferences = {
    screenReader: false,
    color: false,
  };
  const controller = new PresentationController({
    initialModel: initialModel(),
    renderer: createPlainTerminalRenderer(preferences),
    write: (text) => output.push(text),
  });

  controller.dispatch({
    type: 'agent-started',
    agent: 'claude',
    model: 'test-model',
    startedAt: 0,
  });
  controller.dispatch({
    type: 'provider-event',
    agent: 'claude',
    event: { type: 'text-delta', text: 'Checking files.' },
  });
  controller.dispatch({
    type: 'agent-heartbeat',
    agent: 'claude',
    now: 60_000,
  });
  controller.dispatch({
    type: 'agent-tick',
    agent: 'claude',
    now: 60_250,
  });
  controller.dispatch({
    type: 'provider-event',
    agent: 'claude',
    event: { type: 'activity', message: 'searching the project' },
  });
  controller.dispatch({ type: 'agent-stream-finished', agent: 'claude' });
  controller.dispatch({
    type: 'agent-response',
    agent: 'claude',
    message: {
      sequence: 1,
      createdAt: new Date(60_000).toISOString(),
      role: 'claude',
      text: 'Finished safely.',
      decision: 'done',
    },
  });

  const rendered = output.join('');
  const legacyStream = createProviderEventPresenter({
    agent: 'claude',
    preferences,
    streamText: true,
  });
  const expected = [
    formatAgentStarted({
      agent: 'claude',
      model: 'test-model',
      preferences,
    }),
    legacyStream.render({
      type: 'text-delta',
      text: 'Checking files.',
    }),
    legacyStream.beforeStatus(),
    formatAgentHeartbeat({
      agent: 'claude',
      startedAt: 0,
      now: 60_000,
      preferences,
    }),
    legacyStream.render({
      type: 'activity',
      message: 'searching the project',
    }),
    legacyStream.finish(),
    formatAgentResponse({
      agent: 'claude',
      decision: 'done',
      text: 'Finished safely.',
      preferences,
    }),
  ].join('');
  assert.equal(rendered, expected);
  assert.match(rendered, /Claude · model test-model · thinking/);
  assert.match(rendered, /Claude · live update\nChecking files\./);
  assert.match(rendered, /Claude is still working · 1m 0s/);
  assert.match(rendered, /Claude · searching the project/);
  assert.match(rendered, /Claude \[done\]\n/);
  assert.equal(controller.model.activity, undefined);
  assert.equal(controller.model.messages[0]?.text, 'Finished safely.');
});

test('controller restores the terminal and continues with the plain renderer after an enhanced rendering failure', () => {
  const output: string[] = [];
  let stopCalls = 0;
  const failingRenderer: TerminalRenderer = {
    start: () => '<enter-enhanced>',
    render: () => {
      throw new Error('layout failed');
    },
    redraw: () => '',
    suspend: () => '',
    resume: () => '',
    stop: () => {
      stopCalls += 1;
      return '<leave-enhanced>';
    },
  };
  const preferences = { screenReader: false, color: false };
  const controller = new PresentationController({
    initialModel: initialModel(),
    renderer: failingRenderer,
    fallback: {
      renderer: createPlainTerminalRenderer(preferences),
      notice: '\nEnhanced terminal failed. Continuing in plain mode.\n',
    },
    write: (text) => output.push(text),
  });

  assert.equal(controller.started, false);
  assert.equal(controller.suspended, false);
  controller.start();
  assert.equal(controller.started, true);
  controller.suspend();
  assert.equal(controller.suspended, true);
  controller.resume();
  assert.equal(controller.suspended, false);
  controller.dispatch({
    type: 'agent-started',
    agent: 'codex',
    model: 'test-model',
    startedAt: 0,
  });
  controller.dispatch({
    type: 'agent-response',
    agent: 'codex',
    message: {
      sequence: 1,
      createdAt: new Date(1_000).toISOString(),
      role: 'codex',
      text: 'Recovered response.',
      decision: 'done',
    },
  });

  assert.equal(controller.usingFallback, true);
  assert.equal(stopCalls, 1);
  assert.equal(output[0], '<enter-enhanced>');
  assert.match(
    output.join(''),
    /<leave-enhanced>\nEnhanced terminal failed\. Continuing in plain mode\./,
  );
  assert.match(output.join(''), /Codex · model test-model · thinking/);
  assert.match(output.join(''), /Recovered response\./);
  controller.stop();
  assert.equal(controller.started, false);
  assert.equal(controller.suspended, false);
});

test('controller treats failed terminal restoration as fatal', () => {
  const renderError = new Error('layout failed');
  const restorationError = new Error('restoration failed');
  const renderer: TerminalRenderer = {
    start: () => '',
    render: () => {
      throw renderError;
    },
    redraw: () => '',
    suspend: () => '',
    resume: () => '',
    stop: () => {
      throw restorationError;
    },
  };
  const controller = new PresentationController({
    initialModel: initialModel(),
    renderer,
    fallback: {
      renderer: createPlainTerminalRenderer({
        screenReader: false,
        color: false,
      }),
      notice: 'fallback',
    },
    write: () => {},
  });

  assert.throws(
    () =>
      controller.dispatch({
        type: 'agent-started',
        agent: 'codex',
        startedAt: 0,
      }),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === renderError &&
      error.errors[1] === restorationError,
  );
  assert.equal(controller.usingFallback, false);
});
