import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

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
  createPlainTerminalRenderer,
  formatAgentResponse,
  PresentationController,
  resolvePresentation,
  type PresentationPreferences,
} from './presentation.ts';
import {
  MAX_PRESENTED_MESSAGES,
  createTerminalViewModel,
  type PresentationModelEvent,
  type PresentedMessage,
} from './presentation-model.ts';
import { ProcessAbortError } from './process.ts';
import { repositoryHasHead } from './git.ts';
import { resolveProject } from './project.ts';
import { interactiveChatPrompt } from './prompts.ts';
import {
  assertProvidersAvailable,
  createDefaultProviders,
  runProviderWithRetry,
  type ProviderMap,
} from './providers.ts';
import { resolveTask } from './task.ts';
import { createEnhancedTerminalRenderer } from './enhanced-terminal.ts';
import {
  detectTerminalCapabilities,
  resolveUiMode,
  type ResolvedUiMode,
  type TerminalCapabilities,
} from './terminal-capabilities.ts';
import { sanitizeTerminalText } from './terminal-text.ts';
import {
  formatWorkflowPreflight,
  inspectWorkflowPreflight,
} from './workflow-preflight.ts';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const ACTIVITY_TICK_INTERVAL_MS = 250;

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

function presentedMessage(message: ChatMessage): PresentedMessage {
  return {
    sequence: message.sequence,
    createdAt: message.createdAt,
    role: message.role,
    text: message.text,
    decision: message.decision,
  };
}

function chatIntroduction(
  session: ChatSession,
  presentation: PresentationPreferences,
): string {
  const projectRoot = sanitizeTerminalText(session.projectRoot);
  return presentation.screenReader
    ? `
Agent Bridge interactive chat.
Session: ${session.id}
Project: ${projectRoot}
Ordinary messages discuss and review without editing files.
An ordinary message normally asks both providers; /ask uses one.
To make safe changes, use /edit. You will see a preview before anything edits.
Ctrl+C cancels active work; at the prompt it saves and leaves.
Use /help for all commands. Ctrl+D and /pause also save and leave.
`
    : `
Agent Bridge interactive chat
=============================
Session: ${session.id}
Project: ${projectRoot}

Ordinary messages discuss and review without editing files.
An ordinary message normally asks both providers; /ask uses one.
To make safe changes, use /edit. You will see a preview before anything edits.
Ctrl+C cancels active work; at the prompt it saves and leaves.
Use /help for all commands. Ctrl+D and /pause also save and leave.
`;
}

function createChatPresentation(
  session: ChatSession,
  preferences: PresentationPreferences,
  terminal: ChatTerminal,
  uiMode: ResolvedUiMode,
): PresentationController {
  return new PresentationController({
    initialModel: createTerminalViewModel({
      session: {
        id: session.id,
        projectLabel: basename(session.projectRoot) || session.projectRoot,
        status: session.status,
      },
      messages: session.messages
        .slice(-MAX_PRESENTED_MESSAGES)
        .map(presentedMessage),
    }),
    renderer:
      uiMode === 'enhanced'
        ? createEnhancedTerminalRenderer()
        : createPlainTerminalRenderer(preferences),
    ...(uiMode === 'enhanced'
      ? {
          fallback: {
            renderer: createPlainTerminalRenderer(preferences),
            notice: `\nEnhanced terminal rendering failed. Continuing in plain mode.\n${chatIntroduction(
              session,
              preferences,
            )}`,
          },
        }
      : {}),
    write: (text) => terminal.write(text),
  });
}

function addPresentedMessage(
  session: ChatSession,
  presenter: PresentationController,
  role: 'user' | 'system',
  text: string,
): void {
  const message = addMessage(session, role, text);
  presenter.dispatch({
    type: 'message-added',
    message: presentedMessage(message),
  });
}

function setPresentedStatus(
  session: ChatSession,
  presenter: PresentationController,
  status: ChatSession['status'],
): void {
  session.status = status;
  presenter.dispatch({ type: 'session-status', status });
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
      }${decision}: ${sanitizeTerminalText(message.text)}`;
    })
    .join('\n\n');
}

function formatCompletedResponses(
  messages: readonly ChatMessage[],
  preferences: PresentationPreferences,
): string {
  return messages
    .flatMap((message) =>
      message.role === 'codex' || message.role === 'claude'
        ? [
            formatAgentResponse({
              agent: message.role,
              decision: message.decision,
              text: message.text,
              preferences,
            }),
          ]
        : [],
    )
    .join('');
}

function chatStatus(
  session: ChatSession,
  presentation: PresentationPreferences,
  uiMode: ResolvedUiMode,
): string {
  return `Session: ${session.id}
Status: ${session.status}
Project: ${sanitizeTerminalText(session.projectRoot)} (${session.projectKind})
Messages: ${session.messages.length}
Linked workflows: ${session.workflows.length}
Automatic exchange limit: ${session.maxAutoRounds}
Editing workflow cycle limit: ${session.maxWorkflowRounds}
Codex model: ${sanitizeTerminalText(session.codexModel ?? 'provider default')}
Claude model: ${sanitizeTerminalText(session.claudeModel ?? 'provider default')}
Presentation: ${
    presentation.screenReader
      ? 'screen-reader-friendly'
      : uiMode === 'enhanced'
        ? 'enhanced terminal'
        : presentation.color
          ? 'standard, color'
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
  presenter,
  tempDirectory,
  instructions,
  options,
  signal,
  presentation,
  participants,
  animateActivity,
  activityTickIntervalMs,
  onPresentationError,
}: {
  session: ChatSession;
  store: ChatSessionStore;
  providers: ProviderMap;
  presenter: PresentationController;
  tempDirectory: string;
  instructions: string;
  options: BridgeOptions;
  signal: AbortSignal;
  presentation: PresentationPreferences;
  participants?: readonly AgentName[];
  animateActivity: boolean;
  activityTickIntervalMs: number;
  onPresentationError: (error: unknown) => void;
}): Promise<boolean> {
  const pending = session.pendingExchange;
  if (pending && participants) {
    // The chat loop rejects this before persisting a message, so reaching it
    // here is a coordinator bug rather than recoverable user input.
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
    presenter.dispatch({
      type: 'agent-started',
      agent,
      model,
      startedAt,
    });
    let timerFailed = false;
    const dispatchTimerEvent = (
      event: Extract<
        PresentationModelEvent,
        { type: 'agent-heartbeat' | 'agent-tick' }
      >,
    ): void => {
      if (timerFailed) {
        return;
      }
      try {
        presenter.dispatch(event);
      } catch (error) {
        timerFailed = true;
        onPresentationError(error);
      }
    };
    const heartbeat = setInterval(() => {
      dispatchTimerEvent({
        type: 'agent-heartbeat',
        agent,
        now: Date.now(),
      });
    }, 30_000);
    heartbeat.unref();
    const activityTick = animateActivity
      ? setInterval(() => {
          dispatchTimerEvent({
            type: 'agent-tick',
            agent,
            now: Date.now(),
          });
        }, activityTickIntervalMs)
      : undefined;
    activityTick?.unref();
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
            onEvent: (event) =>
              presenter.dispatch({ type: 'provider-event', agent, event }),
          },
          retries: session.retries,
          onRetry: (attempt) => {
            presenter.dispatch({
              type: 'agent-retry',
              agent,
              attempt,
              retryLimit: session.retries,
            });
          },
        });
        if (signal.aborted) {
          throw signal.reason instanceof Error
            ? signal.reason
            : new ProcessAbortError();
        }
        presenter.dispatch({ type: 'agent-stream-finished', agent });
      } catch (error) {
        presenter.dispatch({ type: 'agent-failed', agent });
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
      presenter.dispatch({
        type: 'agent-response',
        agent,
        message: presentedMessage(message),
      });
    } finally {
      clearInterval(heartbeat);
      if (activityTick) {
        clearInterval(activityTick);
      }
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
    version: 2,
    id: `chat-${makeRunId(new Date(now))}`,
    createdAt: now,
    updatedAt: now,
    status: 'active',
    projectRoot: project.root,
    projectKind: project.kind,
    maxAutoRounds: options.maxAutoRounds,
    maxWorkflowRounds: options.maxRounds,
    retries: options.retries,
    timeoutMinutes: options.timeoutMinutes,
    noTranscript: options.noTranscript,
    screenReader: options.screenReader,
    noColor: options.noColor,
    ui: options.ui,
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
  terminalCapabilities,
  launchWorkflow = launchBridgeWorkflow,
  activityTickIntervalMs = ACTIVITY_TICK_INTERVAL_MS,
}: {
  options: BridgeOptions;
  appPaths: AppPaths;
  providers?: ProviderMap;
  terminal?: ChatTerminal;
  terminalCapabilities?: TerminalCapabilities;
  launchWorkflow?: WorkflowLauncher;
  activityTickIntervalMs?: number;
}): Promise<void> {
  const terminal = providedTerminal ?? createChatTerminal();
  try {
    const store = new ChatSessionStore(appPaths.chatsDirectory, (message) =>
      console.warn(sanitizeTerminalText(message)),
    );
    if (options.listChats) {
      terminal.write(`${formatChatList(await store.list())}\n`);
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
      if (!options.screenReaderExplicit) {
        options.screenReader = session.screenReader ?? false;
      }
      options.noColor ||= session.noColor ?? false;
      if (!options.uiExplicit) {
        options.ui = session.ui;
      }
      session.screenReader = options.screenReader;
      session.noColor = options.noColor;
      session.ui = options.ui;
      await refreshProjectKind(session);
      session.status = 'active';
    } else {
      session = createSession(options, await resolveProject(options.cwd));
    }
    const presentation = resolvePresentation({
      screenReader: options.screenReader,
      noColor: options.noColor,
    });
    const uiResolution = resolveUiMode(
      {
        requested: options.ui,
        screenReader: options.screenReader,
      },
      terminalCapabilities ?? detectTerminalCapabilities(),
    );
    const presenter = createChatPresentation(
      session,
      presentation,
      terminal,
      uiResolution.mode,
    );
    const activeUiMode = (): ResolvedUiMode =>
      uiResolution.mode === 'enhanced' && !presenter.usingFallback
        ? 'enhanced'
        : 'plain';
    const resolvedActivityTickIntervalMs = Number.isFinite(
      activityTickIntervalMs,
    )
      ? Math.max(1, Math.floor(activityTickIntervalMs))
      : ACTIVITY_TICK_INTERVAL_MS;

    let lock: ChatLock | undefined;
    let cleanupMayPersist = false;
    const abortController = new AbortController();
    let activeOperation: AbortController | undefined;
    const abort = (): void => {
      if (activeOperation && !activeOperation.signal.aborted) {
        activeOperation.abort();
        return;
      }
      abortController.abort();
    };
    const abortSession = (): void => abortController.abort();
    let terminalFailure: unknown;
    const redraw = (): void => {
      if (activeUiMode() !== 'enhanced') {
        return;
      }
      try {
        presenter.redraw();
        terminal.redrawPrompt();
      } catch (error) {
        terminalFailure =
          error instanceof Error
            ? error
            : new Error('Terminal redraw failed', { cause: error });
        abortController.abort(terminalFailure);
      }
    };
    const tempDirectory = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-'));
    process.on('SIGINT', abort);
    process.once('SIGTERM', abortSession);
    process.once('SIGHUP', abortSession);
    if (uiResolution.mode === 'enhanced') {
      process.stdout.on('resize', redraw);
    }
    let completed = false;
    let supplementalOutputOpen = false;
    const writeSupplemental = (text: string): void => {
      if (activeUiMode() === 'enhanced' && !supplementalOutputOpen) {
        presenter.suspend();
        supplementalOutputOpen = activeUiMode() === 'enhanced';
      }
      terminal.write(sanitizeTerminalText(text));
    };
    const resumeAfterSupplementalOutput = (): void => {
      if (!supplementalOutputOpen) {
        return;
      }
      supplementalOutputOpen = false;
      presenter.resume();
    };
    const confirm = async (
      prompt: string,
      defaultYes: boolean,
    ): Promise<boolean> => {
      const answer = (
        (await terminal.prompt(prompt, abortController.signal)) ?? ''
      )
        .trim()
        .toLowerCase();
      if (abortController.signal.aborted) {
        return false;
      }
      if (!answer) {
        return defaultYes;
      }
      return answer === 'y' || answer === 'yes';
    };

    try {
      lock = await store.acquireLock(session.id);
      if (!options.dryRun) {
        await assertProvidersAvailable(providers);
      }
      cleanupMayPersist = true;
      await store.save(session);
      const instructions = async (): Promise<string> =>
        (await loadInstructionContext(session.projectRoot)).prompt;
      const runCancellableExchange = async (
        participants?: readonly AgentName[],
      ): Promise<{ agreed: boolean; cancelled: boolean }> => {
        resumeAfterSupplementalOutput();
        const previousMessageCount = session.messages.length;
        let responsesRevealed = false;
        const revealCompletedResponses = (): void => {
          if (responsesRevealed || activeUiMode() !== 'enhanced') {
            return;
          }
          responsesRevealed = true;
          const output = formatCompletedResponses(
            session.messages.slice(previousMessageCount),
            presentation,
          );
          if (output) {
            writeSupplemental(output);
          }
        };
        const operation = new AbortController();
        activeOperation = operation;
        try {
          const agreed = await runExchange({
            session,
            store,
            providers,
            presenter,
            tempDirectory,
            instructions: await instructions(),
            options,
            signal: operation.signal,
            presentation,
            animateActivity: activeUiMode() === 'enhanced',
            activityTickIntervalMs: resolvedActivityTickIntervalMs,
            onPresentationError: (error) => {
              terminalFailure =
                error instanceof Error
                  ? error
                  : new Error('Terminal activity rendering failed', {
                      cause: error,
                    });
              operation.abort(terminalFailure);
            },
            ...(participants ? { participants } : {}),
          });
          revealCompletedResponses();
          return { agreed, cancelled: false };
        } catch (error) {
          revealCompletedResponses();
          if (terminalFailure) {
            throw terminalFailure;
          }
          if (operation.signal.aborted || error instanceof ProcessAbortError) {
            await store.save(session);
            writeSupplemental(
              '\nActive agent work cancelled. The chat is saved and still open.\n',
            );
            return { agreed: false, cancelled: true };
          }
          throw error;
        } finally {
          if (activeOperation === operation) {
            activeOperation = undefined;
          }
        }
      };
      /**
       * A cancelled paired exchange leaves the peer response outstanding.
       * Finish it before accepting new input, matching what reopening a chat
       * already does. Persisting a new message first would fold it into the
       * interrupted exchange, where it would draw one agent's reply instead of
       * the two an ordinary message gets. Returns false when the outstanding
       * reply is cancelled again, so the caller drops the new input unsaved.
       */
      const settlePendingExchange = async (): Promise<boolean> => {
        if (!session.pendingExchange) {
          return true;
        }
        writeSupplemental(
          `\nFinishing ${agentLabel(
            session.pendingExchange.secondAgent,
          )}'s outstanding reply from the interrupted exchange first.\n`,
        );
        const { cancelled } = await runCancellableExchange();
        return !cancelled && !session.pendingExchange;
      };
      if (uiResolution.notice) {
        terminal.write(`${uiResolution.notice}. Continuing in plain mode.\n`);
      }
      if (uiResolution.mode === 'enhanced') {
        presenter.start();
      } else {
        terminal.write(
          sanitizeTerminalText(chatIntroduction(session, presentation)),
        );
      }

      if (session.pendingExchange) {
        terminal.write('\nResuming the interrupted peer response…\n');
        await runCancellableExchange();
      }
      const initialMessage =
        options.task || options.taskFile
          ? await resolveTask(options)
          : undefined;
      if (initialMessage) {
        addPresentedMessage(session, presenter, 'user', initialMessage);
        await store.save(session);
        await runCancellableExchange();
      }

      while (!abortController.signal.aborted) {
        const input = await terminal.prompt(
          presentation.screenReader ? '\nYour message: ' : '\nYou > ',
          abortController.signal,
        );
        if (terminalFailure) {
          throw terminalFailure;
        }
        const command = parseChatInput(input ?? '/pause');
        if (command.kind === 'empty') {
          continue;
        }
        if (command.kind === 'invalid') {
          writeSupplemental(`${command.message}\n`);
          continue;
        }
        if (command.kind === 'help') {
          writeSupplemental(`\n${CHAT_HELP}`);
          continue;
        }
        if (command.kind === 'status') {
          if (await refreshProjectKind(session)) {
            await store.save(session);
          }
          writeSupplemental(
            `\n${chatStatus(session, presentation, activeUiMode())}\n`,
          );
          continue;
        }
        if (command.kind === 'history') {
          writeSupplemental(`\n${recentHistory(session, command.count)}\n`);
          continue;
        }
        if (command.kind === 'paste') {
          writeSupplemental(
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
              setPresentedStatus(session, presenter, 'paused');
              await store.save(session);
              presenter.stop();
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
          if (!(await settlePendingExchange())) {
            continue;
          }
          if (await refreshProjectKind(session)) {
            await store.save(session);
          }
          addPresentedMessage(session, presenter, 'user', text);
          await store.save(session);
          await runCancellableExchange();
          continue;
        }
        if (command.kind === 'pause') {
          setPresentedStatus(session, presenter, 'paused');
          await store.save(session);
          presenter.stop();
          terminal.write(
            `\nChat saved. Resume with:\n  agent-bridge chat --resume ${session.id}\n`,
          );
          return;
        }
        if (command.kind === 'done') {
          setPresentedStatus(session, presenter, 'completed');
          await store.save(session);
          completed = true;
          presenter.stop();
          terminal.write(`\nChat ${session.id} completed.\n`);
          return;
        }
        if (command.kind === 'message') {
          if (!(await settlePendingExchange())) {
            continue;
          }
          if (await refreshProjectKind(session)) {
            await store.save(session);
          }
          const addressedText =
            command.target && command.target !== 'both'
              ? `Addressed to ${agentLabel(command.target)}:\n${command.text}`
              : command.text;
          addPresentedMessage(session, presenter, 'user', addressedText);
          await store.save(session);
          await runCancellableExchange(
            command.target && command.target !== 'both'
              ? [command.target]
              : undefined,
          );
          continue;
        }
        if (command.kind === 'auto') {
          if (!session.messages.some((message) => message.role === 'user')) {
            writeSupplemental(
              '\nSend a message first so the agents know what to discuss.\n',
            );
            continue;
          }
          if (await refreshProjectKind(session)) {
            await store.save(session);
          }
          const rounds = command.rounds ?? session.maxAutoRounds;
          writeSupplemental(`
Automatic conversation preview
Maximum exchanges: ${rounds}
Maximum provider calls: ${rounds * 2}
It stops early if both agents agree.
`);
          if (!(await confirm('Start automatic conversation? [Y/n]: ', true))) {
            writeSupplemental('Automatic conversation cancelled.\n');
            continue;
          }
          let agreed = false;
          let cancelled = false;
          for (let round = 1; round <= rounds; round += 1) {
            terminal.write(`\nAutomatic exchange ${round}/${rounds}\n`);
            const result = await runCancellableExchange();
            agreed = result.agreed;
            cancelled = result.cancelled;
            if (agreed || cancelled) {
              break;
            }
          }
          if (!cancelled) {
            writeSupplemental(
              agreed
                ? '\nCodex and Claude agree on the current answer.\n'
                : '\nAutomatic exchange limit reached; you remain in control.\n',
            );
          }
          continue;
        }
        if (command.kind === 'workflow') {
          if (!session.messages.some((message) => message.role === 'user')) {
            writeSupplemental(
              '\nDescribe the task in a message before starting a workflow.\n',
            );
            continue;
          }
          if (await refreshProjectKind(session)) {
            await store.save(session);
          }
          if (
            session.projectKind === 'directory' &&
            command.mode !== 'review'
          ) {
            writeSupplemental(
              '\nSafe editing requires Git. Initialize this folder with `git init`, or use /review.\n',
            );
            continue;
          }
          if (
            command.mode !== 'review' &&
            !(await repositoryHasHead(session.projectRoot))
          ) {
            writeSupplemental(
              '\nSafe editing requires an initial commit. Review .gitignore, create the first commit yourself, then use /edit again. Agent Bridge will not stage or commit project files.\n',
            );
            continue;
          }
          const workflowOptions: BridgeOptions = {
            ...options,
            cwd: session.projectRoot,
            maxRounds: session.maxWorkflowRounds,
            retries: session.retries,
            timeoutMinutes: session.timeoutMinutes,
            codexModel: session.codexModel,
            claudeModel: session.claudeModel,
            codexEffort: session.codexEffort,
            claudeEffort: session.claudeEffort,
            noTranscript: session.noTranscript,
            screenReader: session.screenReader ?? options.screenReader,
            noColor: session.noColor ?? options.noColor,
            fromHead: false,
            trustProjectConfig: false,
          };
          const preflight = await inspectWorkflowPreflight({
            mode: command.mode,
            firstAgent: command.firstAgent,
            options: workflowOptions,
          });
          if (
            command.mode !== 'review' &&
            preflight.dirtyStatus &&
            workflowOptions.isolation
          ) {
            writeSupplemental(`
This project has uncommitted changes. A safe isolated workspace cannot include
them; it starts from committed HEAD and leaves those changes untouched.
`);
            if (
              !(await confirm(
                'Continue explicitly from committed HEAD? [y/N]: ',
                false,
              ))
            ) {
              writeSupplemental(
                'Editing cancelled. Commit or stash those changes, then use /edit again.\n',
              );
              continue;
            }
            workflowOptions.fromHead = true;
          }
          if (
            command.mode !== 'review' &&
            preflight.projectConfig.path &&
            preflight.projectConfig.config.verification.length > 0
          ) {
            writeSupplemental('\nProject verification commands:\n');
            for (const verification of preflight.projectConfig.config
              .verification) {
              writeSupplemental(
                `  • ${[verification.command, ...verification.args].join(' ')}\n`,
              );
            }
            workflowOptions.trustProjectConfig = await confirm(
              'Allow these commands to run after edits? [y/N]: ',
              false,
            );
          }
          writeSupplemental(
            `\n${formatWorkflowPreflight({
              mode: command.mode,
              firstAgent: command.firstAgent,
              options: workflowOptions,
              preflight,
            })}\n`,
          );
          if (!(await confirm('Start this workflow? [Y/n]: ', true))) {
            writeSupplemental(
              'Workflow cancelled. The chat is still active and no files were changed.\n',
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
              options: workflowOptions,
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
          addPresentedMessage(
            session,
            presenter,
            'system',
            `${command.mode} workflow finished with exit code ${exitCode}${
              launchError ? `: ${launchError}` : ''
            }. The next exchange should inspect the current project state before drawing conclusions.`,
          );
          await store.save(session);
          writeSupplemental(
            exitCode === 0 && !launchError
              ? '\nWorkflow finished. Any isolated edit result was handled by its apply/keep/discard prompt. You can continue the conversation or ask the agents to inspect the result.\n'
              : `\nWorkflow did not complete successfully${
                  launchError ? `: ${launchError}` : ` (exit ${exitCode})`
                }. The chat is still active.\n`,
          );
        }
      }
      throw new ProcessAbortError('Interactive chat interrupted');
    } catch (error) {
      if (terminalFailure) {
        throw terminalFailure;
      }
      if (
        cleanupMayPersist &&
        (abortController.signal.aborted || error instanceof ProcessAbortError)
      ) {
        setPresentedStatus(session, presenter, 'paused');
        await store.save(session).catch(() => {});
        presenter.stop();
        terminal.write(
          `\nChat paused safely. Resume with:\n  agent-bridge chat --resume ${session.id}\n`,
        );
        return;
      }
      throw error;
    } finally {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abortSession);
      process.removeListener('SIGHUP', abortSession);
      process.stdout.removeListener('resize', redraw);
      try {
        presenter.stop();
      } finally {
        try {
          if (
            lock &&
            cleanupMayPersist &&
            !completed &&
            session.status === 'active'
          ) {
            setPresentedStatus(session, presenter, 'paused');
            await store.save(session).catch(() => {});
          }
          if (lock && completed && session.noTranscript) {
            await store.delete(session.id);
          }
        } finally {
          try {
            await lock?.release();
          } finally {
            await rm(tempDirectory, { recursive: true, force: true });
          }
        }
      }
    }
  } finally {
    terminal.close();
  }
}
