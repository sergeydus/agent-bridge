import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProviderEventPresenter,
  formatAgentHeartbeat,
  formatAgentResponse,
  formatAgentStarted,
  resolveColorChoice,
  resolvePresentation,
} from '../src/presentation.ts';

test('resolves color only for an enhanced terminal', () => {
  assert.deepEqual(
    resolvePresentation(
      { screenReader: false },
      { environment: {}, isTty: true },
    ),
    { screenReader: false, color: true },
  );
  assert.equal(
    resolvePresentation(
      { screenReader: false },
      { environment: { NO_COLOR: '' }, isTty: true },
    ).color,
    false,
  );
  assert.deepEqual(
    resolvePresentation(
      { screenReader: true },
      { environment: {}, isTty: true },
    ),
    { screenReader: true, color: false },
  );
});

test('a stated color choice outranks NO_COLOR but never a non-terminal', () => {
  // Automatic detection is the last resort, so NO_COLOR loses to a real choice.
  assert.equal(
    resolvePresentation(
      { screenReader: false, color: true },
      { environment: { NO_COLOR: '' }, isTty: true },
    ).color,
    true,
  );
  assert.equal(
    resolvePresentation(
      { screenReader: false, color: false },
      { environment: {}, isTty: true },
    ).color,
    false,
  );
  // Escape sequences in a pipe would corrupt output meant for another reader.
  assert.equal(
    resolvePresentation(
      { screenReader: false, color: true },
      { environment: {}, isTty: false },
    ).color,
    false,
  );
  // Screen-reader mode outranks everything, including an explicit --color.
  assert.equal(
    resolvePresentation(
      { screenReader: true, color: true },
      { environment: {}, isTty: true },
    ).color,
    false,
  );
});

test('color precedence runs most specific layer first', () => {
  assert.equal(
    resolveColorChoice({
      explicit: true,
      savedSession: false,
      savedGlobal: false,
    }),
    true,
  );
  assert.equal(
    resolveColorChoice({ savedSession: false, savedGlobal: true }),
    false,
  );
  assert.equal(resolveColorChoice({ savedGlobal: false }), false);
  // Nothing stated: automatic detection decides.
  assert.equal(resolveColorChoice({}), undefined);
  // `false` is a real choice, not an absent one.
  assert.equal(
    resolveColorChoice({ explicit: false, savedGlobal: true }),
    false,
  );
});

test('screen-reader presentation is semantic and append-only', () => {
  const preferences = { screenReader: true, color: false };
  const output = [
    formatAgentStarted({
      agent: 'codex',
      model: 'test-model',
      preferences,
    }),
    formatAgentHeartbeat({
      agent: 'codex',
      startedAt: 0,
      now: 60_000,
      preferences,
    }),
    formatAgentResponse({
      agent: 'codex',
      decision: 'done',
      text: 'Finished safely.',
      preferences,
    }),
  ].join('');

  assert.match(output, /Codex started a read-only response/);
  assert.match(output, /Elapsed time: 1m 0s/);
  assert.match(output, /Decision: done/);
  assert.equal(output.includes('\u001B['), false);
  assert.doesNotMatch(output, /[─●✓]/);

  const confirmation = formatAgentStarted({
    agent: 'codex',
    model: 'test-model',
    phase: 'confirmation',
    preferences,
  });
  assert.match(
    confirmation,
    /Codex started a reciprocal confirmation using the model test-model/,
  );
});

test('enhanced presentation colors speakers without relying on color', () => {
  const output = formatAgentResponse({
    agent: 'claude',
    decision: 'continue',
    text: 'One concern remains.',
    preferences: { screenReader: false, color: true },
  });
  assert.equal(output.includes('\u001B['), true);
  assert.match(output, /Claude/);
  assert.match(output, /\[continue\]/);
});

test('streams labeled live text in an interactive terminal', () => {
  const presenter = createProviderEventPresenter({
    agent: 'claude',
    preferences: { screenReader: false, color: false },
    streamText: true,
  });
  const output = [
    presenter.render({ type: 'text-delta', text: 'Checking ' }),
    presenter.beforeStatus(),
    'Claude is still working.\n',
    presenter.render({ type: 'text-delta', text: 'files.' }),
    presenter.render({ type: 'text-end' }),
    presenter.render({
      type: 'activity',
      message: 'running a project command',
    }),
    presenter.finish(),
  ].join('');

  assert.match(
    output,
    /Claude · live update\nChecking \nClaude is still working\.\n\nClaude · live update\nfiles\./,
  );
  assert.match(output, /Claude · running a project command/);
});

test('buffers deltas into complete semantic screen-reader updates', () => {
  const presenter = createProviderEventPresenter({
    agent: 'codex',
    preferences: { screenReader: true, color: false },
    streamText: true,
  });

  assert.equal(presenter.render({ type: 'text-delta', text: 'Partial ' }), '');
  assert.equal(presenter.render({ type: 'text-delta', text: 'update.' }), '');
  assert.equal(presenter.beforeStatus(), '');
  const output = presenter.render({ type: 'text-end' });

  assert.match(output, /Codex progress update\.\nPartial update\./);
  assert.doesNotMatch(output, /[─●✓]/);
});

test('buffers live text when concurrent providers could interleave', () => {
  const presenter = createProviderEventPresenter({
    agent: 'claude',
    preferences: { screenReader: false, color: false },
    streamText: false,
  });

  assert.equal(presenter.render({ type: 'text-delta', text: 'One ' }), '');
  assert.equal(presenter.render({ type: 'text-delta', text: 'block.' }), '');
  assert.match(
    presenter.render({ type: 'text-end' }),
    /Claude · live update\nOne block\./,
  );
});

test('plain and screen-reader output neutralize provider terminal controls', () => {
  for (const screenReader of [false, true]) {
    const preferences = { screenReader, color: false };
    const presenter = createProviderEventPresenter({
      agent: 'codex',
      preferences,
      streamText: !screenReader,
    });
    const output = [
      formatAgentStarted({
        agent: 'codex',
        model: 'safe\u001B]0;changed-title\u0007-model',
        preferences,
      }),
      presenter.render({
        type: 'activity',
        message: 'inspect\u001B[2J-files',
      }),
      presenter.render({
        type: 'text-delta',
        text: 'answer\u001B]8;;https://example.com\u0007-link',
      }),
      presenter.render({ type: 'text-end' }),
      formatAgentResponse({
        agent: 'codex',
        text: 'done\u001B[31m-red',
        preferences,
      }),
    ].join('');

    assert.equal(output.includes('\u001B'), false);
    assert.match(output, /safe-model/);
    assert.match(output, /inspect-files/);
    assert.match(output, /answer-link/);
    assert.match(output, /done-red/);
  }
});
