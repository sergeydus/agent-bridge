import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

import type { IPty } from 'node-pty';

interface PtyAvailability {
  module?: typeof import('node-pty');
  skipReason?: string;
}

async function loadNodePty(
  load: () => Promise<typeof import('node-pty')> = () => import('node-pty'),
): Promise<PtyAvailability> {
  try {
    return { module: await load() };
  } catch (error) {
    return {
      skipReason: `node-pty is unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

const { module: nodePty, skipReason: ptySkipReason } = await loadNodePty();

interface PtySession {
  child: IPty;
  exit: Promise<{ exitCode: number; signal?: number }>;
  exitResult: () => { exitCode: number; signal?: number } | undefined;
  output: () => string;
}

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PATH = join(
  PROJECT_ROOT,
  'tests',
  'fixtures',
  'chat-terminal-pty-fixture.ts',
);

test('PTY driver load failure becomes an explicit skip reason', async () => {
  const availability = await loadNodePty(() =>
    Promise.reject(new Error('native module could not load')),
  );

  assert.equal(availability.module, undefined);
  assert.equal(
    availability.skipReason,
    'node-pty is unavailable: native module could not load',
  );
});

function startFixture(
  mode: 'between-prompts' | 'prompt' | 'signal',
): PtySession {
  if (!nodePty) {
    throw new Error(ptySkipReason ?? 'node-pty is unavailable');
  }
  let output = '';
  let exitResult: { exitCode: number; signal?: number } | undefined;
  const child = nodePty.spawn(
    process.execPath,
    ['--experimental-strip-types', FIXTURE_PATH, mode],
    {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: PROJECT_ROOT,
      env: { ...process.env, TERM: 'xterm-256color' },
    },
  );
  child.onData((data) => {
    output += data;
  });
  const exit = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
    child.onExit((result) => {
      exitResult = result;
      resolve(result);
    });
  });
  return {
    child,
    exit,
    exitResult: () => exitResult,
    output: () => output,
  };
}

function ptyTest(name: string, run: () => Promise<void>): void {
  test(name, { timeout: 10_000, skip: ptySkipReason }, run);
}

async function waitForOutput(
  session: PtySession,
  expected: string,
  timeoutMilliseconds = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!stripVTControlCharacters(session.output()).includes(expected)) {
    const exited = session.exitResult();
    if (exited) {
      throw new Error(
        `PTY exited with ${exited.exitCode} before ${JSON.stringify(expected)}. Output:\n${session.output()}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${JSON.stringify(expected)}. Output:\n${session.output()}`,
      );
    }
    await delay(10);
  }
}

async function stopSession(session: PtySession): Promise<void> {
  if (!session.exitResult()) {
    session.child.kill();
    await Promise.race([session.exit, delay(1_000)]);
  }
}

function occurrences(text: string, expected: string): number {
  return text.split(expected).length - 1;
}

ptyTest(
  'real PTY preserves a partial readline buffer across resize',
  async () => {
    const session = startFixture('prompt');
    try {
      await waitForOutput(session, '__AB_TTY__true:true');
      await waitForOutput(session, 'You > ');
      session.child.write('partial');
      await waitForOutput(session, 'You > partial');

      session.child.resize(100, 30);
      await waitForOutput(session, '__AB_RESIZED__');
      const visibleOutput = stripVTControlCharacters(session.output());
      const afterResize = visibleOutput.slice(
        visibleOutput.lastIndexOf('__AB_RESIZED__'),
      );
      assert.match(afterResize, /You > partial/);

      session.child.write(' input\r');
      await waitForOutput(session, '__AB_RESULT__"partial input"');
      const exited = await session.exit;
      assert.equal(exited.exitCode, 0);
      assert.equal(
        occurrences(session.output(), '__AB_RESULT__"partial input"'),
        1,
      );
    } finally {
      await stopSession(session);
    }
  },
);

ptyTest(
  'real PTY forwards Ctrl+C and restores the alternate screen',
  async () => {
    const session = startFixture('signal');
    try {
      await waitForOutput(session, '__AB_READY__');
      session.child.write('\u0003');
      await waitForOutput(session, '__AB_SIGINT__');
      const exited = await session.exit;
      assert.equal(exited.exitCode, 0);

      const output = session.output();
      const entered = output.indexOf('\u001B[?1049h');
      const restored = output.lastIndexOf('\u001B[?1049l');
      const signal = output.indexOf('__AB_SIGINT__');
      assert.ok(entered >= 0);
      assert.ok(restored > entered);
      assert.ok(signal > restored);
    } finally {
      await stopSession(session);
    }
  },
);

ptyTest('real PTY resolves a pending prompt on Ctrl+D', async () => {
  const session = startFixture('prompt');
  try {
    await waitForOutput(session, 'You > ');
    session.child.write('\u0004');
    await waitForOutput(session, '__AB_RESULT__null');
    const exited = await session.exit;
    assert.equal(exited.exitCode, 0);
  } finally {
    await stopSession(session);
  }
});

ptyTest(
  'real PTY preserves partial input and its cursor between prompts',
  async () => {
    const session = startFixture('between-prompts');
    try {
      await waitForOutput(session, 'Start > ');
      session.child.write('go\r');
      await waitForOutput(session, '__AB_WORKING__');
      session.child.write('draft');
      await waitForOutput(session, '__AB_WORKING__draft');

      session.child.resize(90, 25);
      await waitForOutput(session, '__AB_FRAME__');
      const afterFrame = stripVTControlCharacters(session.output()).slice(
        stripVTControlCharacters(session.output()).lastIndexOf('__AB_FRAME__'),
      );
      assert.match(afterFrame, /Start > draft/);

      session.child.resize(100, 30);
      await waitForOutput(session, 'Next > draft');
      session.child.write(' message\r');
      await waitForOutput(session, '__AB_RESULT__"draft message"');
      const exited = await session.exit;
      assert.equal(exited.exitCode, 0);
    } finally {
      await stopSession(session);
    }
  },
);
