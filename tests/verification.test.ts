import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatVerificationResults,
  runVerificationCommands,
} from '../src/verification.ts';

test('runs approved commands as executable and argument arrays', async () => {
  const results = await runVerificationCommands({
    commands: [
      {
        command: process.execPath,
        args: ['-e', "process.stdout.write('verified')"],
      },
    ],
    cwd: process.cwd(),
    defaultTimeoutMs: 5_000,
  });
  assert.equal(results[0]?.passed, true);
  assert.equal(results[0]?.output, 'verified');
  assert.match(formatVerificationResults(results), /PASS/);
});

test('records verification failures without aborting later review evidence', async () => {
  const results = await runVerificationCommands({
    commands: [
      {
        command: process.execPath,
        args: ['-e', 'process.exit(7)'],
      },
    ],
    cwd: process.cwd(),
    defaultTimeoutMs: 5_000,
  });
  assert.equal(results[0]?.passed, false);
  assert.match(formatVerificationResults(results), /FAIL/);
});

test('bounds noisy verification output while preserving both ends', async () => {
  const script = "process.stdout.write('start-' + 'x'.repeat(50000) + '-end')";
  const [result] = await runVerificationCommands({
    commands: [{ command: process.execPath, args: ['-e', script] }],
    cwd: process.cwd(),
    defaultTimeoutMs: 5_000,
  });
  assert.ok(result);
  assert.match(result.output, /^start-/);
  assert.match(result.output, /\[verification output clipped\]/);
  assert.match(result.output, /-end$/);
  assert.ok(result.output.length < 41_000);
});
