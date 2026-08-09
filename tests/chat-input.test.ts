import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setImmediate as waitForImmediate } from 'node:timers/promises';

import { createChatTerminal } from '../src/chat-input.ts';

test('real chat terminal queues complete lines until the next prompt', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: Buffer[] = [];
  output.on('data', (chunk: Buffer) => written.push(chunk));
  const terminal = createChatTerminal({ input, output });
  const queueCounts: number[] = [];
  terminal.setQueuedInputObserver((count) => queueCounts.push(count));
  try {
    input.write('first queued line\nsecond queued line\n');
    await waitForImmediate();
    assert.deepEqual(queueCounts, [0, 1, 2]);

    const first = await terminal.prompt('You > ');
    const second = await terminal.prompt('You > ');
    assert.equal(first, 'first queued line');
    assert.equal(second, 'second queued line');
    assert.deepEqual(queueCounts, [0, 1, 2, 1, 0]);
    assert.equal(Buffer.concat(written).toString(), 'You > You > ');
  } finally {
    terminal.close();
  }
});
