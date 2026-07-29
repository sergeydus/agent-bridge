import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
