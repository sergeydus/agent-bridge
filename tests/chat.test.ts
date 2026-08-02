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
  parseChatInput,
  type ChatTerminal,
} from '../src/chat-input.ts';
import { ChatSessionStore } from '../src/chat-state.ts';
import { runInteractiveChat } from '../src/chat.ts';
import {
  buildWorkflowArguments,
  type WorkflowLaunchRequest,
} from '../src/chat-workflow.ts';
import { parseArgs } from '../src/options.ts';
import { getAppPaths } from '../src/paths.ts';
import type {
  AgentProvider,
  ProviderMap,
  ProviderRunOptions,
} from '../src/providers.ts';

const execFileAsync = promisify(execFile);

class ScriptedTerminal implements ChatTerminal {
  readonly output: string[] = [];
  #inputs: string[];
  pauses = 0;
  resumes = 0;
  closes = 0;

  constructor(inputs: string[]) {
    this.#inputs = [...inputs];
  }

  prompt(): Promise<string | null> {
    return Promise.resolve(this.#inputs.shift() ?? null);
  }

  write(text: string): void {
    this.output.push(text);
  }

  redrawPrompt(): void {}

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
  override prompt(): Promise<string | null> {
    process.stdout.emit('resize');
    return Promise.resolve(null);
  }

  override redrawPrompt(): void {
    throw new Error('prompt redraw failed');
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

test('runs paired exchanges, autonomous agreement, and a linked workflow', async () => {
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
      ['user', 'codex', 'claude', 'claude', 'codex', 'system'],
    );
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
    const output = terminal.output.join('');
    assert.match(output, /agree on the current answer/);
    assert.match(output, /Maximum provider calls: 4/);
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

test('resume completes an interrupted peer response without repeating the first', async () => {
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
    await assert.rejects(
      runInteractiveChat({
        options,
        appPaths: paths,
        providers: {
          codex: provider('codex', false),
          claude: provider('claude', true),
        },
        terminal: new ScriptedTerminal(['Inspect this']),
      }),
      /interrupted peer/,
    );
    const paused = await new ChatSessionStore(paths.chatsDirectory).latest();
    assert.ok(paused?.pendingExchange);
    assert.deepEqual(called, ['codex', 'claude']);

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
    assert.deepEqual(called, ['codex', 'claude', 'claude']);
    assert.equal(completed.pendingExchange, undefined);
    assert.equal(completed.status, 'completed');
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
        2;
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

test('marks the chat paused when the checkpoint save partially fails', async () => {
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

    // Forces the transcript half of store.save() to fail with EISDIR after
    // the JSON checkpoint half has already succeeded.
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
    assert.equal(after.status, 'paused');
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
