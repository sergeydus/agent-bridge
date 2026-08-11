import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatVerificationResults,
  runVerificationCommands,
} from '../src/verification.ts';

// Children spawned by this file must not write coverage. Under
// `--experimental-test-coverage` a spawned Node process inherits
// `NODE_V8_COVERAGE` and writes its own report into the same directory, and one
// arriving while the reporter reads that directory failed the whole Windows run
// with "Unexpected end of JSON input" even though every test passed. Removing the
// variable here does not affect this process's own coverage, which V8 already
// enabled at startup; it only stops what this file spawns from reporting.
delete process.env.NODE_V8_COVERAGE;

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

test('reports a failing command with its real exit code and both streams', async () => {
  const script =
    "process.stdout.write('assertion detail'); " +
    "process.stderr.write('npm noise'); process.exit(7)";
  const results = await runVerificationCommands({
    commands: [{ command: process.execPath, args: ['-e', script] }],
    cwd: process.cwd(),
    defaultTimeoutMs: 5_000,
  });
  assert.equal(results[0]?.passed, false);
  // A nonzero exit is evidence, not an error: the reviewer needs the code and
  // the stdout detail, which a stderr-only error message would have replaced.
  assert.equal(results[0]?.exitCode, 7);
  assert.match(results[0]?.output ?? '', /assertion detail/);
  assert.match(results[0]?.output ?? '', /npm noise/);
  // The formatted text is what reaches the reviewer, so assert there too.
  const reviewerEvidence = formatVerificationResults(results);
  assert.match(reviewerEvidence, /FAIL \(exit 7\)/);
  assert.match(reviewerEvidence, /assertion detail/);
  assert.match(reviewerEvidence, /npm noise/);
});

test('separates a command that never ran from one that ran and failed', async () => {
  const results = await runVerificationCommands({
    commands: [{ command: 'agent-bridge-missing-verification', args: [] }],
    cwd: process.cwd(),
    defaultTimeoutMs: 5_000,
  });
  assert.equal(results[0]?.passed, false);
  assert.equal(results[0]?.exitCode, -1);
  const reviewerEvidence = formatVerificationResults(results);
  assert.match(reviewerEvidence, /FAIL \(did not run to completion\)/);
  assert.doesNotMatch(reviewerEvidence, /exit -1/);
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
