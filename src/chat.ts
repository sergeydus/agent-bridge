import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CHAT_HELP,
  createChatTerminal,
  MAX_USER_MESSAGE_CHARS,
  parseChatInput,
  type ChatTerminal,
} from './chat-input.ts';
import {
  ChatSessionStore,
  formatChatList,
  type ChatLock,
  type ChatMessage,
  type ChatSession,
} from './chat-state.ts';
import {
  buildChatWorkflowTask,
  launchBridgeWorkflow,
  type WorkflowLauncher,
} from './chat-workflow.ts';
import { makeRunId, otherAgent, type AgentName } from './core.ts';
import { loadInstructionContext } from './instructions.ts';
import type { BridgeOptions } from './options.ts';
import type { AppPaths } from './paths.ts';
import {
  agentLabel,
  createProviderEventPresenter,
  formatAgentHeartbeat,
  formatAgentResponse,
  formatAgentStarted,
  resolvePresentation,
  type PresentationPreferences,
} from './presentation.ts';
import { ProcessAbortError } from './process.ts';
import { resolveProject } from './project.ts';
import { interactiveChatPrompt } from './prompts.ts';
import {
  createDefaultProviders,
  runProviderWithRetry,
  type ProviderMap,
} from './providers.ts';
import { resolveTask } from './task.ts';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function addMessage(
  session: ChatSession,
  role: ChatMessage['role'],
  text: string,
  decision?: ChatMessage['decision'],
): ChatMessage {
  const message: ChatMessage = {
    sequence: session.messages.length + 1,
    createdAt: new Date().toISOString(),
    role,
    text,
    ...(decision ? { decision } : {}),
  };
  session.messages.push(message);
  return message;
}

function recentHistory(session: ChatSession, count: number): string {
  if (session.messages.length === 0) {
    return 'No messages yet.';
  }
  return session.messages
    .slice(-count)
    .map((message) => {
      const decision = message.decision ? ` [${message.decision}]` : '';
      return `${message.sequence}. ${
        message.role === 'user'
          ? 'You'
          : message.role === 'system'
            ? 'Agent Bridge'
            : agentLabel(message.role)
      }${decision}: ${message.text}`;
    })
    .join('\n\n');
}

function chatStatus(
  session: ChatSession,
  presentation: PresentationPreferences,
): string {
  return `Session: ${session.id}
Status: ${session.status}
Project: ${session.projectRoot} (${session.projectKind})
Messages: ${session.messages.length}
Linked workflows: ${session.workflows.length}
Automatic exchange limit: ${session.maxAutoRounds}
Codex model: ${session.codexModel ?? 'provider default'}
Claude model: ${session.claudeModel ?? 'provider default'}
Presentation: ${
    presentation.screenReader
      ? 'screen-reader-friendly'
      : presentation.color
        ? 'enhanced'
        : 'plain, no color'
  }`;
}

async function refreshProjectKind(session: ChatSession): Promise<boolean> {
  const project = await resolveProject(session.projectRoot);
  if (project.root !== session.projectRoot) {
    throw new Error(
      `The selected project root changed since this chat started: ${session.projectRoot}`,
    );
  }
  if (project.kind === session.projectKind) {
    return false;
  }
  session.projectKind = project.kind;
  return true;
}

function legacyNextFirstAgent(session: ChatSession): AgentName {
  const agentMessages = session.messages.filter(
    (message) => message.role === 'codex' || message.role === 'claude',
  );
  return Math.floor(agentMessages.length / 2) % 2 === 0 ? 'codex' : 'claude';
}

async function runExchange({
  session,
  store,
  providers,
  terminal,
  tempDirectory,
  instructions,
  options,
  signal,
  presentation,
  participants,
}: {
  session: ChatSession;
  store: ChatSessionStore;
  providers: ProviderMap;
  terminal: ChatTerminal;
  tempDirectory: string;
  instructions: string;
  options: BridgeOptions;
  signal: AbortSignal;
  presentation: PresentationPreferences;
  participants?: readonly AgentName[];
}): Promise<boolean> {
  const pending = session.pendingExchange;
  if (pending && participants) {
    throw new Error('Cannot target an agent while a peer response is pending.');
  }
  const first =
    pending?.firstAgent ??
    session.nextFirstAgent ??
    legacyNextFirstAgent(session);
  const second = pending?.secondAgent ?? otherAgent(first);
  let firstMessage = pending
    ? session.messages[pending.firstMessageSequence - 1]
    : undefined;
  const agents = participants ?? (pending ? [second] : [first, second]);
  const pairedExchange = participants === undefined;

  for (const agent of agents) {
    const startedAt = Date.now();
    const model = agent === 'codex' ? session.codexModel : session.claudeModel;
    terminal.write(
      formatAgentStarted({ agent, model, preferences: presentation }),
    );
    const eventPresenter = createProviderEventPresenter({
      agent,
      preferences: presentation,
      streamText: !presentation.screenReader,
    });
    const heartbeat = setInterval(() => {
      terminal.write(eventPresenter.beforeStatus());
      terminal.write(
        formatAgentHeartbeat({
          agent,
          startedAt,
          preferences: presentation,
        }),
      );
    }, 30_000);
    heartbeat.unref();
    try {
      let response: Awaited<ReturnType<typeof runProviderWithRetry>>;
      try {
        response = await runProviderWithRetry({
          provider: providers[agent],
          prompt: interactiveChatPrompt({
            agent,
            history: session.messages,
            projectInstructions: instructions,
            currentPeerResponse:
              pairedExchange && agent === second ? firstMessage : undefined,
          }),
          options: {
            cwd: session.projectRoot,
            tempDirectory,
            writeAccess: false,
            verbose: options.verbose,
            dryRun: options.dryRun,
            timeoutMs: session.timeoutMinutes * 60_000,
            responseKind: 'turn',
            isGitRepository: session.projectKind === 'git',
            model: agent === 'codex' ? session.codexModel : session.claudeModel,
            effort:
              agent === 'codex' ? session.codexEffort : session.claudeEffort,
            screenReader: presentation.screenReader,
            signal,
            onEvent: (event) => terminal.write(eventPresenter.render(event)),
          },
          retries: session.retries,
          onRetry: (attempt) => {
            terminal.write(eventPresenter.reset());
            terminal.write(
              `  Temporary ${agentLabel(agent)} failure; retrying (${attempt}/${session.retries})…\n`,
            );
          },
        });
        terminal.write(eventPresenter.finish());
      } catch (error) {
        terminal.write(eventPresenter.reset());
        throw error;
      }
      const message = addMessage(
        session,
        agent,
        response.text,
        response.decision,
      );
      if (pairedExchange && agent === first) {
        firstMessage = message;
        session.pendingExchange = {
          firstAgent: first,
          secondAgent: second,
          firstMessageSequence: message.sequence,
        };
      } else if (pairedExchange) {
        session.pendingExchange = undefined;
        session.nextFirstAgent = otherAgent(first);
      }
      await store.save(session);
      terminal.write(
        formatAgentResponse({
          agent,
          decision: response.decision,
          text: response.text,
          preferences: presentation,
        }),
      );
    } finally {
      clearInterval(heartbeat);
    }
  }

  if (!pairedExchange) {
    return false;
  }
  const latest = session.messages.slice(-2);
  return (
    latest.length === 2 &&
    latest.every((message) => message.decision === 'done')
  );
}

function createSession(
  options: BridgeOptions,
  project: Awaited<ReturnType<typeof resolveProject>>,
): ChatSession {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: `chat-${makeRunId(new Date(now))}`,
    createdAt: now,
    updatedAt: now,
    status: 'active',
    projectRoot: project.root,
    projectKind: project.kind,
    maxAutoRounds: options.maxRounds,
    retries: options.retries,
    timeoutMinutes: options.timeoutMinutes,
    noTranscript: options.noTranscript,
    screenReader: options.screenReader,
    noColor: options.noColor,
    codexModel: options.codexModel,
    claudeModel: options.claudeModel,
    codexEffort: options.codexEffort,
    claudeEffort: options.claudeEffort,
    nextFirstAgent: 'codex',
    pendingExchange: undefined,
    messages: [],
    workflows: [],
  };
}

export async function runInteractiveChat({
  options,
  appPaths,
  providers = createDefaultProviders(),
  terminal: providedTerminal,
  launchWorkflow = launchBridgeWorkflow,
}: {
  options: BridgeOptions;
  appPaths: AppPaths;
  providers?: ProviderMap;
  terminal?: ChatTerminal;
  launchWorkflow?: WorkflowLauncher;
}): Promise<void> {
  if (
    !process.stdin.isTTY &&
    !providedTerminal &&
    !options.listChats &&
    !options.deleteChat
  ) {
    throw new Error('Interactive chat requires a terminal');
  }
  const terminal = providedTerminal ?? createChatTerminal();
  const store = new ChatSessionStore(appPaths.chatsDirectory, (message) =>
    console.warn(message),
  );
  if (options.listChats) {
    terminal.write(`${formatChatList(await store.list())}\n`);
    terminal.close();
    return;
  }
  if (options.deleteChat) {
    const session = await store.load(options.deleteChat);
    const deletionLock = await store.acquireLock(session.id);
    try {
      await store.delete(session.id);
    } finally {
      await deletionLock.release();
    }
    terminal.write(`Deleted chat ${session.id}.\n`);
    terminal.close();
    return;
  }
  let session: ChatSession;
  if (options.resume) {
    const resumed =
      options.resume === 'latest'
        ? await store.latest()
        : await store.load(options.resume);
    if (!resumed) {
      throw new Error('There is no saved chat to resume.');
    }
    session = resumed;
    options.screenReader ||= session.screenReader ?? false;
    options.noColor ||= session.noColor ?? false;
    session.screenReader = options.screenReader;
    session.noColor = options.noColor;
    await refreshProjectKind(session);
    session.status = 'active';
  } else {
    session = createSession(options, await resolveProject(options.cwd));
  }
  const presentation = resolvePresentation({
    screenReader: options.screenReader,
    noColor: options.noColor,
  });

  let lock: ChatLock | undefined;
  const abortController = new AbortController();
  const abort = (): void => abortController.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const tempDirectory = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-'));
  let completed = false;

  try {
    lock = await store.acquireLock(session.id);
    await store.save(session);
    const instructions = async (): Promise<string> =>
      (await loadInstructionContext(session.projectRoot)).prompt;
    terminal.write(
      presentation.screenReader
        ? `
Agent Bridge interactive chat.
Session: ${session.id}
Project: ${session.projectRoot}
Type a message or /help. Ctrl+D and /pause save the conversation.
`
        : `
Agent Bridge interactive chat
=============================
Session: ${session.id}
Project: ${session.projectRoot}

Type a message or /help. Ctrl+D and /pause save the conversation.
`,
    );

    if (session.pendingExchange) {
      terminal.write('\nResuming the interrupted peer response…\n');
      await runExchange({
        session,
        store,
        providers,
        terminal,
        tempDirectory,
        instructions: await instructions(),
        options,
        signal: abortController.signal,
        presentation,
      });
    }
    const initialMessage =
      options.task || options.taskFile ? await resolveTask(options) : undefined;
    if (initialMessage) {
      addMessage(session, 'user', initialMessage);
      await store.save(session);
      await runExchange({
        session,
        store,
        providers,
        terminal,
        tempDirectory,
        instructions: await instructions(),
        options,
        signal: abortController.signal,
        presentation,
      });
    }

    while (!abortController.signal.aborted) {
      const input = await terminal.prompt(
        presentation.screenReader ? '\nYour message: ' : '\nYou > ',
        abortController.signal,
      );
      const command = parseChatInput(input ?? '/pause');
      if (command.kind === 'empty') {
        continue;
      }
      if (command.kind === 'invalid') {
        terminal.write(`${command.message}\n`);
        continue;
      }
      if (command.kind === 'help') {
        terminal.write(`\n${CHAT_HELP}`);
        continue;
      }
      if (command.kind === 'status') {
        if (await refreshProjectKind(session)) {
          await store.save(session);
        }
        terminal.write(`\n${chatStatus(session, presentation)}\n`);
        continue;
      }
      if (command.kind === 'history') {
        terminal.write(`\n${recentHistory(session, command.count)}\n`);
        continue;
      }
      if (command.kind === 'paste') {
        terminal.write(
          '\nPaste or type multiple lines. Enter a single "." line to send.\n',
        );
        const lines: string[] = [];
        let characters = 0;
        let tooLong = false;
        while (true) {
          const line = await terminal.prompt(
            presentation.screenReader ? 'Next line: ' : '… ',
            abortController.signal,
          );
          if (line === null) {
            session.status = 'paused';
            await store.save(session);
            terminal.write(
              `\nChat saved. Resume with:\n  agent-bridge chat --resume ${session.id}\n`,
            );
            return;
          }
          if (line === '.') {
            break;
          }
          if (tooLong) {
            continue;
          }
          characters += line.length + (lines.length > 0 ? 1 : 0);
          if (characters > MAX_USER_MESSAGE_CHARS) {
            tooLong = true;
            lines.length = 0;
            terminal.write(
              `Message exceeds ${MAX_USER_MESSAGE_CHARS.toLocaleString()} characters; discarding input until the "." line.\n`,
            );
            continue;
          }
          lines.push(line);
        }
        if (tooLong) {
          continue;
        }
        const text = lines.join('\n').trim();
        if (!text) {
          terminal.write('No message sent.\n');
          continue;
        }
        if (await refreshProjectKind(session)) {
          await store.save(session);
        }
        addMessage(session, 'user', text);
        await store.save(session);
        await runExchange({
          session,
          store,
          providers,
          terminal,
          tempDirectory,
          instructions: await instructions(),
          options,
          signal: abortController.signal,
          presentation,
        });
        continue;
      }
      if (command.kind === 'pause') {
        session.status = 'paused';
        await store.save(session);
        terminal.write(
          `\nChat saved. Resume with:\n  agent-bridge chat --resume ${session.id}\n`,
        );
        return;
      }
      if (command.kind === 'done') {
        session.status = 'completed';
        await store.save(session);
        completed = true;
        terminal.write(`\nChat ${session.id} completed.\n`);
        return;
      }
      if (command.kind === 'message') {
        if (await refreshProjectKind(session)) {
          await store.save(session);
        }
        const addressedText =
          command.target && command.target !== 'both'
            ? `Addressed to ${agentLabel(command.target)}:\n${command.text}`
            : command.text;
        addMessage(session, 'user', addressedText);
        await store.save(session);
        await runExchange({
          session,
          store,
          providers,
          terminal,
          tempDirectory,
          instructions: await instructions(),
          options,
          signal: abortController.signal,
          presentation,
          participants:
            command.target && command.target !== 'both'
              ? [command.target]
              : undefined,
        });
        continue;
      }
      if (command.kind === 'auto') {
        if (!session.messages.some((message) => message.role === 'user')) {
          terminal.write(
            '\nSend a message first so the agents know what to discuss.\n',
          );
          continue;
        }
        if (await refreshProjectKind(session)) {
          await store.save(session);
        }
        const rounds = command.rounds ?? session.maxAutoRounds;
        let agreed = false;
        for (let round = 1; round <= rounds; round += 1) {
          terminal.write(`\nAutomatic exchange ${round}/${rounds}\n`);
          agreed = await runExchange({
            session,
            store,
            providers,
            terminal,
            tempDirectory,
            instructions: await instructions(),
            options,
            signal: abortController.signal,
            presentation,
          });
          if (agreed) {
            terminal.write('\nCodex and Claude agree on the current answer.\n');
            break;
          }
        }
        if (!agreed) {
          terminal.write(
            `\nAutomatic exchange limit reached; you remain in control.\n`,
          );
        }
        continue;
      }
      if (command.kind === 'workflow') {
        if (!session.messages.some((message) => message.role === 'user')) {
          terminal.write(
            '\nDescribe the task in a message before starting a workflow.\n',
          );
          continue;
        }
        if (await refreshProjectKind(session)) {
          await store.save(session);
        }
        if (session.projectKind === 'directory' && command.mode !== 'review') {
          terminal.write(
            '\nSafe editing requires Git. Initialize this folder with `git init`, or use /review.\n',
          );
          continue;
        }
        const startedAt = new Date().toISOString();
        terminal.write(
          `\nStarting ${command.mode} workflow. The existing Git isolation and verification rules apply.\n`,
        );
        terminal.pause();
        let exitCode = 1;
        let launchError: string | undefined;
        try {
          exitCode = await launchWorkflow({
            mode: command.mode,
            firstAgent: command.firstAgent,
            task: buildChatWorkflowTask(
              session,
              command.mode,
              command.firstAgent,
            ),
            projectRoot: session.projectRoot,
            options: {
              ...options,
              maxRounds: session.maxAutoRounds,
              retries: session.retries,
              timeoutMinutes: session.timeoutMinutes,
              codexModel: session.codexModel,
              claudeModel: session.claudeModel,
              codexEffort: session.codexEffort,
              claudeEffort: session.claudeEffort,
              noTranscript: session.noTranscript,
            },
          });
        } catch (error) {
          launchError = errorMessage(error);
        } finally {
          terminal.resume();
        }
        session.workflows.push({
          sequence: session.workflows.length + 1,
          startedAt,
          completedAt: new Date().toISOString(),
          mode: command.mode,
          firstAgent: command.firstAgent,
          exitCode,
        });
        addMessage(
          session,
          'system',
          `${command.mode} workflow finished with exit code ${exitCode}${
            launchError ? `: ${launchError}` : ''
          }. The next exchange should inspect the current project state before drawing conclusions.`,
        );
        await store.save(session);
        terminal.write(
          exitCode === 0 && !launchError
            ? '\nWorkflow finished. You can continue the conversation.\n'
            : `\nWorkflow did not complete successfully${
                launchError ? `: ${launchError}` : ` (exit ${exitCode})`
              }. The chat is still active.\n`,
        );
      }
    }
    throw new ProcessAbortError('Interactive chat interrupted');
  } catch (error) {
    if (abortController.signal.aborted || error instanceof ProcessAbortError) {
      session.status = 'paused';
      await store.save(session).catch(() => {});
      terminal.write(
        `\nChat paused safely. Resume with:\n  agent-bridge chat --resume ${session.id}\n`,
      );
      return;
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    if (!completed && session.status === 'active') {
      session.status = 'paused';
      await store.save(session).catch(() => {});
    }
    if (completed && session.noTranscript) {
      await store.delete(session.id);
    }
    await lock?.release();
    terminal.close();
    await rm(tempDirectory, { recursive: true, force: true });
  }
}
