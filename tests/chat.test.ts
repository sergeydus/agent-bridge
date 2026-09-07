import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  CHAT_HELP,
  completeChatInput,
  MAX_USER_MESSAGE_CHARS,
  parseChatInput,
  type ChatTerminal,
} from '../src/chat-input.ts';
import { ChatSessionStore, type ChatSession } from '../src/chat-state.ts';
import { UserConfigStore } from '../src/config.ts';
import { runInteractiveChat } from '../src/chat.ts';
import {
  buildWorkflowArguments,
  type WorkflowLaunchRequest,
} from '../src/chat-workflow.ts';
import { parseArgs } from '../src/options.ts';
import { getAppPaths } from '../src/paths.ts';
import { ProcessAbortError } from '../src/process.ts';
import type { TerminalRenderer } from '../src/presentation.ts';
import type {
  AgentProvider,
  ProviderMap,
  ProviderRunOptions,
} from '../src/providers.ts';

const execFileAsync = promisify(execFile);

class ScriptedTerminal implements ChatTerminal {
  readonly output: string[] = [];
  readonly prompts: string[] = [];
  #inputs: string[];
  pauses = 0;
  resumes = 0;
  closes = 0;
  redraws = 0;
  queuedInputObserver: ((count: number) => void) | undefined;

  constructor(inputs: string[]) {
    this.#inputs = [...inputs];
  }

  prompt(prompt: string, _signal?: AbortSignal): Promise<string | null> {
    this.prompts.push(prompt);
    return Promise.resolve(this.#inputs.shift() ?? null);
  }

  write(text: string): void {
    this.output.push(text);
  }

  redrawPrompt(): void {
    this.redraws += 1;
  }

  setQueuedInputObserver(observer?: (count: number) => void): void {
    this.queuedInputObserver = observer;
    observer?.(0);
  }

  pause(): void {
    this.pauses += 1;
  }

  resume(): void {
    this.resumes += 1;
  }

  close(): void {
    this.closes += 1;
  }
}

class PromptHookTerminal extends ScriptedTerminal {
  #hook: (prompt: string) => Promise<void>;

  constructor(inputs: string[], hook: (prompt: string) => Promise<void>) {
    super(inputs);
    this.#hook = hook;
  }

  override async prompt(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    await this.#hook(prompt);
    return super.prompt(prompt, signal);
  }
}

class FailingRestoreTerminal extends ScriptedTerminal {
  #shouldFailRestore = true;

  override write(text: string): void {
    super.write(text);
    if (this.#shouldFailRestore && text.includes('\u001B[?1049l')) {
      this.#shouldFailRestore = false;
      throw new Error('terminal restore failed');
    }
  }
}

class FailingRedrawTerminal extends ScriptedTerminal {
  #failRedraw = false;

  override prompt(): Promise<string | null> {
    this.#failRedraw = true;
    process.stdout.emit('resize');
    return Promise.resolve(null);
  }

  override redrawPrompt(): void {
    if (this.#failRedraw) {
      throw new Error('prompt redraw failed');
    }
    super.redrawPrompt();
  }
}

class FailingActivityTerminal extends ScriptedTerminal {
  #updateCount = 0;

  override write(text: string): void {
    if (text.startsWith('\u001B[H')) {
      this.#updateCount += 1;
      if (this.#updateCount === 2) {
        throw new Error('activity redraw failed');
      }
    }
    super.write(text);
  }
}

class RecordingRedrawTerminal extends ScriptedTerminal {
  override redrawPrompt(): void {
    super.redrawPrompt();
    this.output.push('<prompt-redraw>');
  }
}

const ENHANCED_TERMINAL_CAPABILITIES = {
  stdinIsTty: true,
  stdoutIsTty: true,
  term: 'xterm-256color',
  columns: 100,
  rows: 24,
} as const;

function providersWithRun(run: AgentProvider['run']): ProviderMap {
  const provider = (name: 'codex' | 'claude'): AgentProvider => ({
    name,
    label: name,
    version: async () => ({ stdout: 'test', stderr: '', exitCode: 0 }),
    authStatus: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    run,
  });
  return { codex: provider('codex'), claude: provider('claude') };
}

/**
 * A repository whose `/edit` flow asks all three of its confirmations: a dirty
 * tracked file draws the committed-HEAD acknowledgement, and a configured
 * verification command draws the approval question before the start question.
 */
async function editingProjectWithVerification(): Promise<string> {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-git-'));
  await execFileAsync('git', ['init'], { cwd: project });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: project,
  });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], {
    cwd: project,
  });
  await writeFile(join(project, 'tracked.txt'), 'committed\n');
  await execFileAsync('git', ['add', 'tracked.txt'], { cwd: project });
  await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: project });
  await writeFile(join(project, 'tracked.txt'), 'local change\n');
  await writeFile(
    join(project, '.agent-bridge.json'),
    JSON.stringify({
      version: 1,
      verification: [{ command: 'npm', args: ['test'] }],
      protectedPaths: [],
    }),
  );
  return project;
}

function fakeProviders(
  prompts: string[],
  optionsSeen: ProviderRunOptions[],
): ProviderMap {
  let calls = 0;
  const provider = (name: 'codex' | 'claude'): AgentProvider => ({
    name,
    label: name,
    version: async () => ({ stdout: 'test', stderr: '', exitCode: 0 }),
    authStatus: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    run: async (prompt, options) => {
      prompts.push(prompt);
      optionsSeen.push(options);
      options.onEvent?.({
        type: 'activity',
        message: 'searching the project',
      });
      options.onEvent?.({ type: 'text-delta', text: `${name} live ` });
      options.onEvent?.({ type: 'text-delta', text: 'progress' });
      options.onEvent?.({ type: 'text-end' });
      calls += 1;
      return {
        text: `${name} answer ${calls}`,
        decision: calls <= 2 ? 'continue' : 'done',
      };
    },
  });
  return { codex: provider('codex'), claude: provider('claude') };
}

function unavailableProviders(): ProviderMap {
  const provider = (name: 'codex' | 'claude'): AgentProvider => ({
    name,
    label: name,
    version: async () => {
      throw new Error(`spawn ${name} ENOENT`);
    },
    authStatus: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    run: async () => {
      throw new Error('run should not be reached');
    },
  });
  return { codex: provider('codex'), claude: provider('claude') };
}

test('parses interactive commands without accepting arbitrary actions', () => {
  assert.match(CHAT_HELP, /files stay unchanged/);
  assert.match(CHAT_HELP, /reciprocal confirmation/);
  assert.match(CHAT_HELP, /Named agent edits; the other agent reviews/);
  assert.match(CHAT_HELP, /alternate editing and reviewing/);
  assert.deepEqual(parseChatInput('hello'), {
    kind: 'message',
    text: 'hello',
  });
  assert.deepEqual(parseChatInput('/auto 4'), { kind: 'auto', rounds: 4 });
  assert.deepEqual(parseChatInput('/edit'), {
    kind: 'workflow',
    mode: 'collaborative',
    firstAgent: 'claude',
  });
  assert.deepEqual(parseChatInput('/edit codex'), {
    kind: 'workflow',
    mode: 'collaborative',
    firstAgent: 'codex',
  });
  assert.deepEqual(parseChatInput('/ask claude inspect this carefully'), {
    kind: 'message',
    target: 'claude',
    text: 'inspect this carefully',
  });
  assert.deepEqual(parseChatInput('@codex explain this'), {
    kind: 'message',
    target: 'codex',
    text: 'explain this',
  });
  assert.deepEqual(parseChatInput('/both compare the approaches'), {
    kind: 'message',
    target: 'both',
    text: 'compare the approaches',
  });
});

test('slash commands keep the spacing the user typed in the message', () => {
  // Splitting on whitespace to find the command must not reformat the message:
  // pasted code carries meaning in its indentation and alignment.
  const indented = 'if (x) {\n    return 1;\n}';
  assert.deepEqual(parseChatInput(`/both ${indented}`), {
    kind: 'message',
    target: 'both',
    text: indented,
  });
  assert.deepEqual(parseChatInput(`/ask codex ${indented}`), {
    kind: 'message',
    target: 'codex',
    text: indented,
  });
  assert.deepEqual(parseChatInput('/both look   at    this'), {
    kind: 'message',
    target: 'both',
    text: 'look   at    this',
  });
  assert.deepEqual(parseChatInput('/ask claude look   at    this'), {
    kind: 'message',
    target: 'claude',
    text: 'look   at    this',
  });
  // Extra spacing between the command tokens themselves is still consumed.
  assert.deepEqual(parseChatInput('/ask   codex   spaced  out'), {
    kind: 'message',
    target: 'codex',
    text: 'spaced  out',
  });
  // The mention form already preserved spacing and must keep doing so.
  assert.deepEqual(parseChatInput('@both look   at    this'), {
    kind: 'message',
    target: 'both',
    text: 'look   at    this',
  });
});

test('an unusable slash message is still rejected', () => {
  assert.equal(parseChatInput('/ask codex').kind, 'invalid');
  assert.equal(parseChatInput('/ask').kind, 'invalid');
  assert.equal(parseChatInput('/both').kind, 'invalid');
  assert.equal(parseChatInput('/ask nobody hello').kind, 'invalid');
});

test('new messages cannot exceed the bounded prompt-history budget', () => {
  assert.equal(
    parseChatInput('x'.repeat(MAX_USER_MESSAGE_CHARS + 1)).kind,
    'invalid',
  );
  assert.equal(
    parseChatInput('x'.repeat(MAX_USER_MESSAGE_CHARS)).kind,
    'message',
  );
});

test('parses the remaining chat commands', () => {
  assert.deepEqual(parseChatInput('/implement claude'), {
    kind: 'workflow',
    mode: 'fixed',
    firstAgent: 'claude',
  });
  assert.deepEqual(parseChatInput('/implement Claude'), {
    kind: 'workflow',
    mode: 'fixed',
    firstAgent: 'claude',
  });
  assert.deepEqual(parseChatInput('/paste'), { kind: 'paste' });
  assert.equal(parseChatInput('/paste now').kind, 'invalid');
  assert.equal(parseChatInput('/auto 21').kind, 'invalid');
  assert.equal(parseChatInput('/shell rm').kind, 'invalid');
  assert.equal(parseChatInput('/ask codex').kind, 'invalid');
  assert.ok(completeChatInput('/ask c')[0].includes('/ask codex '));
  assert.deepEqual(completeChatInput('ordinary message')[0], []);
});

test('builds an isolated child workflow as argument arrays', () => {
  const temporaryDirectory = tmpdir();
  const taskPath = join(temporaryDirectory, 'private-task.md');
  const launcher = join(temporaryDirectory, 'agent-bridge', 'dist', 'cli.js');
  const options = parseArgs(
    [
      'chat',
      '--cwd',
      temporaryDirectory,
      '--from-head',
      '--trust-project-config',
      '--screen-reader',
      '--max-rounds',
      '7',
    ],
    {
      initialCwd: temporaryDirectory,
      defaultOutput: join(temporaryDirectory, 'bridge-runs'),
    },
  );
  const args = buildWorkflowArguments(
    {
      mode: 'collaborative',
      firstAgent: 'claude',
      task: 'context',
      projectRoot: temporaryDirectory,
      options,
    },
    taskPath,
    launcher,
  );
  assert.deepEqual(args.slice(0, 5), [
    launcher,
    '--task-file',
    taskPath,
    '--cwd',
    temporaryDirectory,
  ]);
  assert.ok(args.includes('--collaborative'));
  assert.ok(args.includes('--from-head'));
  assert.ok(args.includes('--trust-project-config'));
  assert.ok(args.includes('--screen-reader'));
  assert.ok(!args.includes('chat'));
  assert.ok(!args.includes('--no-isolation'));
});

test('a chat-launched review names no redundant or role flags', () => {
  const temporaryDirectory = tmpdir();
  const options = parseArgs(['chat'], {
    initialCwd: temporaryDirectory,
    defaultOutput: join(temporaryDirectory, 'bridge-runs'),
  });
  const args = buildWorkflowArguments(
    {
      mode: 'review',
      task: 'context',
      projectRoot: temporaryDirectory,
      options,
    },
    join(temporaryDirectory, 'task.md'),
    'launcher',
  );

  assert.ok(args.includes('--require-agreement'));
  // `--require-agreement` already implies it, and the child proves that below.
  assert.ok(!args.includes('--until-agreement'));
  assert.ok(!args.includes('--implementer'));
  assert.ok(!args.includes('--collaborative'));

  // The child parses these arguments, so assert the implication really holds
  // rather than trusting the flag name.
  const childOptions = parseArgs(args.slice(1), {
    initialCwd: temporaryDirectory,
    defaultOutput: join(temporaryDirectory, 'bridge-runs'),
  });
  assert.equal(childOptions.requireAgreement, true);
  assert.equal(childOptions.untilAgreement, true);
});

test('a chat-launched workflow forwards the resolved color choice', () => {
  const temporaryDirectory = tmpdir();
  const build = (color?: boolean): string[] => {
    const options = parseArgs(['chat'], {
      initialCwd: temporaryDirectory,
      defaultOutput: join(temporaryDirectory, 'bridge-runs'),
    });
    return buildWorkflowArguments(
      {
        mode: 'review',
        task: 'context',
        projectRoot: temporaryDirectory,
        options: { ...options, color },
      },
      join(temporaryDirectory, 'task.md'),
      'launcher',
    );
  };

  assert.ok(build(false).includes('--no-color'));
  assert.ok(build(true).includes('--color'));
  // An unstated choice leaves the child free to detect its own terminal.
  assert.ok(!build(undefined).includes('--color'));
  assert.ok(!build(undefined).includes('--no-color'));
});

test('runs paired exchanges, autonomous done decisions, and a linked workflow', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const prompts: string[] = [];
  const optionsSeen: ProviderRunOptions[] = [];
  const terminal = new ScriptedTerminal([
    '/paste',
    'Please review',
    'the design',
    '.',
    '/auto 2',
    'y',
    '/review',
    'y',
    '/done',
  ]);
  const launches: WorkflowLaunchRequest[] = [];
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const options = parseArgs(
      ['chat', '--cwd', project, '--max-rounds', '4', '--ui', 'enhanced'],
      {
        initialCwd: '/',
        defaultOutput: paths.runsDirectory,
      },
    );
    await runInteractiveChat({
      options,
      appPaths: paths,
      providers: fakeProviders(prompts, optionsSeen),
      terminal,
      terminalCapabilities: {
        stdinIsTty: true,
        stdoutIsTty: true,
        term: 'xterm-256color',
        columns: 100,
        rows: 24,
      },
      launchWorkflow: async (request) => {
        launches.push(request);
        return 0;
      },
    });

    const session = await new ChatSessionStore(paths.chatsDirectory).latest();
    assert.ok(session);
    assert.equal(session.status, 'completed');
    assert.deepEqual(
      session.messages.map((message) => message.role),
      ['user', 'codex', 'claude', 'claude', 'codex', 'claude', 'system'],
    );
    assert.equal(session.latestPairedExchange?.outcome, 'confirmed');
    assert.equal(session.workflows[0]?.mode, 'review');
    assert.equal(launches.length, 1);
    assert.equal(session.maxAutoRounds, 6);
    assert.equal(session.maxWorkflowRounds, 4);
    assert.equal(launches[0]?.options.maxRounds, 4);
    assert.equal(session.messages[0]?.text, 'Please review\nthe design');
    assert.match(launches[0]?.task ?? '', /Please review/);
    assert.ok(
      optionsSeen.every((providerOptions) => !providerOptions.writeAccess),
    );
    assert.match(prompts[1] ?? '', /current exchange/);
    assert.equal(terminal.pauses, 1);
    assert.equal(terminal.resumes, 1);
    assert.equal(terminal.queuedInputObserver, undefined);
    const output = terminal.output.join('');
    assert.match(output, /reciprocally marked this exchange done/);
    assert.doesNotMatch(output, /agree on the current answer/);
    assert.match(output, /Maximum provider calls: 6/);
    assert.match(output, /Workflow preview/);
    assert.match(output, /Estimated provider calls:/);
    const enhancedEntries = output.split('\u001B[?1049h').length - 1;
    const enhancedExits = output.split('\u001B[?1049l').length - 1;
    assert.ok(enhancedEntries > 2);
    assert.equal(enhancedEntries, enhancedExits);
    assert.ok(output.includes('\u001B[?1049l\nPaste or type multiple lines'));
    assert.match(output, /Workflow preview[\s\S]+\nWorkflow finished/);
    assert.match(output, /\nChat chat-.* completed\./);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('chat startup task files use the interactive message limit', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const taskFile = join(project, 'oversized-task.txt');
  const terminal = new ScriptedTerminal([]);
  try {
    await writeFile(taskFile, 'x'.repeat(MAX_USER_MESSAGE_CHARS + 1));
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const options = parseArgs(
      ['chat', '--cwd', project, '--task-file', taskFile],
      {
        initialCwd: '/',
        defaultOutput: paths.runsDirectory,
      },
    );

    await assert.rejects(
      () =>
        runInteractiveChat({
          options,
          appPaths: paths,
          providers: fakeProviders([], []),
          terminal,
        }),
      /Chat startup message exceeds 32,000 characters/,
    );
    assert.equal(
      await new ChatSessionStore(paths.chatsDirectory).latest(),
      null,
    );
    assert.equal(terminal.queuedInputObserver, undefined);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('/auto warns before reopening an already confirmed exchange', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  let calls = 0;
  const providers = providersWithRun(async () => {
    calls += 1;
    return { text: `done response ${calls}`, decision: 'done' };
  });
  const terminal = new ScriptedTerminal([
    'Review this',
    '/auto 1',
    'n',
    '/done',
  ]);
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const options = parseArgs(['chat', '--cwd', project, '--ui', 'plain'], {
      initialCwd: '/',
      defaultOutput: paths.runsDirectory,
    });

    await runInteractiveChat({ options, appPaths: paths, providers, terminal });

    assert.equal(calls, 3);
    assert.equal(
      (await new ChatSessionStore(paths.chatsDirectory).latest())
        ?.latestPairedExchange?.outcome,
      'confirmed',
    );
    assert.match(
      terminal.output.join(''),
      /latest exchange is already reciprocally confirmed; starting will deliberately open another exchange/i,
    );
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('a newer unanswered message clears live confirmation but keeps transcript history', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  let calls = 0;
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const store = new ChatSessionStore(paths.chatsDirectory);
    const providers = providersWithRun(async () => {
      calls += 1;
      if (calls === 4) {
        throw new ProcessAbortError();
      }
      return { text: `done response ${calls}`, decision: 'done' };
    });
    const terminal = new ScriptedTerminal([
      'Review this',
      'Now answer a different question',
      '/status',
      '/pause',
    ]);

    await runInteractiveChat({
      options: parseArgs(['chat', '--cwd', project, '--ui', 'plain'], {
        initialCwd: project,
        defaultOutput: paths.runsDirectory,
      }),
      appPaths: paths,
      providers,
      terminal,
    });

    assert.equal(calls, 4);
    const saved = await store.latest();
    assert.ok(saved);
    assert.equal(saved.status, 'paused');
    assert.equal(saved.latestPairedExchange?.outcome, 'confirmed');
    assert.deepEqual(
      saved.messages.map((message) => message.role),
      ['user', 'codex', 'claude', 'codex', 'user'],
    );
    assert.match(terminal.output.join(''), /Latest paired exchange: none yet/);
    assert.match(
      await readFile(store.transcriptPathFor(saved.id), 'utf8'),
      /Latest paired exchange: both agents reciprocally marked this exchange done/,
    );
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('/auto previews three-stage call bounds from either pending stage', async () => {
  for (const pendingStage of ['peer', 'confirmation'] as const) {
    const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
    const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
    let calls = 0;
    try {
      const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
      const providers = providersWithRun(async () => {
        calls += 1;
        const cancelledCall = pendingStage === 'peer' ? 2 : 3;
        if (calls === cancelledCall) {
          throw new ProcessAbortError();
        }
        return { text: `done response ${calls}`, decision: 'done' };
      });
      const terminal = new ScriptedTerminal([
        'Review this',
        '/auto 2',
        'yes',
        '/done',
      ]);

      await runInteractiveChat({
        options: parseArgs(['chat', '--cwd', project, '--ui', 'plain'], {
          initialCwd: project,
          defaultOutput: paths.runsDirectory,
        }),
        appPaths: paths,
        providers,
        terminal,
      });

      assert.match(
        terminal.output.join(''),
        new RegExp(
          `Maximum provider calls: ${pendingStage === 'peer' ? 5 : 4}`,
        ),
      );
      assert.match(
        terminal.output.join(''),
        /stops early only after reciprocal confirmation/i,
      );
      assert.equal(calls, 4);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  }
});

test('/auto labels a legacy two-done pair unconfirmed', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  let providerCalls = 0;
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const store = new ChatSessionStore(paths.chatsDirectory);
    const now = '2026-08-09T00:00:00.000Z';
    const session: ChatSession = {
      version: 4,
      id: 'chat-legacy-done-pair',
      createdAt: now,
      updatedAt: now,
      status: 'paused',
      projectRoot: project,
      projectKind: 'directory',
      maxAutoRounds: 6,
      maxWorkflowRounds: 6,
      retries: 1,
      timeoutMinutes: 30,
      noTranscript: false,
      ui: 'plain',
      messages: [
        { sequence: 1, createdAt: now, role: 'user', text: 'Review this' },
        {
          sequence: 2,
          createdAt: now,
          role: 'codex',
          text: 'Legacy first',
          decision: 'done',
        },
        {
          sequence: 3,
          createdAt: now,
          role: 'claude',
          text: 'Legacy second',
          decision: 'done',
        },
      ],
      workflows: [],
    };
    await store.save(session);
    const terminal = new ScriptedTerminal(['/auto 1', 'no', '/pause']);

    await runInteractiveChat({
      options: parseArgs(['chat', '--resume', session.id], {
        initialCwd: project,
        defaultOutput: paths.runsDirectory,
      }),
      appPaths: paths,
      providers: providersWithRun(async () => {
        providerCalls += 1;
        return { text: 'unused', decision: 'continue' };
      }),
      terminal,
    });

    assert.equal(providerCalls, 0);
    assert.match(
      terminal.output.join(''),
      /legacy pair has two done decisions but is not reciprocally confirmed/i,
    );
    assert.match(terminal.output.join(''), /Maximum provider calls: 3/);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('/auto stops immediately on cancellation or provider failure at every stage', async () => {
  for (const interruption of ['cancel', 'failure'] as const) {
    for (const stage of ['first', 'peer', 'confirmation'] as const) {
      const project = await mkdtemp(
        join(tmpdir(), 'agent-bridge-chat-project-'),
      );
      const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
      let calls = 0;
      try {
        const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
        const targetCall = { first: 3, peer: 4, confirmation: 5 }[stage];
        const providers = providersWithRun(async () => {
          calls += 1;
          if (calls === targetCall) {
            if (interruption === 'cancel') {
              throw new ProcessAbortError();
            }
            throw new Error(`permanent ${stage} failure`);
          }
          return {
            text: `response ${calls}`,
            decision:
              stage === 'confirmation' && calls >= 3 ? 'done' : 'continue',
          };
        });
        const terminal = new ScriptedTerminal([
          'Review this',
          '/auto 3',
          'yes',
          '/pause',
        ]);

        await runInteractiveChat({
          options: parseArgs(['chat', '--cwd', project, '--ui', 'plain'], {
            initialCwd: project,
            defaultOutput: paths.runsDirectory,
          }),
          appPaths: paths,
          providers,
          terminal,
        });

        assert.equal(calls, targetCall);
        const saved = await new ChatSessionStore(paths.chatsDirectory).latest();
        assert.equal(saved?.status, 'paused');
        assert.equal(
          saved?.pendingExchange?.stage,
          stage === 'first'
            ? undefined
            : stage === 'peer'
              ? 'awaiting-peer'
              : 'awaiting-confirmation',
        );
        assert.match(
          terminal.output.join(''),
          interruption === 'cancel'
            ? /Active agent work cancelled/
            : new RegExp(`permanent ${stage} failure`),
        );
        assert.doesNotMatch(
          terminal.output.join(''),
          /Automatic exchange limit reached/,
        );
      } finally {
        await rm(project, { recursive: true, force: true });
        await rm(home, { recursive: true, force: true });
      }
    }
  }
});

test('/auto counts a continue confirmation as one exchange and starts the next', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  let calls = 0;
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const providers = providersWithRun(async () => {
      calls += 1;
      const decision =
        calls <= 2 || calls === 5 ? ('continue' as const) : ('done' as const);
      return { text: `response ${calls}`, decision };
    });
    const terminal = new ScriptedTerminal([
      'Review this',
      '/auto 2',
      'yes',
      '/done',
    ]);

    await runInteractiveChat({
      options: parseArgs(['chat', '--cwd', project, '--ui', 'plain'], {
        initialCwd: project,
        defaultOutput: paths.runsDirectory,
      }),
      appPaths: paths,
      providers,
      terminal,
    });

    assert.equal(calls, 8);
    assert.match(terminal.output.join(''), /Automatic exchange 1\/2/);
    assert.match(terminal.output.join(''), /Automatic exchange 2\/2/);
    const completed = await new ChatSessionStore(paths.chatsDirectory).latest();
    assert.equal(completed?.latestPairedExchange?.outcome, 'confirmed');
    assert.equal(completed?.status, 'completed');
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('chat explains that editing needs an initial commit', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-unborn-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const launches: WorkflowLaunchRequest[] = [];
  try {
    await execFileAsync('git', ['init'], { cwd: project });
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const terminal = new ScriptedTerminal([
      'Please implement this',
      '/edit',
      '/done',
    ]);
    const options = parseArgs(['chat', '--cwd', project], {
      initialCwd: '/',
      defaultOutput: paths.runsDirectory,
    });

    await runInteractiveChat({
      options,
      appPaths: paths,
      providers: fakeProviders([], []),
      terminal,
      launchWorkflow: async (request) => {
        launches.push(request);
        return 0;
      },
    });

    assert.equal(launches.length, 0);
    assert.match(terminal.output.join(''), /requires an initial commit/);
    assert.match(terminal.output.join(''), /will not stage or commit/);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('no-transcript chat deletes its successful local checkpoint', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const options = parseArgs(['chat', '--cwd', project, '--no-transcript'], {
      initialCwd: '/',
      defaultOutput: paths.runsDirectory,
    });
    await runInteractiveChat({
      options,
      appPaths: paths,
      providers: fakeProviders([], []),
      terminal: new ScriptedTerminal(['/done']),
    });
    assert.equal(
      await new ChatSessionStore(paths.chatsDirectory).latest(),
      null,
    );
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('keeps supplemental enhanced-mode commands readable on the normal screen', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const terminal = new ScriptedTerminal([
    '/help',
    '/status',
    '/history 1',
    '/done',
  ]);
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const options = parseArgs(['chat', '--cwd', project, '--ui', 'enhanced'], {
      initialCwd: '/',
      defaultOutput: paths.runsDirectory,
    });
    await runInteractiveChat({
      options,
      appPaths: paths,
      providers: fakeProviders([], []),
      terminal,
      terminalCapabilities: {
        stdinIsTty: true,
        stdoutIsTty: true,
        term: 'xterm-256color',
        columns: 100,
        rows: 24,
      },
    });

    const output = terminal.output.join('');
    assert.ok(output.includes('\u001B[?1049l\nInteractive chat commands'));
    assert.match(output, /Interactive chat commands[\s\S]+\nSession:/);
    assert.match(output, /Presentation: enhanced terminal/);
    assert.match(
      output,
      /Presentation: enhanced terminal[\s\S]+No messages yet\./,
    );
    const entries = output.split('\u001B[?1049h').length - 1;
    const exits = output.split('\u001B[?1049l').length - 1;
    assert.equal(entries, 1);
    assert.equal(entries, exits);
    assert.equal(terminal.closes, 1);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('reveals complete enhanced responses in native terminal scrollback', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const terminal = new ScriptedTerminal([
    '/ask codex give a long response',
    '/ask claude give another response',
    '/done',
  ]);
  const codexResponse = [
    'codex-first-marker',
    ...Array.from({ length: 80 }, (_, index) => `codex-line-${index + 1}`),
    'codex-last-marker',
  ].join('\n');
  const claudeResponse = 'claude-complete-response';
  let calls = 0;
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const options = parseArgs(['chat', '--cwd', project, '--ui', 'enhanced'], {
      initialCwd: '/',
      defaultOutput: paths.runsDirectory,
    });
    await runInteractiveChat({
      options,
      appPaths: paths,
      providers: providersWithRun(async () => {
        calls += 1;
        return {
          text: calls === 1 ? codexResponse : claudeResponse,
          decision: 'done',
        };
      }),
      terminal,
      terminalCapabilities: ENHANCED_TERMINAL_CAPABILITIES,
    });

    const output = terminal.output.join('');
    const firstReveal = output.indexOf('\u001B[?1049l\nCodex [done]\n─────\n');
    const resumedActivity = output.indexOf('\u001B[?1049h', firstReveal + 1);
    const secondReveal = output.indexOf(
      '\u001B[?1049l\nClaude [done]\n──────\n',
      resumedActivity + 1,
    );
    assert.ok(firstReveal >= 0);
    assert.ok(resumedActivity > firstReveal);
    assert.ok(secondReveal > resumedActivity);
    const firstNormalScreen = output.slice(firstReveal, resumedActivity);
    assert.match(firstNormalScreen, /codex-first-marker/);
    assert.match(firstNormalScreen, /codex-last-marker/);
    assert.match(output.slice(secondReveal), /claude-complete-response/);
    assert.equal(terminal.closes, 1);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('runs a targeted accessible turn without disturbing paired rotation', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const prompts: string[] = [];
  const optionsSeen: ProviderRunOptions[] = [];
  const terminal = new ScriptedTerminal([
    '/ask claude Inspect this only',
    'Now ask both',
    '/done',
  ]);
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const options = parseArgs(
      ['chat', '--cwd', project, '--screen-reader', '--ui', 'enhanced'],
      {
        initialCwd: '/',
        defaultOutput: paths.runsDirectory,
      },
    );
    await runInteractiveChat({
      options,
      appPaths: paths,
      providers: fakeProviders(prompts, optionsSeen),
      terminal,
      terminalCapabilities: {
        stdinIsTty: true,
        stdoutIsTty: true,
        term: 'xterm-256color',
        columns: 100,
        rows: 24,
      },
    });

    const session = await new ChatSessionStore(paths.chatsDirectory).latest();
    assert.deepEqual(
      session?.messages.map((message) => message.role),
      ['user', 'claude', 'user', 'codex', 'claude'],
    );
    assert.match(session?.messages[0]?.text ?? '', /Addressed to Claude/);
    assert.equal(optionsSeen.length, 3);
    assert.equal(optionsSeen[0]?.screenReader, true);
    assert.match(prompts[0] ?? '', /You are Claude/);
    assert.match(prompts[1] ?? '', /You are Codex/);
    assert.match(prompts[2] ?? '', /You are Claude/);
    assert.equal(session?.nextFirstAgent, 'claude');
    assert.match(terminal.output.join(''), /Claude response\. Decision:/);
    assert.match(
      terminal.output.join(''),
      /Claude progress update\.\nclaude live progress/,
    );
    assert.match(
      terminal.output.join(''),
      /Claude status: searching the project/,
    );
    assert.doesNotMatch(terminal.output.join(''), /─/);
    assert.equal(terminal.output.join('').includes('\u001B[?1049h'), false);
    assert.match(terminal.output.join(''), /Screen-reader mode/);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('keeps the chat usable when a linked workflow cannot start', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const terminal = new ScriptedTerminal([
    'Review this',
    '/review',
    'y',
    '/done',
  ]);
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const options = parseArgs(['chat', '--cwd', project], {
      initialCwd: '/',
      defaultOutput: paths.runsDirectory,
    });
    await runInteractiveChat({
      options,
      appPaths: paths,
      providers: fakeProviders([], []),
      terminal,
      launchWorkflow: async () => {
        throw new Error('launcher unavailable');
      },
    });
    const session = await new ChatSessionStore(paths.chatsDirectory).latest();
    assert.equal(session?.status, 'completed');
    assert.equal(session?.workflows[0]?.exitCode, 1);
    assert.equal(terminal.pauses, 1);
    assert.equal(terminal.resumes, 1);
    const output = terminal.output.join('');
    assert.match(output, /launcher unavailable/);
    assert.match(output, /Ordinary messages discuss and review/);
    assert.match(output, /make safe changes, use \/edit/);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('chat editing preflight carries explicit dirty and verification approvals', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-git-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const launches: WorkflowLaunchRequest[] = [];
  try {
    await execFileAsync('git', ['init'], { cwd: project });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: project,
    });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], {
      cwd: project,
    });
    await writeFile(join(project, 'tracked.txt'), 'committed\n');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: project });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: project });
    await writeFile(join(project, 'tracked.txt'), 'local change\n');
    await writeFile(
      join(project, '.agent-bridge.json'),
      JSON.stringify({
        version: 1,
        verification: [{ command: 'npm', args: ['test'] }],
        protectedPaths: [],
      }),
    );

    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const terminal = new ScriptedTerminal([
      'Implement the change',
      '/edit',
      'yes',
      'yes',
      'yes',
      '/done',
    ]);
    await runInteractiveChat({
      options: parseArgs(['chat', '--cwd', project], {
        initialCwd: '/',
        defaultOutput: paths.runsDirectory,
      }),
      appPaths: paths,
      providers: fakeProviders([], []),
      terminal,
      launchWorkflow: async (request) => {
        launches.push(request);
        return 0;
      },
    });

    assert.equal(launches.length, 1);
    assert.equal(launches[0]?.mode, 'collaborative');
    assert.equal(launches[0]?.firstAgent, 'claude');
    assert.equal(launches[0]?.options.fromHead, true);
    assert.equal(launches[0]?.options.trustProjectConfig, true);
    const output = terminal.output.join('');
    assert.match(output, /starts from committed HEAD/);
    assert.match(output, /npm test/);
    assert.match(output, /Workflow preview/);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

/**
 * End of input is not consent. Each case stops the scripted input exactly at
 * one confirmation, and the confirmation under test must be the last thing the
 * session asks: anything after it means end of input was answered rather than
 * obeyed. The start question is the case that mattered most, because its
 * default is yes and folding end of input into it launched an editing workflow.
 */
for (const confirmation of [
  {
    name: 'the dirty-tree acknowledgement',
    answers: [] as string[],
    prompt: /Continue explicitly from committed HEAD/,
  },
  {
    name: 'the verification-command approval',
    answers: ['yes'],
    prompt: /Allow these commands to run after edits/,
  },
  {
    name: 'the workflow start question',
    answers: ['yes', 'yes'],
    prompt: /Start this workflow/,
  },
]) {
  test(`end of input at ${confirmation.name} pauses without editing`, async () => {
    const project = await editingProjectWithVerification();
    const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
    const launches: WorkflowLaunchRequest[] = [];
    try {
      const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
      const terminal = new ScriptedTerminal([
        'Implement the change',
        '/edit',
        ...confirmation.answers,
      ]);
      await runInteractiveChat({
        options: parseArgs(['chat', '--cwd', project], {
          initialCwd: '/',
          defaultOutput: paths.runsDirectory,
        }),
        appPaths: paths,
        providers: fakeProviders([], []),
        terminal,
        launchWorkflow: async (request) => {
          launches.push(request);
          return 0;
        },
      });

      assert.equal(launches.length, 0);
      assert.match(
        terminal.prompts.at(-1) ?? '',
        confirmation.prompt,
        'the session kept asking after end of input',
      );
      assert.match(terminal.output.join(''), /Chat saved\. Resume with:/);
      const saved = await new ChatSessionStore(paths.chatsDirectory).latest();
      assert.equal(saved?.status, 'paused');
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  });
}

test('end of input at the automatic-conversation question runs no exchanges', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  let calls = 0;
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const providers = providersWithRun(async () => {
      calls += 1;
      return { text: `answer ${calls}`, decision: 'continue' as const };
    });
    const terminal = new ScriptedTerminal(['Discuss this', '/auto']);

    await runInteractiveChat({
      options: parseArgs(['chat', '--cwd', project, '--ui', 'plain'], {
        initialCwd: project,
        defaultOutput: paths.runsDirectory,
      }),
      appPaths: paths,
      providers,
      terminal,
    });

    // Only the opening exchange for the typed message; the confirmation that
    // would have authorized up to six more never received an answer.
    assert.equal(calls, 2);
    assert.match(terminal.prompts.at(-1) ?? '', /Start automatic conversation/);
    const saved = await new ChatSessionStore(paths.chatsDirectory).latest();
    assert.equal(saved?.status, 'paused');
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

/**
 * `/done` with unfinished provider work defaults to no, so end of input was
 * already safe here by accident rather than by rule. Asserting it directly
 * means a later change to that default cannot quietly turn a closed stdin into
 * a completed chat that discards the exchange as abandoned.
 */
test('end of input at the /done confirmation abandons nothing', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  let calls = 0;
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const providers = providersWithRun(async () => {
      calls += 1;
      // Two `done` responses reach the reciprocal-confirmation stage; the
      // third call is interrupted, so the exchange stays pending.
      if (calls === 3) {
        throw new ProcessAbortError();
      }
      return { text: `done answer ${calls}`, decision: 'done' as const };
    });
    const terminal = new ScriptedTerminal(['Discuss this', '/done']);

    await runInteractiveChat({
      options: parseArgs(['chat', '--cwd', project, '--ui', 'plain'], {
        initialCwd: project,
        defaultOutput: paths.runsDirectory,
      }),
      appPaths: paths,
      providers,
      terminal,
    });

    const saved = await new ChatSessionStore(paths.chatsDirectory).latest();
    assert.equal(saved?.status, 'paused');
    assert.equal(saved?.pendingExchange?.stage, 'awaiting-confirmation');
    assert.equal(saved?.latestPairedExchange, undefined);
    assert.match(
      terminal.prompts.at(-1) ?? '',
      /Complete this chat without Codex's reciprocal confirmation/,
    );
    // Paused at the question rather than falling through its "no" branch.
    assert.doesNotMatch(terminal.output.join(''), /Completion cancelled/);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('an unrecognized confirmation answer is re-asked, not read as no', async () => {
  const project = await editingProjectWithVerification();
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const launches: WorkflowLaunchRequest[] = [];
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const terminal = new ScriptedTerminal([
      'Implement the change',
      '/edit',
      'maybe', // not y or n: asked again rather than cancelling
      'yes', // continue from committed HEAD
      'no', // verification commands stay unapproved
      'later', // not y or n: asked again rather than starting
      'y', // start the workflow
      '/done',
    ]);

    await runInteractiveChat({
      options: parseArgs(['chat', '--cwd', project], {
        initialCwd: '/',
        defaultOutput: paths.runsDirectory,
      }),
      appPaths: paths,
      providers: fakeProviders([], []),
      terminal,
      launchWorkflow: async (request) => {
        launches.push(request);
        return 0;
      },
    });

    assert.equal(launches.length, 1);
    assert.equal(launches[0]?.options.fromHead, true);
    assert.equal(launches[0]?.options.trustProjectConfig, false);
    assert.equal(
      terminal.prompts.filter((prompt) =>
        prompt.startsWith('Please enter y or n.'),
      ).length,
      2,
    );
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('an empty confirmation answer still takes the stated default', async () => {
  const project = await editingProjectWithVerification();
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const launches: WorkflowLaunchRequest[] = [];
  let calls = 0;
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const providers = providersWithRun(async () => {
      calls += 1;
      return { text: `answer ${calls}`, decision: 'continue' as const };
    });
    // The dirty-tree question defaults to no, so an empty answer cancels
    // editing; the automatic-conversation question defaults to yes, so an
    // empty answer starts its single permitted exchange.
    const terminal = new ScriptedTerminal([
      'Implement the change',
      '/edit',
      '',
      '/auto',
      '',
    ]);

    await runInteractiveChat({
      options: parseArgs(
        ['chat', '--cwd', project, '--ui', 'plain', '--max-auto-rounds', '1'],
        { initialCwd: '/', defaultOutput: paths.runsDirectory },
      ),
      appPaths: paths,
      providers,
      terminal,
      launchWorkflow: async (request) => {
        launches.push(request);
        return 0;
      },
    });

    assert.equal(launches.length, 0);
    const output = terminal.output.join('');
    assert.match(output, /Editing cancelled/);
    // Two calls for the opening exchange, two more for the accepted round.
    assert.equal(calls, 4);
    assert.match(output, /Automatic exchange limit reached/);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('provider failure returns to the prompt and resume completes without repeating saved responses', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const called: string[] = [];
  const provider = (
    name: 'codex' | 'claude',
    fail: boolean,
  ): AgentProvider => ({
    name,
    label: name,
    version: async () => ({ stdout: 'test', stderr: '', exitCode: 0 }),
    authStatus: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    run: async () => {
      called.push(name);
      if (fail) {
        throw new Error('interrupted peer');
      }
      return { text: `${name} response`, decision: 'done' };
    },
  });
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const options = parseArgs(['chat', '--cwd', project], {
      initialCwd: '/',
      defaultOutput: paths.runsDirectory,
    });
    const failedTerminal = new ScriptedTerminal(['Inspect this']);
    await runInteractiveChat({
      options,
      appPaths: paths,
      providers: {
        codex: provider('codex', false),
        claude: provider('claude', true),
      },
      terminal: failedTerminal,
    });
    const paused = await new ChatSessionStore(paths.chatsDirectory).latest();
    assert.ok(paused?.pendingExchange);
    assert.deepEqual(called, ['codex', 'claude']);
    assert.match(failedTerminal.output.join(''), /checkpoint is unchanged/);

    const resumeOptions = parseArgs(['chat', '--resume', paused.id], {
      initialCwd: project,
      defaultOutput: paths.runsDirectory,
    });
    await runInteractiveChat({
      options: resumeOptions,
      appPaths: paths,
      providers: {
        codex: provider('codex', false),
        claude: provider('claude', false),
      },
      terminal: new ScriptedTerminal(['/done']),
    });

    const completed = await new ChatSessionStore(paths.chatsDirectory).load(
      paused.id,
    );
    assert.deepEqual(called, ['codex', 'claude', 'claude', 'codex']);
    assert.equal(completed.pendingExchange, undefined);
    assert.equal(completed.latestPairedExchange?.outcome, 'confirmed');
    assert.equal(completed.status, 'completed');
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('resume routes awaiting confirmation only to the original first agent', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  let providerCalls = 0;
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const store = new ChatSessionStore(paths.chatsDirectory);
    const now = '2026-08-09T00:00:00.000Z';
    const session: ChatSession = {
      version: 4,
      id: 'chat-awaiting-confirmation',
      createdAt: now,
      updatedAt: now,
      status: 'paused',
      projectRoot: project,
      projectKind: 'directory',
      maxAutoRounds: 6,
      maxWorkflowRounds: 6,
      retries: 1,
      timeoutMinutes: 30,
      noTranscript: false,
      ui: 'plain',
      pendingExchange: {
        stage: 'awaiting-confirmation',
        firstAgent: 'codex',
        secondAgent: 'claude',
        firstMessageSequence: 2,
        secondMessageSequence: 3,
      },
      messages: [
        { sequence: 1, createdAt: now, role: 'user', text: 'Inspect this' },
        {
          sequence: 2,
          createdAt: now,
          role: 'codex',
          text: 'Codex answer',
          decision: 'done',
        },
        {
          sequence: 3,
          createdAt: now,
          role: 'claude',
          text: 'Claude answer',
          decision: 'done',
        },
      ],
      workflows: [],
    };
    await store.save(session);
    const prompts: string[] = [];
    const providers = providersWithRun(async (prompt) => {
      providerCalls += 1;
      prompts.push(prompt);
      return { text: 'confirmation response', decision: 'continue' };
    });

    await runInteractiveChat({
      options: parseArgs(['chat', '--resume', session.id], {
        initialCwd: project,
        defaultOutput: paths.runsDirectory,
      }),
      appPaths: paths,
      providers,
      terminal: new ScriptedTerminal(['/pause']),
    });

    assert.equal(providerCalls, 1);
    assert.match(prompts[0] ?? '', /You are Codex/);
    assert.match(prompts[0] ?? '', /reciprocal confirmation/);
    assert.match(prompts[0] ?? '', /Codex answer/);
    assert.match(prompts[0] ?? '', /Claude answer/);
    const resumed = await store.load(session.id);
    assert.equal(resumed.pendingExchange, undefined);
    assert.equal(resumed.latestPairedExchange?.outcome, 'open');
    assert.equal(resumed.latestPairedExchange?.confirmationMessageSequence, 4);
    assert.equal(resumed.nextFirstAgent, 'claude');
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('cancelling reciprocal confirmation preserves and resumes only that stage', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const called: string[] = [];
  const provider = (
    name: 'codex' | 'claude',
    cancelThird: boolean,
  ): AgentProvider => ({
    name,
    label: name,
    version: async () => ({ stdout: 'test', stderr: '', exitCode: 0 }),
    authStatus: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    run: async (prompt) => {
      called.push(name);
      if (cancelThird && called.length === 3) {
        assert.match(prompt, /reciprocal confirmation/);
        throw new ProcessAbortError();
      }
      return { text: `${name} response`, decision: 'done' };
    },
  });
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const store = new ChatSessionStore(paths.chatsDirectory);
    await runInteractiveChat({
      options: parseArgs(['chat', '--cwd', project, '--ui', 'plain'], {
        initialCwd: project,
        defaultOutput: paths.runsDirectory,
      }),
      appPaths: paths,
      providers: {
        codex: provider('codex', true),
        claude: provider('claude', true),
      },
      terminal: new ScriptedTerminal(['Review this', '/pause']),
    });

    const paused = await store.latest();
    assert.ok(paused);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.pendingExchange?.stage, 'awaiting-confirmation');
    assert.deepEqual(called, ['codex', 'claude', 'codex']);

    await runInteractiveChat({
      options: parseArgs(['chat', '--resume', paused.id], {
        initialCwd: project,
        defaultOutput: paths.runsDirectory,
      }),
      appPaths: paths,
      providers: {
        codex: provider('codex', false),
        claude: provider('claude', false),
      },
      terminal: new ScriptedTerminal(['/pause']),
    });

    assert.deepEqual(called, ['codex', 'claude', 'codex', 'codex']);
    const settled = await store.load(paused.id);
    assert.equal(settled.pendingExchange, undefined);
    assert.equal(settled.latestPairedExchange?.outcome, 'confirmed');
    assert.deepEqual(
      settled.messages.map((message) => message.role),
      ['user', 'codex', 'claude', 'codex'],
    );
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('checkpoints both provisional done responses before reciprocal confirmation', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const prompts: string[] = [];
  let calls = 0;
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const store = new ChatSessionStore(paths.chatsDirectory);
    const providers = providersWithRun(async (prompt) => {
      calls += 1;
      prompts.push(prompt);
      if (calls === 2) {
        const checkpoint = await store.latest();
        assert.equal(checkpoint?.pendingExchange?.stage, 'awaiting-peer');
        assert.deepEqual(
          checkpoint?.messages.map((message) => message.role),
          ['user', 'codex'],
        );
      }
      if (calls === 3) {
        const checkpoint = await store.latest();
        assert.equal(
          checkpoint?.pendingExchange?.stage,
          'awaiting-confirmation',
        );
        assert.deepEqual(
          checkpoint?.messages.map((message) => message.role),
          ['user', 'codex', 'claude'],
        );
      }
      return { text: `done response ${calls}`, decision: 'done' };
    });

    await runInteractiveChat({
      options: parseArgs(['chat', '--cwd', project, '--ui', 'plain'], {
        initialCwd: project,
        defaultOutput: paths.runsDirectory,
      }),
      appPaths: paths,
      providers,
      terminal: new ScriptedTerminal(['Review this', '/done']),
    });

    assert.equal(calls, 3);
    assert.match(prompts[1] ?? '', /current exchange/);
    assert.match(prompts[2] ?? '', /reciprocal confirmation/);
    assert.match(prompts[2] ?? '', /done response 1/);
    assert.match(prompts[2] ?? '', /done response 2/);
    const completed = await store.latest();
    assert.equal(completed?.pendingExchange, undefined);
    assert.deepEqual(completed?.latestPairedExchange, {
      firstAgent: 'codex',
      secondAgent: 'claude',
      firstMessageSequence: 2,
      secondMessageSequence: 3,
      confirmationMessageSequence: 4,
      outcome: 'confirmed',
    });
    assert.equal(completed?.nextFirstAgent, 'claude');
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('a continue confirmation stays open and rotates the next lead to the peer', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  let calls = 0;
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const store = new ChatSessionStore(paths.chatsDirectory);
    const providers = providersWithRun(async (prompt) => {
      calls += 1;
      if (calls === 4) {
        const checkpoint = await store.latest();
        assert.deepEqual(checkpoint?.latestPairedExchange, {
          firstAgent: 'codex',
          secondAgent: 'claude',
          firstMessageSequence: 2,
          secondMessageSequence: 3,
          confirmationMessageSequence: 4,
          outcome: 'open',
        });
        assert.equal(checkpoint?.nextFirstAgent, 'claude');
        assert.match(prompt, /You are Claude/);
      }
      return {
        text: `response ${calls}`,
        decision: calls <= 2 ? 'done' : 'continue',
      };
    });

    await runInteractiveChat({
      options: parseArgs(['chat', '--cwd', project, '--ui', 'plain'], {
        initialCwd: project,
        defaultOutput: paths.runsDirectory,
      }),
      appPaths: paths,
      providers,
      terminal: new ScriptedTerminal(['Review this', 'Follow up', '/done']),
    });

    assert.equal(calls, 5);
    assert.deepEqual(
      (await store.latest())?.messages.map((message) => message.role),
      ['user', 'codex', 'claude', 'codex', 'user', 'claude', 'codex'],
    );
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('/done can atomically abandon either unfinished exchange stage', async () => {
  for (const failureStage of ['peer', 'confirmation'] as const) {
    const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
    const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
    let calls = 0;
    try {
      const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
      const providers = providersWithRun(async () => {
        calls += 1;
        if (
          (failureStage === 'peer' && calls === 2) ||
          (failureStage === 'confirmation' && calls === 3)
        ) {
          throw new Error(`${failureStage} unavailable`);
        }
        return { text: `done ${calls}`, decision: 'done' };
      });
      const terminal = new ScriptedTerminal(['Review this', '/done', 'yes']);

      await runInteractiveChat({
        options: parseArgs(['chat', '--cwd', project, '--ui', 'plain'], {
          initialCwd: project,
          defaultOutput: paths.runsDirectory,
        }),
        appPaths: paths,
        providers,
        terminal,
      });

      const completed = await new ChatSessionStore(
        paths.chatsDirectory,
      ).latest();
      assert.equal(completed?.status, 'completed');
      assert.equal(completed?.pendingExchange, undefined);
      assert.deepEqual(completed?.latestPairedExchange, {
        firstAgent: 'codex',
        secondAgent: 'claude',
        firstMessageSequence: 2,
        ...(failureStage === 'confirmation'
          ? { secondMessageSequence: 3 }
          : {}),
        outcome: 'abandoned',
      });
      assert.equal(completed?.nextFirstAgent, 'claude');
      assert.match(
        terminal.prompts.join(''),
        failureStage === 'peer'
          ? /without Claude's peer response/
          : /without Codex's reciprocal confirmation/,
      );
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  }
});

test('declining pending /done leaves the unfinished checkpoint unchanged', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  let calls = 0;
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const providers = providersWithRun(async () => {
      calls += 1;
      if (calls === 2) {
        throw new Error('peer unavailable');
      }
      return { text: 'first response', decision: 'continue' };
    });
    const terminal = new ScriptedTerminal([
      'Review this',
      '/done',
      'no',
      '/pause',
    ]);

    await runInteractiveChat({
      options: parseArgs(['chat', '--cwd', project, '--ui', 'plain'], {
        initialCwd: project,
        defaultOutput: paths.runsDirectory,
      }),
      appPaths: paths,
      providers,
      terminal,
    });

    const paused = await new ChatSessionStore(paths.chatsDirectory).latest();
    assert.equal(paused?.status, 'paused');
    assert.deepEqual(paused?.pendingExchange, {
      stage: 'awaiting-peer',
      firstAgent: 'codex',
      secondAgent: 'claude',
      firstMessageSequence: 2,
    });
    assert.equal(paused?.latestPairedExchange, undefined);
    assert.match(terminal.output.join(''), /Completion cancelled/);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('failed /done abandonment leaves the authoritative pending checkpoint intact', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  let calls = 0;
  let sabotaged = false;
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const store = new ChatSessionStore(paths.chatsDirectory);
    const terminal = new PromptHookTerminal(
      ['Review this', '/done', 'yes'],
      async (prompt) => {
        if (!sabotaged && prompt.includes('Complete this chat without')) {
          const session = await store.latest();
          assert.ok(session);
          await rm(store.transcriptPathFor(session.id), { force: true });
          await mkdir(store.transcriptPathFor(session.id));
          sabotaged = true;
        }
      },
    );

    await assert.rejects(
      runInteractiveChat({
        options: parseArgs(['chat', '--cwd', project, '--ui', 'plain'], {
          initialCwd: project,
          defaultOutput: paths.runsDirectory,
        }),
        appPaths: paths,
        providers: providersWithRun(async () => {
          calls += 1;
          if (calls === 2) {
            throw new Error('peer unavailable');
          }
          return { text: 'first response', decision: 'continue' };
        }),
        terminal,
      }),
    );

    assert.equal(sabotaged, true);
    const checkpoint = await store.latest();
    assert.equal(checkpoint?.status, 'active');
    assert.deepEqual(checkpoint?.pendingExchange, {
      stage: 'awaiting-peer',
      firstAgent: 'codex',
      secondAgent: 'claude',
      firstMessageSequence: 2,
    });
    assert.equal(checkpoint?.latestPairedExchange, undefined);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('a new message finishes the outstanding peer reply before its own exchange', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const called: string[] = [];
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const providers = providersWithRun(async () => {
      // Cancelling the peer half of a paired exchange leaves it outstanding.
      if (called.length === 1) {
        called.push('cancelled');
        throw new ProcessAbortError();
      }
      called.push('answered');
      return { text: `answer ${called.length}`, decision: 'continue' };
    });
    const terminal = new ScriptedTerminal([
      'Inspect this',
      '@codex follow up',
      '/pause',
    ]);
    const options = parseArgs(['chat', '--cwd', project, '--ui', 'plain'], {
      initialCwd: project,
      defaultOutput: paths.runsDirectory,
    });

    await runInteractiveChat({ options, appPaths: paths, providers, terminal });

    const saved = await new ChatSessionStore(paths.chatsDirectory).latest();
    assert.equal(saved?.status, 'paused');
    assert.equal(saved?.pendingExchange, undefined);
    // The interrupted exchange completes with its own history first, so the new
    // targeted message is never folded into it and gets its own turn.
    assert.deepEqual(
      saved?.messages.map((message) => message.role),
      ['user', 'codex', 'claude', 'user', 'codex'],
    );
    assert.match(saved?.messages[3]?.text ?? '', /follow up/);
    // Four provider calls: the pair, the cancelled half retried, then Codex.
    assert.equal(called.length, 4);
    const output = terminal.output.join('');
    assert.match(output, /Finishing Claude's outstanding peer response/);
    assert.match(output, /Chat saved/);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('a linked workflow settles the outstanding peer reply before preflight', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const launches: WorkflowLaunchRequest[] = [];
  let calls = 0;
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const providers = providersWithRun(async () => {
      calls += 1;
      if (calls === 2) {
        throw new ProcessAbortError();
      }
      return { text: `answer ${calls}`, decision: 'continue' };
    });
    const terminal = new ScriptedTerminal([
      'Inspect this',
      '/review',
      'yes',
      '/done',
    ]);
    const options = parseArgs(['chat', '--cwd', project, '--ui', 'plain'], {
      initialCwd: project,
      defaultOutput: paths.runsDirectory,
    });

    await runInteractiveChat({
      options,
      appPaths: paths,
      providers,
      terminal,
      launchWorkflow: async (request) => {
        launches.push(request);
        return 0;
      },
    });

    const saved = await new ChatSessionStore(paths.chatsDirectory).latest();
    assert.equal(calls, 3);
    assert.equal(launches.length, 1);
    assert.equal(launches[0]?.mode, 'review');
    assert.equal(saved?.pendingExchange, undefined);
    assert.deepEqual(
      saved?.messages.map((entry) => entry.role),
      ['user', 'codex', 'claude', 'system'],
    );
    assert.match(
      launches[0]?.task ?? '',
      /claude[\s\S]+answer 3/i,
      'the workflow receives the settled peer response',
    );
    assert.match(terminal.output.join(''), /Finishing Claude's outstanding/);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('a linked workflow settles reciprocal confirmation before preflight', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const launches: WorkflowLaunchRequest[] = [];
  let calls = 0;
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const providers = providersWithRun(async () => {
      calls += 1;
      if (calls === 3) {
        throw new ProcessAbortError();
      }
      return { text: `done answer ${calls}`, decision: 'done' };
    });
    const terminal = new ScriptedTerminal([
      'Inspect this',
      '/review',
      'yes',
      '/done',
    ]);

    await runInteractiveChat({
      options: parseArgs(['chat', '--cwd', project, '--ui', 'plain'], {
        initialCwd: project,
        defaultOutput: paths.runsDirectory,
      }),
      appPaths: paths,
      providers,
      terminal,
      launchWorkflow: async (request) => {
        launches.push(request);
        return 0;
      },
    });

    assert.equal(calls, 4);
    assert.equal(launches.length, 1);
    assert.match(launches[0]?.task ?? '', /done answer 4/);
    assert.match(
      terminal.output.join(''),
      /Finishing Codex's outstanding reciprocal confirmation/,
    );
    const saved = await new ChatSessionStore(paths.chatsDirectory).latest();
    assert.equal(saved?.latestPairedExchange?.outcome, 'confirmed');
    assert.equal(saved?.pendingExchange, undefined);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('free workflow rejections do not settle an outstanding reply', async () => {
  for (const scenario of [
    { initializeGit: false, expected: /Safe editing requires Git/ },
    { initializeGit: true, expected: /requires an initial commit/ },
  ]) {
    const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
    const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
    let calls = 0;
    try {
      if (scenario.initializeGit) {
        await execFileAsync('git', ['init'], { cwd: project });
      }
      const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
      const providers = providersWithRun(async () => {
        calls += 1;
        if (calls === 2) {
          throw new ProcessAbortError();
        }
        return { text: `answer ${calls}`, decision: 'continue' };
      });
      const terminal = new ScriptedTerminal([
        'Inspect this',
        '/edit',
        '/pause',
      ]);
      const options = parseArgs(['chat', '--cwd', project, '--ui', 'plain'], {
        initialCwd: project,
        defaultOutput: paths.runsDirectory,
      });

      await runInteractiveChat({
        options,
        appPaths: paths,
        providers,
        terminal,
      });

      const saved = await new ChatSessionStore(paths.chatsDirectory).latest();
      assert.equal(calls, 2);
      assert.ok(saved?.pendingExchange);
      assert.match(terminal.output.join(''), scenario.expected);
      assert.doesNotMatch(
        terminal.output.join(''),
        /Finishing Claude's outstanding reply/,
      );
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  }
});

test('a cancelled pending reply leaves a linked workflow unstarted', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const launches: WorkflowLaunchRequest[] = [];
  let calls = 0;
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const providers = providersWithRun(async () => {
      calls += 1;
      if (calls > 1) {
        throw new ProcessAbortError();
      }
      return { text: 'first answer', decision: 'continue' };
    });
    const terminal = new ScriptedTerminal([
      'Inspect this',
      '/review',
      'yes',
      '/pause',
    ]);
    const options = parseArgs(['chat', '--cwd', project, '--ui', 'plain'], {
      initialCwd: project,
      defaultOutput: paths.runsDirectory,
    });

    await runInteractiveChat({
      options,
      appPaths: paths,
      providers,
      terminal,
      launchWorkflow: async (request) => {
        launches.push(request);
        return 0;
      },
    });

    const saved = await new ChatSessionStore(paths.chatsDirectory).latest();
    assert.equal(calls, 4);
    assert.equal(launches.length, 0);
    assert.ok(saved?.pendingExchange);
    assert.equal(saved?.workflows.length, 0);
    assert.ok(!saved?.messages.some((entry) => entry.role === 'system'));
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('a cancelled resume does not send the startup task into the old exchange', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    // Leave a session with an outstanding peer response.
    const failing = providersWithRun(async (_prompt, options) => {
      if (options.cwd && called.push('call') === 2) {
        throw new Error('interrupted peer');
      }
      return { text: 'first answer', decision: 'continue' };
    });
    const called: string[] = [];
    await runInteractiveChat({
      options: parseArgs(['chat', '--cwd', project], {
        initialCwd: project,
        defaultOutput: paths.runsDirectory,
      }),
      appPaths: paths,
      providers: failing,
      terminal: new ScriptedTerminal(['Inspect this']),
    });
    const paused = await new ChatSessionStore(paths.chatsDirectory).latest();
    assert.ok(paused?.pendingExchange);

    // Resume with a startup task, but cancel the outstanding reply again.
    const cancelling = providersWithRun(async () => {
      throw new ProcessAbortError();
    });
    const terminal = new ScriptedTerminal([]);
    await runInteractiveChat({
      options: parseArgs(
        ['chat', '--resume', paused.id, '--task', 'brand new task'],
        { initialCwd: project, defaultOutput: paths.runsDirectory },
      ),
      appPaths: paths,
      providers: cancelling,
      terminal,
    });

    const saved = await new ChatSessionStore(paths.chatsDirectory).load(
      paused.id,
    );
    assert.ok(saved.pendingExchange, 'the reply is still outstanding');
    // The task must not be folded into the still-interrupted exchange.
    assert.deepEqual(
      saved.messages.map((message) => message.role),
      ['user', 'codex'],
    );
    assert.ok(
      !saved.messages.some((message) => message.text.includes('brand new')),
      'the startup task was persisted into the interrupted exchange',
    );
    assert.match(terminal.output.join(''), /startup task was not sent/);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('a cancelled confirmation resume does not send startup task input', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  let providerCalls = 0;
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const store = new ChatSessionStore(paths.chatsDirectory);
    const now = '2026-08-09T00:00:00.000Z';
    const session: ChatSession = {
      version: 4,
      id: 'chat-confirmation-startup-task',
      createdAt: now,
      updatedAt: now,
      status: 'paused',
      projectRoot: project,
      projectKind: 'directory',
      maxAutoRounds: 6,
      maxWorkflowRounds: 6,
      retries: 1,
      timeoutMinutes: 30,
      noTranscript: false,
      ui: 'plain',
      pendingExchange: {
        stage: 'awaiting-confirmation',
        firstAgent: 'codex',
        secondAgent: 'claude',
        firstMessageSequence: 2,
        secondMessageSequence: 3,
      },
      messages: [
        { sequence: 1, createdAt: now, role: 'user', text: 'Original task' },
        {
          sequence: 2,
          createdAt: now,
          role: 'codex',
          text: 'First done',
          decision: 'done',
        },
        {
          sequence: 3,
          createdAt: now,
          role: 'claude',
          text: 'Peer done',
          decision: 'done',
        },
      ],
      workflows: [],
    };
    await store.save(session);
    const terminal = new ScriptedTerminal([]);

    await runInteractiveChat({
      options: parseArgs(
        ['chat', '--resume', session.id, '--task', 'brand new task'],
        { initialCwd: project, defaultOutput: paths.runsDirectory },
      ),
      appPaths: paths,
      providers: providersWithRun(async (prompt) => {
        providerCalls += 1;
        assert.match(prompt, /reciprocal confirmation/);
        throw new ProcessAbortError();
      }),
      terminal,
    });

    const saved = await store.load(session.id);
    assert.equal(providerCalls, 1);
    assert.deepEqual(saved.pendingExchange, session.pendingExchange);
    assert.deepEqual(
      saved.messages.map((message) => message.text),
      session.messages.map((message) => message.text),
    );
    assert.match(terminal.output.join(''), /startup task was not sent/);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('cancelling the outstanding reply again drops the new message unsaved', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const called: string[] = [];
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const providers = providersWithRun(async () => {
      called.push('call');
      if (called.length >= 2) {
        throw new ProcessAbortError();
      }
      return { text: `answer ${called.length}`, decision: 'continue' };
    });
    const terminal = new ScriptedTerminal([
      'Inspect this',
      'follow up',
      '/pause',
    ]);
    const options = parseArgs(['chat', '--cwd', project, '--ui', 'plain'], {
      initialCwd: project,
      defaultOutput: paths.runsDirectory,
    });

    await runInteractiveChat({ options, appPaths: paths, providers, terminal });

    const saved = await new ChatSessionStore(paths.chatsDirectory).latest();
    assert.equal(saved?.status, 'paused');
    assert.ok(saved?.pendingExchange, 'the reply is still outstanding');
    // No orphan user message, and the chat survived to run `/pause`.
    assert.deepEqual(
      saved?.messages.map((message) => message.role),
      ['user', 'codex'],
    );
    assert.match(terminal.output.join(''), /Chat saved/);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('resume restores the saved chat interface unless explicitly overridden', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const capabilities = {
    stdinIsTty: true,
    stdoutIsTty: true,
    term: 'xterm-256color',
    columns: 100,
    rows: 24,
  } as const;
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    await runInteractiveChat({
      options: parseArgs(['chat', '--cwd', project, '--ui', 'enhanced'], {
        initialCwd: '/',
        defaultOutput: paths.runsDirectory,
      }),
      appPaths: paths,
      providers: fakeProviders([], []),
      terminal: new ScriptedTerminal(['/pause']),
      terminalCapabilities: capabilities,
    });
    const paused = await new ChatSessionStore(paths.chatsDirectory).latest();
    assert.equal(paused?.ui, 'enhanced');

    const terminal = new ScriptedTerminal(['/done']);
    await runInteractiveChat({
      options: parseArgs(['chat', '--resume', paused?.id ?? 'missing'], {
        initialCwd: project,
        defaultOutput: paths.runsDirectory,
      }),
      appPaths: paths,
      providers: fakeProviders([], []),
      terminal,
      terminalCapabilities: capabilities,
    });
    assert.equal(terminal.output.join('').includes('\u001B[?1049h'), true);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('an explicit --color reverses a chat saved with --no-color', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const store = new ChatSessionStore(paths.chatsDirectory);
    const open = async (argv: string[]): Promise<void> => {
      await runInteractiveChat({
        options: parseArgs(argv, {
          initialCwd: project,
          defaultOutput: paths.runsDirectory,
        }),
        appPaths: paths,
        providers: fakeProviders([], []),
        terminal: new ScriptedTerminal(['/pause']),
      });
    };

    await open(['chat', '--cwd', project, '--no-color']);
    const saved = await store.latest();
    assert.ok(saved);
    assert.equal(saved.color, false);

    // Without a flag the saved choice still governs the reopened session.
    await open(['chat', '--resume', saved.id]);
    assert.equal((await store.load(saved.id)).color, false);

    // An explicit flag outranks it, and the reversal is what gets saved.
    await open(['chat', '--resume', saved.id, '--color']);
    assert.equal((await store.load(saved.id)).color, true);

    // ...and is itself reversible, so neither choice becomes permanent.
    await open(['chat', '--resume', saved.id, '--no-color']);
    assert.equal((await store.load(saved.id)).color, false);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('a chat with no saved color choice uses the global preference', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const store = new ChatSessionStore(paths.chatsDirectory);
    const open = async (argv: string[]): Promise<void> => {
      await runInteractiveChat({
        options: parseArgs(argv, {
          initialCwd: project,
          defaultOutput: paths.runsDirectory,
        }),
        appPaths: paths,
        providers: fakeProviders([], []),
        terminal: new ScriptedTerminal(['/pause']),
      });
    };

    // A chat opened with no flag records no choice of its own.
    await open(['chat', '--cwd', project]);
    const saved = await store.latest();
    assert.ok(saved);
    assert.equal(saved.color, undefined);

    // The global preference is the next layer down, so resuming that chat must
    // consult it rather than dropping straight to automatic detection.
    await new UserConfigStore(paths.configFile).rememberPresentation({
      screenReader: false,
      color: false,
      ui: 'plain',
    });
    await open(['chat', '--resume', saved.id]);
    assert.equal((await store.load(saved.id)).color, false);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('Ctrl+C cancels active provider work but keeps the chat open', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  let providerCalls = 0;
  const provider = (name: 'codex' | 'claude'): AgentProvider => ({
    name,
    label: name,
    version: async () => ({ stdout: 'test', stderr: '', exitCode: 0 }),
    authStatus: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    run: async (_prompt, options) => {
      providerCalls += 1;
      if (!options.signal) {
        throw new Error('test expected a cancellation signal');
      }
      const signal = options.signal;
      setImmediate(() => process.emit('SIGINT'));
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error('provider interrupted')),
          { once: true },
        );
      });
      throw new Error('unreachable');
    },
  });
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const terminal = new ScriptedTerminal(['Please inspect this', '/done']);
    await runInteractiveChat({
      options: parseArgs(['chat', '--cwd', project], {
        initialCwd: '/',
        defaultOutput: paths.runsDirectory,
      }),
      appPaths: paths,
      providers: { codex: provider('codex'), claude: provider('claude') },
      terminal,
    });
    const session = await new ChatSessionStore(paths.chatsDirectory).latest();
    assert.equal(session?.status, 'completed');
    assert.equal(providerCalls, 1);
    assert.deepEqual(
      session?.messages.map((message) => message.role),
      ['user'],
    );
    assert.equal(session?.pendingExchange, undefined);
    assert.match(terminal.output.join(''), /Active agent work cancelled/);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('does not overwrite a chat when another process owns its lock', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  let heldLock:
    Awaited<ReturnType<ChatSessionStore['acquireLock']>> | undefined;
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const initialOptions = parseArgs(['chat', '--cwd', project], {
      initialCwd: '/',
      defaultOutput: paths.runsDirectory,
    });
    await runInteractiveChat({
      options: initialOptions,
      appPaths: paths,
      providers: fakeProviders([], []),
      terminal: new ScriptedTerminal(['/pause']),
    });

    const store = new ChatSessionStore(paths.chatsDirectory);
    const before = await store.latest();
    assert.ok(before);
    heldLock = await store.acquireLock(before.id);
    const resumeTerminal = new ScriptedTerminal(['/done']);
    const resumeOptions = parseArgs(['chat', '--resume', before.id], {
      initialCwd: project,
      defaultOutput: paths.runsDirectory,
    });

    await assert.rejects(
      runInteractiveChat({
        options: resumeOptions,
        appPaths: paths,
        providers: fakeProviders([], []),
        terminal: resumeTerminal,
      }),
      /already open in another Agent Bridge process/,
    );

    assert.deepEqual(await store.load(before.id), before);
    assert.equal(resumeTerminal.closes, 1);
  } finally {
    await heldLock?.release();
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('reports a lock conflict before an unrelated provider failure', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  let heldLock:
    Awaited<ReturnType<ChatSessionStore['acquireLock']>> | undefined;
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const initialOptions = parseArgs(['chat', '--cwd', project], {
      initialCwd: '/',
      defaultOutput: paths.runsDirectory,
    });
    await runInteractiveChat({
      options: initialOptions,
      appPaths: paths,
      providers: fakeProviders([], []),
      terminal: new ScriptedTerminal(['/pause']),
    });

    const store = new ChatSessionStore(paths.chatsDirectory);
    const before = await store.latest();
    assert.ok(before);
    heldLock = await store.acquireLock(before.id);
    const resumeTerminal = new ScriptedTerminal(['/done']);
    const resumeOptions = parseArgs(['chat', '--resume', before.id], {
      initialCwd: project,
      defaultOutput: paths.runsDirectory,
    });

    await assert.rejects(
      runInteractiveChat({
        options: resumeOptions,
        appPaths: paths,
        providers: unavailableProviders(),
        terminal: resumeTerminal,
      }),
      /already open in another Agent Bridge process/,
    );
  } finally {
    await heldLock?.release();
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('closes the terminal when chat initialization fails', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const terminal = new ScriptedTerminal([]);
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const options = parseArgs(['chat', '--resume', 'chat-missing'], {
      initialCwd: '/',
      defaultOutput: paths.runsDirectory,
    });

    await assert.rejects(
      runInteractiveChat({
        options,
        appPaths: paths,
        providers: fakeProviders([], []),
        terminal,
      }),
      /Saved chat not found/,
    );
    assert.equal(terminal.closes, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('releases the chat lock even when terminal restoration fails', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const terminal = new FailingRestoreTerminal(['Inspect this']);
  const failingProvider = (name: 'codex' | 'claude'): AgentProvider => ({
    name,
    label: name,
    version: async () => ({ stdout: 'test', stderr: '', exitCode: 0 }),
    authStatus: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    run: async () => {
      throw new Error('provider failed');
    },
  });
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const options = parseArgs(
      ['chat', '--cwd', project, '--ui', 'enhanced', '--retries', '0'],
      {
        initialCwd: '/',
        defaultOutput: paths.runsDirectory,
      },
    );

    await assert.rejects(
      runInteractiveChat({
        options,
        appPaths: paths,
        providers: {
          codex: failingProvider('codex'),
          claude: failingProvider('claude'),
        },
        terminal,
        terminalCapabilities: {
          stdinIsTty: true,
          stdoutIsTty: true,
          term: 'xterm-256color',
          columns: 100,
          rows: 24,
        },
      }),
      /terminal restore failed/,
    );

    const store = new ChatSessionStore(paths.chatsDirectory);
    const session = await store.latest();
    assert.ok(session);
    assert.equal(session.status, 'paused');
    const lock = await store.acquireLock(session.id);
    await lock.release();
    assert.equal(terminal.closes, 1);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('does not repaint a prompt while enhanced presentation falls back to plain output', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const terminal = new RecordingRedrawTerminal(['/pause']);
  let renderCalls = 0;
  const enhancedRenderer: TerminalRenderer = {
    start: () => '<enter-enhanced>',
    render: () => {
      renderCalls += 1;
      if (renderCalls === 1) {
        return '<initial-frame>';
      }
      throw new Error('layout failed');
    },
    redraw: () => '',
    suspend: () => '',
    resume: () => '',
    stop: () => '<leave-enhanced>',
  };
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const options = parseArgs(['chat', '--cwd', project, '--ui', 'enhanced'], {
      initialCwd: '/',
      defaultOutput: paths.runsDirectory,
    });

    await runInteractiveChat({
      options,
      appPaths: paths,
      providers: fakeProviders([], []),
      terminal,
      terminalCapabilities: ENHANCED_TERMINAL_CAPABILITIES,
      enhancedRenderer,
    });

    assert.equal(terminal.redraws, 1);
    const output = terminal.output.join('');
    const restoration = output.indexOf('<leave-enhanced>');
    assert.ok(restoration >= 0);
    assert.match(
      output.slice(restoration),
      /Enhanced terminal rendering failed\. Continuing in plain mode\./,
    );
    assert.doesNotMatch(output.slice(restoration), /<prompt-redraw>/);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('does not repaint a prompt after enhanced terminal teardown begins', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const terminal = new RecordingRedrawTerminal(['/pause']);
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const options = parseArgs(['chat', '--cwd', project, '--ui', 'enhanced'], {
      initialCwd: '/',
      defaultOutput: paths.runsDirectory,
    });

    await runInteractiveChat({
      options,
      appPaths: paths,
      providers: fakeProviders([], []),
      terminal,
      terminalCapabilities: ENHANCED_TERMINAL_CAPABILITIES,
    });

    const output = terminal.output.join('');
    const restoration = output.lastIndexOf('\u001B[?1049l');
    assert.ok(restoration >= 0);
    assert.doesNotMatch(output.slice(restoration), /<prompt-redraw>/);
    assert.match(output.slice(restoration), /Chat saved\. Resume with:/);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('routes fatal resize callback failures through chat cleanup', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const terminal = new FailingRedrawTerminal([]);
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const options = parseArgs(['chat', '--cwd', project, '--ui', 'enhanced'], {
      initialCwd: '/',
      defaultOutput: paths.runsDirectory,
    });

    await assert.rejects(
      runInteractiveChat({
        options,
        appPaths: paths,
        providers: fakeProviders([], []),
        terminal,
        terminalCapabilities: {
          stdinIsTty: true,
          stdoutIsTty: true,
          term: 'xterm-256color',
          columns: 100,
          rows: 24,
        },
      }),
      /prompt redraw failed/,
    );

    const store = new ChatSessionStore(paths.chatsDirectory);
    const session = await store.latest();
    assert.ok(session);
    assert.equal(session.status, 'paused');
    const lock = await store.acquireLock(session.id);
    await lock.release();
    assert.equal(terminal.closes, 1);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('animates enhanced activity while a provider is running', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const terminal = new ScriptedTerminal(['/ask codex wait briefly', '/done']);
  let observedTimerUpdate = false;
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const options = parseArgs(['chat', '--cwd', project, '--ui', 'enhanced'], {
      initialCwd: '/',
      defaultOutput: paths.runsDirectory,
    });
    const providers = providersWithRun(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      observedTimerUpdate =
        terminal.output.filter((text) => text.startsWith('\u001B[H')).length >=
          2 && terminal.redraws >= 3;
      return { text: 'Finished waiting.', decision: 'done' };
    });

    await runInteractiveChat({
      options,
      appPaths: paths,
      providers,
      terminal,
      terminalCapabilities: ENHANCED_TERMINAL_CAPABILITIES,
      activityTickIntervalMs: 5,
    });

    assert.equal(observedTimerUpdate, true);
    assert.equal(terminal.closes, 1);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('cancels provider work and cleans up after an activity redraw fails', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const terminal = new FailingActivityTerminal(['/ask codex wait']);
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const options = parseArgs(
      ['chat', '--cwd', project, '--ui', 'enhanced', '--retries', '0'],
      {
        initialCwd: '/',
        defaultOutput: paths.runsDirectory,
      },
    );
    const providers = providersWithRun(async (_prompt, runOptions) => {
      const signal = runOptions.signal;
      assert.ok(signal);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('activity timer did not cancel provider')),
          1_000,
        );
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timeout);
            resolve();
          },
          { once: true },
        );
      });
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('provider aborted');
    });

    await assert.rejects(
      runInteractiveChat({
        options,
        appPaths: paths,
        providers,
        terminal,
        terminalCapabilities: ENHANCED_TERMINAL_CAPABILITIES,
        activityTickIntervalMs: 5,
      }),
      /activity redraw failed/,
    );

    const store = new ChatSessionStore(paths.chatsDirectory);
    const session = await store.latest();
    assert.ok(session);
    assert.equal(session.status, 'paused');
    const lock = await store.acquireLock(session.id);
    await lock.release();
    assert.equal(terminal.closes, 1);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('leaves a completed chat unchanged when a resumed preflight fails', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const initialOptions = parseArgs(['chat', '--cwd', project], {
      initialCwd: '/',
      defaultOutput: paths.runsDirectory,
    });
    await runInteractiveChat({
      options: initialOptions,
      appPaths: paths,
      providers: fakeProviders([], []),
      terminal: new ScriptedTerminal(['/done']),
    });

    const store = new ChatSessionStore(paths.chatsDirectory);
    const before = await store.latest();
    assert.ok(before);
    assert.equal(before.status, 'completed');
    const bytesBefore = await readFile(store.pathFor(before.id));

    const resumeOptions = parseArgs(['chat', '--resume', before.id], {
      initialCwd: project,
      defaultOutput: paths.runsDirectory,
    });
    await assert.rejects(
      runInteractiveChat({
        options: resumeOptions,
        appPaths: paths,
        providers: unavailableProviders(),
        terminal: new ScriptedTerminal(['/done']),
      }),
      /could not start every required provider CLI/,
    );

    const bytesAfter = await readFile(store.pathFor(before.id));
    assert.deepEqual(bytesAfter, bytesBefore);
    assert.deepEqual(await store.load(before.id), before);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('creates no saved session when a new chat preflight fails', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const options = parseArgs(['chat', '--cwd', project], {
      initialCwd: '/',
      defaultOutput: paths.runsDirectory,
    });

    await assert.rejects(
      runInteractiveChat({
        options,
        appPaths: paths,
        providers: unavailableProviders(),
        terminal: new ScriptedTerminal(['/done']),
      }),
      /could not start every required provider CLI/,
    );

    const store = new ChatSessionStore(paths.chatsDirectory);
    assert.deepEqual(await store.list(), []);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('leaves the authoritative JSON unchanged when transcript preparation fails', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const initialOptions = parseArgs(['chat', '--cwd', project], {
      initialCwd: '/',
      defaultOutput: paths.runsDirectory,
    });
    await runInteractiveChat({
      options: initialOptions,
      appPaths: paths,
      providers: fakeProviders([], []),
      terminal: new ScriptedTerminal(['/done']),
    });

    const store = new ChatSessionStore(paths.chatsDirectory);
    const before = await store.latest();
    assert.ok(before);
    assert.equal(before.status, 'completed');

    const bytesBefore = await readFile(store.pathFor(before.id));
    // Transcript preparation now precedes the authoritative JSON commit.
    await rm(store.transcriptPathFor(before.id), { force: true });
    await mkdir(store.transcriptPathFor(before.id));

    const resumeOptions = parseArgs(['chat', '--resume', before.id], {
      initialCwd: project,
      defaultOutput: paths.runsDirectory,
    });
    await assert.rejects(
      runInteractiveChat({
        options: resumeOptions,
        appPaths: paths,
        providers: fakeProviders([], []),
        terminal: new ScriptedTerminal(['/done']),
      }),
    );

    const after = await store.load(before.id);
    assert.deepEqual(after, before);
    assert.deepEqual(await readFile(store.pathFor(before.id)), bytesBefore);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('a failed response checkpoint remains resumable and may repeat only the uncheckpointed call', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  let calls = 0;
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const store = new ChatSessionStore(paths.chatsDirectory);
    const providers = providersWithRun(async () => {
      calls += 1;
      if (calls === 2) {
        const session = await store.latest();
        assert.ok(session);
        await rm(store.transcriptPathFor(session.id), { force: true });
        await mkdir(store.transcriptPathFor(session.id));
      }
      return { text: `response ${calls}`, decision: 'continue' };
    });

    await assert.rejects(
      runInteractiveChat({
        options: parseArgs(['chat', '--cwd', project, '--ui', 'plain'], {
          initialCwd: project,
          defaultOutput: paths.runsDirectory,
        }),
        appPaths: paths,
        providers,
        terminal: new ScriptedTerminal(['Review this']),
      }),
      /response was not checkpointed; a later resume may repeat this read-only provider call/,
    );

    const checkpoint = await store.latest();
    assert.ok(checkpoint);
    assert.deepEqual(
      checkpoint.messages.map((message) => message.role),
      ['user', 'codex'],
    );
    assert.equal(checkpoint.pendingExchange?.stage, 'awaiting-peer');

    await rm(store.transcriptPathFor(checkpoint.id), {
      recursive: true,
      force: true,
    });
    const resumedPrompts: string[] = [];
    await runInteractiveChat({
      options: parseArgs(['chat', '--resume', checkpoint.id], {
        initialCwd: project,
        defaultOutput: paths.runsDirectory,
      }),
      appPaths: paths,
      providers: providersWithRun(async (prompt) => {
        resumedPrompts.push(prompt);
        return { text: 'repeated peer response', decision: 'continue' };
      }),
      terminal: new ScriptedTerminal(['/pause']),
    });

    assert.equal(resumedPrompts.length, 1);
    assert.match(resumedPrompts[0] ?? '', /You are Claude/);
    const settled = await store.load(checkpoint.id);
    assert.deepEqual(
      settled.messages.map((message) => message.role),
      ['user', 'codex', 'claude'],
    );
    assert.equal(settled.pendingExchange, undefined);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
