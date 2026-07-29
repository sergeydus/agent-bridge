import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseChatInput, type ChatTerminal } from '../src/chat-input.ts';
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

class ScriptedTerminal implements ChatTerminal {
  readonly output: string[] = [];
  readonly #inputs: string[];
  pauses = 0;
  resumes = 0;

  constructor(inputs: string[]) {
    this.#inputs = [...inputs];
  }

  prompt(): Promise<string | null> {
    return Promise.resolve(this.#inputs.shift() ?? null);
  }

  write(text: string): void {
    this.output.push(text);
  }

  pause(): void {
    this.pauses += 1;
  }

  resume(): void {
    this.resumes += 1;
  }

  close(): void {}
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
      calls += 1;
      return {
        text: `${name} answer ${calls}`,
        decision: calls <= 2 ? 'continue' : 'done',
      };
    },
  });
  return { codex: provider('codex'), claude: provider('claude') };
}

test('parses interactive commands without accepting arbitrary actions', () => {
  assert.deepEqual(parseChatInput('hello'), {
    kind: 'message',
    text: 'hello',
  });
  assert.deepEqual(parseChatInput('/auto 4'), { kind: 'auto', rounds: 4 });
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
});

test('builds an isolated child workflow as argument arrays', () => {
  const options = parseArgs(
    [
      'chat',
      '--cwd',
      '/tmp',
      '--from-head',
      '--trust-project-config',
      '--max-rounds',
      '7',
    ],
    { initialCwd: '/', defaultOutput: '/tmp/bridge-runs' },
  );
  const args = buildWorkflowArguments(
    {
      mode: 'collaborative',
      firstAgent: 'claude',
      task: 'context',
      projectRoot: '/tmp',
      options,
    },
    '/tmp/private-task.md',
    '/opt/agent-bridge/dist/cli.js',
  );
  assert.deepEqual(args.slice(0, 5), [
    '/opt/agent-bridge/dist/cli.js',
    '--task-file',
    '/tmp/private-task.md',
    '--cwd',
    '/tmp',
  ]);
  assert.ok(args.includes('--collaborative'));
  assert.ok(args.includes('--from-head'));
  assert.ok(args.includes('--trust-project-config'));
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
    '/review',
    '/done',
  ]);
  const launches: WorkflowLaunchRequest[] = [];
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    const options = parseArgs(['chat', '--cwd', project, '--max-rounds', '4'], {
      initialCwd: '/',
      defaultOutput: paths.runsDirectory,
    });
    await runInteractiveChat({
      options,
      appPaths: paths,
      providers: fakeProviders(prompts, optionsSeen),
      terminal,
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
    assert.equal(session.messages[0]?.text, 'Please review\nthe design');
    assert.match(launches[0]?.task ?? '', /Please review/);
    assert.ok(
      optionsSeen.every((providerOptions) => !providerOptions.writeAccess),
    );
    assert.match(prompts[1] ?? '', /current exchange/);
    assert.equal(terminal.pauses, 1);
    assert.equal(terminal.resumes, 1);
    assert.match(terminal.output.join(''), /agree on the current answer/);
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

test('keeps the chat usable when a linked workflow cannot start', async () => {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-home-'));
  const terminal = new ScriptedTerminal(['Review this', '/review', '/done']);
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
    assert.match(terminal.output.join(''), /launcher unavailable/);
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
