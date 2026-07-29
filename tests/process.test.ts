import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ProcessAbortError, runProcess } from '../src/process.ts';

test('terminates subprocesses that exceed their timeout', async () => {
  await assert.rejects(
    () =>
      runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        timeoutMs: 25,
      }),
    /timed out/,
  );
});

test(
  'terminates descendant processes with the timed-out process group',
  { skip: process.platform === 'win32' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-process-'));
    const marker = join(directory, 'survived.txt');
    const grandchild = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(
      marker,
    )}, 'alive'), 250)`;
    const parent = `
      require('node:child_process').spawn(
        process.execPath,
        ['-e', ${JSON.stringify(grandchild)}],
        { stdio: 'ignore' }
      );
      setInterval(() => {}, 1000);
    `;
    try {
      await assert.rejects(
        () => runProcess(process.execPath, ['-e', parent], { timeoutMs: 30 }),
        /timed out/,
      );
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
      await assert.rejects(() => readFile(marker), /ENOENT/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('terminates a subprocess that exceeds its output budget', async () => {
  await assert.rejects(
    () =>
      runProcess(
        process.execPath,
        ['-e', "process.stdout.write('x'.repeat(20000))"],
        {
          maxOutputChars: 1_000,
          killGraceMs: 10,
        },
      ),
    /exceeded the 1000-character stdout limit/,
  );
});

test('reports accepted stdout chunks while preserving buffered output', async () => {
  const chunks: string[] = [];
  const result = await runProcess(
    process.execPath,
    ['-e', "process.stdout.write('first\\n'); process.stdout.write('second')"],
    {
      onStdoutChunk: (chunk) => chunks.push(chunk),
    },
  );

  assert.equal(chunks.join(''), 'first\nsecond');
  assert.equal(result.stdout, 'first\nsecond');
});

test('terminates a subprocess when its stdout consumer fails', async () => {
  await assert.rejects(
    () =>
      runProcess(
        process.execPath,
        ['-e', "process.stdout.write('event\\n'); setInterval(() => {}, 1000)"],
        {
          onStdoutChunk: () => {
            throw new Error('event decoder failed');
          },
          killGraceMs: 10,
        },
      ),
    /event decoder failed/,
  );
});

test('cancels a streaming subprocess without losing cancellation semantics', async () => {
  const controller = new AbortController();
  const chunks: string[] = [];

  await assert.rejects(
    () =>
      runProcess(
        process.execPath,
        ['-e', "process.stdout.write('event\\n'); setInterval(() => {}, 1000)"],
        {
          signal: controller.signal,
          killGraceMs: 10,
          onStdoutChunk: (chunk) => {
            chunks.push(chunk);
            controller.abort();
          },
        },
      ),
    ProcessAbortError,
  );
  assert.equal(chunks.join(''), 'event\n');
});
