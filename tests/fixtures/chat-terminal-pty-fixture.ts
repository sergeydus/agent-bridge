import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createChatTerminal } from '../../src/chat-input.ts';
import { runInteractiveChat } from '../../src/chat.ts';
import { createEnhancedTerminalRenderer } from '../../src/enhanced-terminal.ts';
import { parseArgs } from '../../src/options.ts';
import { getAppPaths } from '../../src/paths.ts';
import { createTerminalViewModel } from '../../src/presentation-model.ts';
import type { AgentProvider, ProviderMap } from '../../src/providers.ts';

const mode = process.argv[2];

async function runPromptFixture(): Promise<void> {
  const terminal = createChatTerminal();
  const onResize = (): void => {
    terminal.write('\r\n__AB_RESIZED__\r\n');
    terminal.redrawPrompt();
  };
  process.stdout.on('resize', onResize);
  try {
    terminal.write(
      `__AB_TTY__${String(Boolean(process.stdin.isTTY))}:${String(Boolean(process.stdout.isTTY))}\r\n`,
    );
    const value = await terminal.prompt('You > ');
    terminal.write(`\r\n__AB_RESULT__${JSON.stringify(value)}\r\n`);
  } finally {
    process.stdout.off('resize', onResize);
    terminal.close();
  }
}

async function runSignalFixture(): Promise<void> {
  const terminal = createChatTerminal();
  const renderer = createEnhancedTerminalRenderer({
    dimensions: () => ({
      columns: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
    }),
  });
  const model = createTerminalViewModel({
    session: {
      id: 'chat-pty-fixture',
      projectLabel: 'pty-fixture',
      status: 'active',
    },
    messages: [],
  });
  let resolveSignal: (() => void) | undefined;
  const signal = new Promise<void>((resolve) => {
    resolveSignal = resolve;
  });
  const onSignal = (): void => {
    terminal.write(renderer.stop());
    terminal.write('\r\n__AB_SIGINT__\r\n');
    terminal.close();
    resolveSignal?.();
  };
  process.once('SIGINT', onSignal);
  try {
    terminal.write(renderer.start(model));
    terminal.write('__AB_READY__');
    await signal;
  } finally {
    process.off('SIGINT', onSignal);
    terminal.write(renderer.stop());
    terminal.close();
  }
}

async function runBetweenPromptsFixture(): Promise<void> {
  const terminal = createChatTerminal();
  let resizeCount = 0;
  let resolveResult: (() => void) | undefined;
  const result = new Promise<void>((resolve) => {
    resolveResult = resolve;
  });
  const onResize = (): void => {
    resizeCount += 1;
    if (resizeCount === 1) {
      terminal.write('\r\n__AB_FRAME__\r\n');
      terminal.redrawPrompt();
      return;
    }
    if (resizeCount === 2) {
      terminal.write('\r\n__AB_FINISHED__\r\n');
      void terminal.prompt('Next > ').then((value) => {
        terminal.write(`\r\n__AB_RESULT__${JSON.stringify(value)}\r\n`);
        resolveResult?.();
      });
    }
  };
  process.stdout.on('resize', onResize);
  try {
    await terminal.prompt('Start > ');
    terminal.write('__AB_WORKING__');
    await result;
  } finally {
    process.stdout.off('resize', onResize);
    terminal.close();
  }
}

async function runSupplementalOutputFixture(): Promise<void> {
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-pty-project-'));
  const home = await mkdtemp(join(tmpdir(), 'agent-bridge-pty-home-'));
  let releaseProvider: (() => void) | undefined;
  const providerRelease = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const releaseOnResize = (): void => releaseProvider?.();
  process.stdout.once('resize', releaseOnResize);
  const provider = (name: 'codex' | 'claude'): AgentProvider => ({
    name,
    label: name,
    version: async () => ({ stdout: 'test', stderr: '', exitCode: 0 }),
    authStatus: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    run: async () => {
      process.stdout.write('__AB_PROVIDER__');
      await providerRelease;
      return { text: 'Provider response.', decision: 'continue' };
    },
  });
  const providers: ProviderMap = {
    codex: provider('codex'),
    claude: provider('claude'),
  };
  try {
    const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: home } });
    await runInteractiveChat({
      options: parseArgs(['chat', '--cwd', project, '--ui', 'enhanced'], {
        initialCwd: project,
        defaultOutput: paths.runsDirectory,
      }),
      appPaths: paths,
      providers,
      terminalCapabilities: {
        stdinIsTty: true,
        stdoutIsTty: true,
        term: 'xterm-256color',
        columns: process.stdout.columns ?? 80,
        rows: process.stdout.rows ?? 24,
      },
    });
  } finally {
    process.stdout.off('resize', releaseOnResize);
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

if (mode === 'prompt') {
  await runPromptFixture();
} else if (mode === 'signal') {
  await runSignalFixture();
} else if (mode === 'between-prompts') {
  await runBetweenPromptsFixture();
} else if (mode === 'supplemental-output') {
  await runSupplementalOutputFixture();
} else {
  throw new Error(`Unknown PTY fixture mode: ${String(mode)}`);
}
