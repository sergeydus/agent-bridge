import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

import type { IDisposable, IPty } from 'node-pty';

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

function enforceRequiredPty(
  availability: PtyAvailability,
  required: boolean,
): PtyAvailability {
  if (required && !availability.module) {
    throw new Error(
      `Real PTY tests are required, but ${availability.skipReason ?? 'node-pty is unavailable'}`,
    );
  }
  return availability;
}

const { module: nodePty, skipReason: ptySkipReason } = enforceRequiredPty(
  await loadNodePty(),
  process.env.AGENT_BRIDGE_REQUIRE_PTY === '1',
);

interface ScreenSize {
  columns: number;
  rows: number;
}

interface PtySession {
  child: IPty;
  dispose: () => void;
  resize: (columns: number, rows: number) => void;
  resizes: () => readonly { offset: number; size: ScreenSize }[];
  exit: Promise<{ exitCode: number; signal?: number }>;
  exitResult: () => { exitCode: number; signal?: number } | undefined;
  output: () => string;
}

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INITIAL_SIZE: ScreenSize = { columns: 80, rows: 24 };
const FIXTURE_PATH = join(
  PROJECT_ROOT,
  'tests',
  'fixtures',
  'chat-terminal-pty-fixture.ts',
);
const COMPLETION_FIXTURE_PATH = join(
  PROJECT_ROOT,
  'tests',
  'fixtures',
  'completion-prompt-pty-fixture.ts',
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

test('required PTY mode rejects an unavailable native driver', () => {
  assert.throws(
    () =>
      enforceRequiredPty(
        { skipReason: 'node-pty is unavailable: native load failed' },
        true,
      ),
    /Real PTY tests are required, but node-pty is unavailable: native load failed/,
  );
});

function startFixture(
  mode: 'between-prompts' | 'prompt' | 'signal' | 'supplemental-output',
  fixturePath = FIXTURE_PATH,
): PtySession {
  if (!nodePty) {
    throw new Error(ptySkipReason ?? 'node-pty is unavailable');
  }
  let output = '';
  let exitResult: { exitCode: number; signal?: number } | undefined;
  const resizes: { offset: number; size: ScreenSize }[] = [];
  const child = nodePty.spawn(
    process.execPath,
    ['--experimental-strip-types', fixturePath, mode],
    {
      name: 'xterm-256color',
      cols: INITIAL_SIZE.columns,
      rows: INITIAL_SIZE.rows,
      cwd: PROJECT_ROOT,
      env: { ...process.env, TERM: 'xterm-256color' },
    },
  );
  const subscriptions: IDisposable[] = [];
  subscriptions.push(
    child.onData((data) => {
      output += data;
    }),
  );
  const exit = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
    subscriptions.push(
      child.onExit((result) => {
        exitResult = result;
        resolve(result);
      }),
    );
  });
  return {
    child,
    dispose: () => {
      for (const subscription of subscriptions.splice(0)) {
        subscription.dispose();
      }
    },
    exit,
    exitResult: () => exitResult,
    output: () => output,
    resize: (columns, rows) => {
      resizes.push({ offset: output.length, size: { columns, rows } });
      child.resize(columns, rows);
    },
    resizes: () => resizes,
  };
}

function ptyTest(
  name: string,
  run: () => Promise<void>,
  timeoutMilliseconds = 10_000,
): void {
  test(name, { timeout: timeoutMilliseconds, skip: ptySkipReason }, run);
}

async function waitForOutput(
  session: PtySession,
  expected: string | RegExp,
  timeoutMilliseconds = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  const matches = (): boolean => {
    const visibleOutput = stripVTControlCharacters(session.output());
    return typeof expected === 'string'
      ? visibleOutput.includes(expected)
      : expected.test(visibleOutput);
  };
  const description =
    typeof expected === 'string' ? JSON.stringify(expected) : String(expected);
  while (!matches()) {
    const exited = session.exitResult();
    if (exited) {
      throw new Error(
        `PTY exited with ${exited.exitCode} before ${description}. Output:\n${session.output()}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${description}. Output:\n${session.output()}`,
      );
    }
    await delay(10);
  }
}

async function stopSession(session: PtySession): Promise<void> {
  try {
    if (!session.exitResult()) {
      session.child.kill();
      await Promise.race([session.exit, delay(1_000)]);
    }
  } finally {
    session.dispose();
  }
}

function occurrences(text: string, expected: string): number {
  return text.split(expected).length - 1;
}

function promptFollowedByInput(prompt: string, input: string): RegExp {
  const escape = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // ConPTY can represent the prompt's trailing space and cursor position with
  // VT operations. Match the visible ordering instead of serialized spacing.
  return new RegExp(`${escape(prompt)}\\s*${escape(input)}`);
}

/**
 * A minimal VT screen: enough of xterm to answer "what is visible now".
 *
 * Byte-transparent PTYs (Linux, macOS) forward the application's escape
 * sequences, but Windows ConPTY interprets them into its own buffer and emits
 * repaints instead. Depending on the Windows build it may never forward
 * `ESC[?1049h`/`ESC[?1049l` at all, and it coalesces writes that land in one
 * render pass, so text drawn and then erased may never reach the stream.
 * Asserting on the rendered screen holds for both kinds of PTY.
 */
class TerminalScreen {
  #size: ScreenSize;
  #main: string[][];
  #alternate: string[][] | undefined;
  #savedCursor: { row: number; column: number } | undefined;
  #row = 0;
  #column = 0;
  #pendingWrap = false;

  constructor(size: ScreenSize) {
    this.#size = { ...size };
    this.#main = TerminalScreen.#blankLines(size);
  }

  get alternate(): boolean {
    return this.#alternate !== undefined;
  }

  lines(): string[] {
    return this.#lines.map((line) => line.join('').trimEnd());
  }

  text(): string {
    return this.lines().join('\n');
  }

  resize(size: ScreenSize): void {
    const fit = (lines: string[][]): string[][] =>
      Array.from({ length: size.rows }, (_, row) =>
        Array.from(
          { length: size.columns },
          (_, column) => lines[row]?.[column] ?? ' ',
        ),
      );
    this.#size = { ...size };
    this.#main = fit(this.#main);
    this.#alternate = this.#alternate && fit(this.#alternate);
    this.#row = Math.min(this.#row, size.rows - 1);
    this.#column = Math.min(this.#column, size.columns - 1);
    this.#pendingWrap = false;
  }

  write(text: string): void {
    const characters = Array.from(text);
    for (let index = 0; index < characters.length; index += 1) {
      const character = characters[index] ?? '';
      if (character === '\u001B') {
        index = this.#escape(characters, index + 1);
      } else if (character === '\r') {
        this.#moveTo(this.#row, 0);
      } else if (character === '\n') {
        this.#lineFeed();
      } else if (character === '\b') {
        this.#moveTo(this.#row, this.#column - 1);
      } else if (character >= ' ' && character !== '\u007F') {
        this.#print(character);
      }
    }
  }

  static #blankLines(size: ScreenSize): string[][] {
    return Array.from({ length: size.rows }, () =>
      Array.from({ length: size.columns }, () => ' '),
    );
  }

  get #lines(): string[][] {
    return this.#alternate ?? this.#main;
  }

  #print(character: string): void {
    if (this.#pendingWrap) {
      this.#column = 0;
      this.#lineFeed();
    }
    const line = this.#lines[this.#row];
    if (line) {
      line[this.#column] = character;
    }
    if (this.#column === this.#size.columns - 1) {
      this.#pendingWrap = true;
    } else {
      this.#column += 1;
    }
  }

  #lineFeed(): void {
    this.#pendingWrap = false;
    if (this.#row === this.#size.rows - 1) {
      this.#scroll(1);
    } else {
      this.#row += 1;
    }
  }

  #scroll(count: number): void {
    const lines = this.#lines;
    for (let step = 0; step < count; step += 1) {
      lines.shift();
      lines.push(Array.from({ length: this.#size.columns }, () => ' '));
    }
  }

  #moveTo(row: number, column: number): void {
    this.#row = Math.max(0, Math.min(this.#size.rows - 1, row));
    this.#column = Math.max(0, Math.min(this.#size.columns - 1, column));
    this.#pendingWrap = false;
  }

  #erase(row: number, from: number, to: number): void {
    const line = this.#lines[row];
    for (let column = from; line && column < to; column += 1) {
      line[column] = ' ';
    }
  }

  /** Consumes one escape sequence and returns the index of its last character. */
  #escape(characters: string[], start: number): number {
    const introducer = characters[start];
    if (introducer === ']') {
      // OSC, such as ConPTY's window title: skip to BEL or ST.
      for (let index = start + 1; index < characters.length; index += 1) {
        if (characters[index] === '\u0007') {
          return index;
        }
        if (characters[index] === '\u001B' && characters[index + 1] === '\\') {
          return index + 1;
        }
      }
      return characters.length;
    }
    if (introducer !== '[') {
      return start;
    }
    let index = start + 1;
    let parameters = '';
    while (index < characters.length && /[0-?]/.test(characters[index] ?? '')) {
      parameters += characters[index];
      index += 1;
    }
    while (index < characters.length && /[ -/]/.test(characters[index] ?? '')) {
      index += 1;
    }
    this.#control(parameters, characters[index] ?? '');
    return index;
  }

  #control(parameters: string, final: string): void {
    if (parameters.startsWith('?')) {
      if (parameters === '?1049' && final === 'h' && !this.#alternate) {
        this.#savedCursor = { row: this.#row, column: this.#column };
        this.#alternate = TerminalScreen.#blankLines(this.#size);
      } else if (parameters === '?1049' && final === 'l' && this.#alternate) {
        this.#alternate = undefined;
        const saved = this.#savedCursor ?? { row: 0, column: 0 };
        this.#moveTo(saved.row, saved.column);
      }
      return;
    }
    const values = parameters.split(';').map((value) => Number(value) || 0);
    const first = values[0] ?? 0;
    const count = Math.max(1, first);
    const { columns, rows } = this.#size;
    switch (final) {
      case 'A':
        this.#moveTo(this.#row - count, this.#column);
        break;
      case 'B':
        this.#moveTo(this.#row + count, this.#column);
        break;
      case 'C':
        this.#moveTo(this.#row, this.#column + count);
        break;
      case 'D':
        this.#moveTo(this.#row, this.#column - count);
        break;
      case 'G':
        this.#moveTo(this.#row, count - 1);
        break;
      case 'd':
        this.#moveTo(count - 1, this.#column);
        break;
      case 'H':
      case 'f':
        this.#moveTo(count - 1, Math.max(1, values[1] ?? 0) - 1);
        break;
      case 'J':
        if (first === 0) {
          this.#erase(this.#row, this.#column, columns);
          for (let row = this.#row + 1; row < rows; row += 1) {
            this.#erase(row, 0, columns);
          }
        } else if (first === 1) {
          for (let row = 0; row < this.#row; row += 1) {
            this.#erase(row, 0, columns);
          }
          this.#erase(this.#row, 0, this.#column + 1);
        } else {
          for (let row = 0; row < rows; row += 1) {
            this.#erase(row, 0, columns);
          }
        }
        break;
      case 'K':
        if (first === 0) {
          this.#erase(this.#row, this.#column, columns);
        } else if (first === 1) {
          this.#erase(this.#row, 0, this.#column + 1);
        } else {
          this.#erase(this.#row, 0, columns);
        }
        break;
      case 'X':
        this.#erase(this.#row, this.#column, this.#column + count);
        break;
      case 'S':
        this.#scroll(count);
        break;
      default:
        // SGR and other modes do not change which text is visible.
        break;
    }
  }
}

/** Replays a session's output, applying each resize where it happened. */
function renderScreen(session: PtySession): TerminalScreen {
  const output = session.output();
  const screen = new TerminalScreen(INITIAL_SIZE);
  let offset = 0;
  for (const resize of session.resizes()) {
    screen.write(output.slice(offset, resize.offset));
    screen.resize(resize.size);
    offset = resize.offset;
  }
  screen.write(output.slice(offset));
  return screen;
}

async function waitForScreen(
  session: PtySession,
  description: string,
  matches: (screen: TerminalScreen) => boolean,
  timeoutMilliseconds = 5_000,
): Promise<TerminalScreen> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (true) {
    const screen = renderScreen(session);
    if (matches(screen)) {
      return screen;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${description}. Screen:\n${screen.text()}\nOutput:\n${JSON.stringify(session.output())}`,
      );
    }
    await delay(10);
  }
}

test('screen model restores the main screen after the alternate screen', () => {
  const screen = new TerminalScreen({ columns: 20, rows: 4 });
  screen.write('main line\r\n');
  screen.write('\u001B[?1049h\u001B[2J\u001B[HFrame heading\r\nbody');
  assert.equal(screen.alternate, true);
  assert.deepEqual(screen.lines(), ['Frame heading', 'body', '', '']);

  screen.write('\u001B[?1049l\r\ndone');
  assert.equal(screen.alternate, false);
  assert.deepEqual(screen.lines(), ['main line', '', 'done', '']);
});

test('screen model applies erasing, wrapping, scrolling, and resizing', () => {
  const screen = new TerminalScreen({ columns: 5, rows: 3 });
  screen.write('\u001B]0;title\u0007one\r\ntwo\r\nthree');
  assert.deepEqual(screen.lines(), ['one', 'two', 'three']);

  // An exactly full line defers its wrap until the next printable character.
  screen.write('\r\nfour');
  assert.deepEqual(screen.lines(), ['two', 'three', 'four']);
  screen.write('\u001B[1A\u001B[1G\u001B[0J');
  assert.deepEqual(screen.lines(), ['two', '', '']);

  screen.write('\u001B[3;2Hxy\u001B[1;1H\u001B[K\u001B[3;1H\u001B[1X');
  assert.deepEqual(screen.lines(), ['', '', ' xy']);

  screen.resize({ columns: 4, rows: 4 });
  screen.write('\u001B[4;1Habcdefg');
  assert.deepEqual(screen.lines(), ['', ' xy', 'abcd', 'efg']);
});

test('PTY prompt matching does not cross an earlier submitted command', () => {
  const promptWithCursorSpacing = 'You >\r\n\r\ndraft';
  const submittedCommandThenInput = 'You > /status\r\n\r\ndraft';
  const pattern = promptFollowedByInput('You >', 'draft');

  assert.match(promptWithCursorSpacing, pattern);
  assert.doesNotMatch(submittedCommandThenInput, pattern);
});

ptyTest(
  'real PTY preserves a partial readline buffer across resize',
  async () => {
    const session = startFixture('prompt');
    try {
      await waitForOutput(session, '__AB_TTY__true:true');
      await waitForOutput(session, 'You >');
      session.child.write('partial');
      await waitForOutput(session, promptFollowedByInput('You >', 'partial'));

      session.resize(100, 30);
      await waitForOutput(session, '__AB_RESIZED__');
      const visibleOutput = stripVTControlCharacters(session.output());
      const afterResize = visibleOutput.slice(
        visibleOutput.lastIndexOf('__AB_RESIZED__'),
      );
      assert.match(afterResize, promptFollowedByInput('You >', 'partial'));

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
      const ready = await waitForScreen(
        session,
        'the enhanced frame',
        (screen) => screen.text().includes('Agent Bridge · pty-fixture'),
      );
      assert.doesNotMatch(ready.text(), /__AB_MAIN__/);

      session.child.write('\u0003');
      await waitForOutput(session, '__AB_SIGINT__');
      const exited = await session.exit;
      assert.equal(exited.exitCode, 0);

      // ConPTY may consume the private-mode sequences and repaint instead, so
      // prove the restoration by its effect: the frame is gone, the normal
      // screen's earlier text is back, and the signal line follows it.
      const restored = renderScreen(session);
      const lines = restored.lines();
      assert.equal(restored.alternate, false);
      assert.doesNotMatch(restored.text(), /Agent Bridge/);
      const main = lines.findIndex((line) => line.includes('__AB_MAIN__'));
      const signal = lines.findIndex((line) => line.includes('__AB_SIGINT__'));
      assert.ok(main >= 0, restored.text());
      assert.ok(signal > main, restored.text());
    } finally {
      await stopSession(session);
    }
  },
);

ptyTest('real PTY resolves a pending prompt on Ctrl+D', async () => {
  const session = startFixture('prompt');
  try {
    await waitForOutput(session, 'You >');
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
      await waitForOutput(session, 'Start >');
      session.child.write('go\r');
      await waitForOutput(session, '__AB_WORKING__');
      session.child.write('draft');
      await waitForOutput(session, '__AB_WORKING__draft');

      session.resize(90, 25);
      await waitForOutput(session, '__AB_FRAME__');
      const afterFrame = stripVTControlCharacters(session.output()).slice(
        stripVTControlCharacters(session.output()).lastIndexOf('__AB_FRAME__'),
      );
      assert.match(afterFrame, promptFollowedByInput('Start >', 'draft'));

      session.resize(100, 30);
      await waitForOutput(session, promptFollowedByInput('Next >', 'draft'));
      session.child.write(' message\r');
      await waitForOutput(session, '__AB_RESULT__"draft message"');
      const exited = await session.exit;
      assert.equal(exited.exitCode, 0);
    } finally {
      await stopSession(session);
    }
  },
);

ptyTest(
  'real PTY keeps partial input below supplemental output',
  async () => {
    const session = startFixture('supplemental-output');
    try {
      await waitForOutput(session, 'You >');
      session.child.write('/ask codex inspect\r');
      await waitForOutput(session, '__AB_PROVIDER__');
      session.child.write('/status\r');
      session.child.write('draft');
      session.resize(90, 25);

      const draftPrompt = promptFollowedByInput('You >', 'draft');
      const lastStatusLine = (lines: string[]): number =>
        lines.findIndex((line) =>
          line.includes('Presentation: enhanced terminal'),
        );
      // Judge the rendered screen, not the byte stream: a prompt repaint that
      // erased the status block's last line used to pass on byte-transparent
      // PTYs and fail on ConPTY, which never emits text erased in one pass.
      const screen = await waitForScreen(
        session,
        'the complete status block with the partial input below it',
        (current) => {
          const lines = current.lines();
          const last = lastStatusLine(lines);
          return (
            last >= 0 &&
            lines.slice(last + 1).some((line) => draftPrompt.test(line))
          );
        },
      );
      const lines = screen.lines();
      const first = lines.findIndex((line) => line.startsWith('Session: '));
      const last = lastStatusLine(lines);
      // The block is on the restored normal screen, intact and contiguous,
      // and the partial input is repainted only beneath it.
      assert.equal(screen.alternate, false);
      assert.doesNotMatch(screen.text(), /Agent Bridge ·/);
      assert.ok(first >= 0 && last > first, screen.text());
      assert.deepEqual(
        lines.slice(first, last + 1).map((line) => line.split(':')[0]),
        [
          'Session',
          'Status',
          'Project',
          'Messages',
          'Latest paired exchange',
          'Linked workflows',
          'Automatic exchange limit',
          'Editing workflow cycle limit',
          'Codex model',
          'Claude model',
          'Presentation',
        ],
      );
      assert.equal(
        lines.slice(0, first).some((line) => draftPrompt.test(line)),
        false,
        screen.text(),
      );

      session.child.write('\u0015/pause\r');
      await waitForOutput(session, 'Chat saved. Resume with:');
      const exited = await session.exit;
      assert.equal(exited.exitCode, 0);
    } finally {
      await stopSession(session);
    }
  },
  20_000,
);

ptyTest(
  'real PTY treats Ctrl+D at the completion menu as declining',
  async () => {
    const session = startFixture('prompt', COMPLETION_FIXTURE_PATH);
    try {
      await waitForOutput(session, '__AB_TTY__true:true');
      await waitForOutput(
        session,
        'What should happen to the completed changes?',
      );
      await waitForOutput(session, 'Choose 1, 2, or 3 [1]:');

      // D1: this used to reject out of the completion step and mark a run
      // that had already finished successfully as failed.
      session.child.write('\u0004');

      await waitForOutput(session, '__AB_OUTCOME__declined');
      const exited = await session.exit;
      assert.equal(exited.exitCode, 0);
      assert.equal(
        stripVTControlCharacters(session.output()).includes('AbortError'),
        false,
      );
    } finally {
      await stopSession(session);
    }
  },
  30_000,
);
