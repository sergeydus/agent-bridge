import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProviderEventPresenter,
  formatAgentHeartbeat,
  formatAgentResponse,
  formatAgentStarted,
  resolvePresentation,
} from '../src/presentation.ts';

test('resolves color only for an enhanced terminal', () => {
  assert.deepEqual(
    resolvePresentation(
      { screenReader: false, noColor: false },
      { environment: {}, isTty: true },
    ),
    { screenReader: false, color: true },
  );
  assert.equal(
    resolvePresentation(
      { screenReader: false, noColor: false },
      { environment: { NO_COLOR: '' }, isTty: true },
    ).color,
    false,
  );
  assert.deepEqual(
    resolvePresentation(
      { screenReader: true, noColor: false },
      { environment: {}, isTty: true },
    ),
    { screenReader: true, color: false },
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
