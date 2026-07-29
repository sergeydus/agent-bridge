import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectTerminalCapabilities,
  resolveUiMode,
  type TerminalCapabilities,
} from '../src/terminal-capabilities.ts';

const supported: TerminalCapabilities = {
  stdinIsTty: true,
  stdoutIsTty: true,
  term: 'xterm-256color',
  columns: 100,
  rows: 30,
};

test('resolves explicit and automatic UI modes conservatively', () => {
  assert.deepEqual(
    resolveUiMode({ requested: 'plain', screenReader: false }, supported),
    { mode: 'plain' },
  );
  assert.deepEqual(
    resolveUiMode({ requested: 'enhanced', screenReader: false }, supported),
    { mode: 'enhanced' },
  );
  assert.deepEqual(
    resolveUiMode({ requested: 'auto', screenReader: false }, supported),
    { mode: 'enhanced' },
  );

  const redirected = {
    ...supported,
    stdoutIsTty: false,
  };
  assert.match(
    resolveUiMode({ requested: 'enhanced', screenReader: false }, redirected)
      .notice ?? '',
    /input and output must both be interactive/,
  );
  assert.deepEqual(
    resolveUiMode({ requested: 'auto', screenReader: false }, redirected),
    { mode: 'plain' },
  );
  assert.equal(
    resolveUiMode(
      { requested: 'enhanced', screenReader: false },
      { ...supported, term: 'dumb' },
    ).mode,
    'plain',
  );
  assert.equal(
    resolveUiMode(
      { requested: 'enhanced', screenReader: false },
      { ...supported, rows: 7 },
    ).mode,
    'plain',
  );
});

test('screen-reader mode always selects semantic plain output', () => {
  const resolution = resolveUiMode(
    { requested: 'enhanced', screenReader: true },
    supported,
  );
  assert.equal(resolution.mode, 'plain');
  assert.match(resolution.notice ?? '', /Screen-reader mode/);
  assert.deepEqual(
    resolveUiMode({ requested: 'auto', screenReader: true }, supported),
    { mode: 'plain' },
  );
});

test('detects terminal capabilities without spawning a process', () => {
  assert.deepEqual(
    detectTerminalCapabilities({
      input: { isTTY: true },
      output: { isTTY: true, columns: 132, rows: 40 },
      environment: { TERM: 'screen' },
    }),
    {
      stdinIsTty: true,
      stdoutIsTty: true,
      term: 'screen',
      columns: 132,
      rows: 40,
    },
  );
  assert.deepEqual(
    detectTerminalCapabilities({
      input: {},
      output: {},
      environment: {},
    }),
    {
      stdinIsTty: false,
      stdoutIsTty: false,
      term: undefined,
      columns: 80,
      rows: 24,
    },
  );
});
