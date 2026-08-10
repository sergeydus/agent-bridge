import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setImmediate as waitForImmediate } from 'node:timers/promises';

import {
  createChatTerminal,
  type ChatReadlineOptions,
} from '../src/chat-input.ts';

class FakeReadline extends EventEmitter {
  readonly prompts: Array<boolean | undefined> = [];
  line = '';
  cursor = 0;
  promptLabel = '';
  pauseCalls = 0;
  resumeCalls = 0;
  closeCalls = 0;

  setPrompt(prompt: string): void {
    this.promptLabel = prompt;
  }

  prompt(preserveCursor?: boolean): void {
    this.prompts.push(preserveCursor);
  }

  pause(): void {
    this.pauseCalls += 1;
  }

  resume(): void {
    this.resumeCalls += 1;
  }

  close(): void {
    this.closeCalls += 1;
  }
}

function createFakeTerminal(): {
  interface_: FakeReadline;
  options: () => ChatReadlineOptions;
  outputText: () => string;
  signalEvents: Array<string | symbol>;
  terminal: ReturnType<typeof createChatTerminal>;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: Buffer[] = [];
  output.on('data', (chunk: Buffer) => written.push(chunk));
  const interface_ = new FakeReadline();
  let receivedOptions: ChatReadlineOptions | undefined;
  const signalEvents: Array<string | symbol> = [];
  const terminal = createChatTerminal({
    input,
    output,
    createReadline: (options) => {
      receivedOptions = options;
      return interface_;
    },
    signalEmitter: {
      emit(eventName) {
        signalEvents.push(eventName);
        return true;
      },
    },
  });
  return {
    interface_,
    options: () => {
      assert.ok(receivedOptions);
      return receivedOptions;
    },
    outputText: () => Buffer.concat(written).toString(),
    signalEvents,
    terminal,
  };
}

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

test('chat terminal delegates active prompt lifecycle to readline', async () => {
  const harness = createFakeTerminal();
  const controller = new AbortController();
  const removeAbortListener = controller.signal.removeEventListener.bind(
    controller.signal,
  );
  let removeAbortListenerCalls = 0;
  Object.defineProperty(controller.signal, 'removeEventListener', {
    configurable: true,
    value: (...parameters: Parameters<typeof removeAbortListener>) => {
      removeAbortListenerCalls += 1;
      removeAbortListener(...parameters);
    },
  });
  const pending = harness.terminal.prompt('You > ', controller.signal);

  assert.equal(harness.interface_.promptLabel, 'You > ');
  assert.deepEqual(harness.interface_.prompts, [undefined]);
  assert.equal(harness.options().historySize, 100);
  assert.equal(harness.options().removeHistoryDuplicates, true);
  assert.deepEqual(harness.options().completer('/sta'), [['/status'], '/sta']);

  harness.terminal.write('Working\n');
  harness.terminal.redrawPrompt();
  harness.terminal.pause();
  harness.terminal.resume();
  assert.equal(harness.outputText(), 'Working\n');
  assert.deepEqual(harness.interface_.prompts, [undefined, true]);
  assert.equal(harness.interface_.pauseCalls, 1);
  assert.equal(harness.interface_.resumeCalls, 1);

  harness.interface_.emit('line', 'answer');
  assert.equal(await pending, 'answer');
  assert.equal(removeAbortListenerCalls, 1);
  controller.abort();

  // Readline owns the partial buffer between coordinator prompts, so redraws
  // keep it visible while providers work even though this promise settled.
  harness.terminal.redrawPrompt();
  assert.deepEqual(harness.interface_.prompts, [undefined, true, true]);

  harness.terminal.close();
  assert.equal(harness.interface_.closeCalls, 1);
});

test('chat terminal clears an aborted prompt before queueing later input', async () => {
  const harness = createFakeTerminal();
  const controller = new AbortController();
  const queueCounts: number[] = [];
  harness.terminal.setQueuedInputObserver((count) => queueCounts.push(count));
  const pending = harness.terminal.prompt('You > ', controller.signal);

  controller.abort();
  assert.equal(await pending, null);
  harness.interface_.emit('line', 'queued after abort');
  assert.deepEqual(queueCounts, [0, 1]);
  assert.equal(await harness.terminal.prompt('Again > '), 'queued after abort');
  assert.deepEqual(queueCounts, [0, 1, 0]);
  assert.equal(harness.outputText(), 'Again > ');

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  assert.equal(
    await harness.terminal.prompt('Never shown > ', alreadyAborted.signal),
    null,
  );
  assert.deepEqual(harness.interface_.prompts, [undefined]);
});

test('chat terminal resolves a pending prompt when readline closes', async () => {
  const harness = createFakeTerminal();
  const pending = harness.terminal.prompt('You > ');

  harness.interface_.emit('close');
  assert.equal(await pending, null);
  assert.equal(await harness.terminal.prompt('After close > '), null);
  assert.deepEqual(harness.interface_.prompts, [undefined]);
});

test('chat terminal forwards readline SIGINT through the injected emitter', () => {
  const harness = createFakeTerminal();

  harness.interface_.emit('SIGINT');

  assert.deepEqual(harness.signalEvents, ['SIGINT']);
});
