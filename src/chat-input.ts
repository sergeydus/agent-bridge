import type { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import type { ChatWorkflowMode } from './chat-state.ts';
import type { AgentName } from './core.ts';
import { MAX_CHAT_HISTORY_CHARS } from './prompts.ts';

export const MAX_USER_MESSAGE_CHARS = Math.min(
  32_000,
  MAX_CHAT_HISTORY_CHARS - 1_000,
);

export const CHAT_HELP = `Interactive chat commands

  Type a message                 Discuss with both agents; files stay unchanged
  /ask codex|claude <message>    Ask only one agent
  /both <message>                Explicitly ask both agents
  @codex|@claude|@both <message> Short form for a targeted message
  /auto [1-20]                   Continue until reciprocal confirmation or the limit
  /edit [codex|claude]           Safely alternate editing and review
  /implement codex|claude        Named agent edits; the other agent reviews
  /collaborate codex|claude      Plan, then alternate editing and reviewing
  /review                        Review to agreement without changing files
  /paste                        Enter a multiline message; finish with "." alone
  /status                       Show session, project, and paired-exchange state
  /history [1-50]               Show recent messages
  /help                         Show these commands
  /pause                        Save and leave; resume with chat --resume <id>
  /done                         Complete; confirms before abandoning pending work

  Ctrl+C cancels active agent work; press it at the prompt to save and leave.
  Lines typed while agents work are queued for the next prompt, never inserted
  between the two agents in the current exchange.
`;

export interface ChatTerminal {
  prompt(label: string, signal?: AbortSignal): Promise<string | null>;
  write(text: string): void;
  redrawPrompt(): void;
  setQueuedInputObserver(observer?: (count: number) => void): void;
  pause(): void;
  resume(): void;
  close(): void;
}

export interface ChatReadlineOptions {
  input: Readable;
  output: Writable;
  completer: (line: string) => [string[], string];
  historySize: number;
  removeHistoryDuplicates: boolean;
}

export interface ChatReadline {
  readonly line: string;
  readonly cursor: number;
  on(event: 'line', listener: (line: string) => void): this;
  on(event: 'close' | 'SIGINT', listener: () => void): this;
  setPrompt(prompt: string): void;
  prompt(preserveCursor?: boolean): void;
  pause(): void;
  resume(): void;
  close(): void;
}

export type ChatReadlineFactory = (
  options: ChatReadlineOptions,
) => ChatReadline;

export interface ChatTerminalDependencies {
  input?: Readable;
  output?: Writable;
  signalEmitter?: Pick<EventEmitter, 'emit'>;
  createReadline?: ChatReadlineFactory;
}

export type ChatCommand =
  | { kind: 'message'; text: string; target?: AgentName | 'both' }
  | { kind: 'auto'; rounds?: number }
  | { kind: 'workflow'; mode: ChatWorkflowMode; firstAgent?: AgentName }
  | { kind: 'history'; count: number }
  | { kind: 'status' | 'help' | 'paste' | 'pause' | 'done' | 'empty' }
  | { kind: 'invalid'; message: string };

function parseAgent(value: string | undefined): AgentName | undefined {
  const normalized = value?.toLowerCase();
  return normalized === 'codex' || normalized === 'claude'
    ? normalized
    : undefined;
}

/**
 * Returns everything after the given leading tokens with its original spacing.
 * Only the separators between the command tokens are consumed, so runs of
 * spaces and indentation inside the message survive untouched.
 */
function messageAfter(input: string, leadingTokens: string[]): string {
  let offset = 0;
  for (const token of leadingTokens) {
    if (!token) {
      continue;
    }
    const index = input.indexOf(token, offset);
    if (index < 0) {
      return '';
    }
    offset = index + token.length;
  }
  return input.slice(offset).trim();
}

export function parseChatInput(input: string): ChatCommand {
  const trimmed = input.trim();
  if (!trimmed) {
    return { kind: 'empty' };
  }
  if (!trimmed.startsWith('/')) {
    const mention = /^@(codex|claude|both)\s+([\s\S]+)$/i.exec(trimmed);
    if (mention?.[1] && mention[2]?.trim()) {
      const text = mention[2].trim();
      if (text.length > MAX_USER_MESSAGE_CHARS) {
        return {
          kind: 'invalid',
          message: `Message exceeds ${MAX_USER_MESSAGE_CHARS.toLocaleString()} characters.`,
        };
      }
      return {
        kind: 'message',
        text,
        target: mention[1].toLowerCase() as AgentName | 'both',
      };
    }
    if (trimmed.length > MAX_USER_MESSAGE_CHARS) {
      return {
        kind: 'invalid',
        message: `Message exceeds ${MAX_USER_MESSAGE_CHARS.toLocaleString()} characters.`,
      };
    }
    return { kind: 'message', text: trimmed };
  }
  const [rawCommand = '', ...arguments_] = trimmed.split(/\s+/);
  const rawArgument = arguments_[0];
  const extra = arguments_.slice(1);
  const command = rawCommand.toLowerCase();
  if (extra.length > 0 && command !== '/ask' && command !== '/both') {
    return { kind: 'invalid', message: `Too many arguments for ${command}.` };
  }
  if (command === '/ask') {
    const target = parseAgent(rawArgument);
    // Splitting on whitespace is fine for locating the command and its target,
    // but the message itself must keep the spacing the user typed: rejoining
    // the split pieces would flatten indentation in pasted code.
    const text = messageAfter(trimmed, [rawCommand, rawArgument ?? '']);
    if (!target || !text) {
      return {
        kind: 'invalid',
        message: '/ask expects codex or claude followed by a message.',
      };
    }
    return text.length <= MAX_USER_MESSAGE_CHARS
      ? { kind: 'message', target, text }
      : {
          kind: 'invalid',
          message: `Message exceeds ${MAX_USER_MESSAGE_CHARS.toLocaleString()} characters.`,
        };
  }
  if (command === '/both') {
    const text = messageAfter(trimmed, [rawCommand]);
    if (!text) {
      return {
        kind: 'invalid',
        message: '/both expects a message.',
      };
    }
    return text.length <= MAX_USER_MESSAGE_CHARS
      ? { kind: 'message', target: 'both', text }
      : {
          kind: 'invalid',
          message: `Message exceeds ${MAX_USER_MESSAGE_CHARS.toLocaleString()} characters.`,
        };
  }
  if (command === '/help') {
    return rawArgument === undefined
      ? { kind: 'help' }
      : { kind: 'invalid', message: '/help does not accept arguments.' };
  }
  if (command === '/status') {
    return rawArgument === undefined
      ? { kind: 'status' }
      : { kind: 'invalid', message: '/status does not accept arguments.' };
  }
  if (command === '/paste') {
    return rawArgument === undefined
      ? { kind: 'paste' }
      : { kind: 'invalid', message: '/paste does not accept arguments.' };
  }
  if (command === '/pause' || command === '/quit' || command === '/exit') {
    return rawArgument === undefined
      ? { kind: 'pause' }
      : { kind: 'invalid', message: `${command} does not accept arguments.` };
  }
  if (command === '/done') {
    return rawArgument === undefined
      ? { kind: 'done' }
      : { kind: 'invalid', message: '/done does not accept arguments.' };
  }
  if (command === '/auto') {
    if (rawArgument === undefined) {
      return { kind: 'auto' };
    }
    const rounds = Number(rawArgument);
    return Number.isInteger(rounds) && rounds >= 1 && rounds <= 20
      ? { kind: 'auto', rounds }
      : {
          kind: 'invalid',
          message: '/auto expects a whole number from 1 to 20.',
        };
  }
  if (command === '/history') {
    const count = rawArgument === undefined ? 10 : Number(rawArgument);
    return Number.isInteger(count) && count >= 1 && count <= 50
      ? { kind: 'history', count }
      : {
          kind: 'invalid',
          message: '/history expects a whole number from 1 to 50.',
        };
  }
  if (command === '/review' && rawArgument === undefined) {
    return { kind: 'workflow', mode: 'review' };
  }
  if (command === '/edit') {
    const firstAgent =
      rawArgument === undefined ? 'claude' : parseAgent(rawArgument);
    if (!firstAgent) {
      return {
        kind: 'invalid',
        message: '/edit accepts codex or claude as an optional first editor.',
      };
    }
    return { kind: 'workflow', mode: 'collaborative', firstAgent };
  }
  if (command === '/implement' || command === '/collaborate') {
    const firstAgent = parseAgent(rawArgument);
    if (!firstAgent) {
      return {
        kind: 'invalid',
        message: `${command} expects codex or claude.`,
      };
    }
    return {
      kind: 'workflow',
      mode: command === '/implement' ? 'fixed' : 'collaborative',
      firstAgent,
    };
  }
  return {
    kind: 'invalid',
    message: `Unknown command: ${rawCommand}. Use /help to see available commands.`,
  };
}

const CHAT_COMPLETIONS = [
  '/ask codex ',
  '/ask claude ',
  '/both ',
  '/auto ',
  '/edit',
  '/edit codex',
  '/edit claude',
  '/implement codex',
  '/implement claude',
  '/collaborate codex',
  '/collaborate claude',
  '/review',
  '/paste',
  '/status',
  '/history ',
  '/help',
  '/pause',
  '/done',
  '@codex ',
  '@claude ',
  '@both ',
];

export function completeChatInput(line: string): [string[], string] {
  const matches = CHAT_COMPLETIONS.filter((completion) =>
    completion.startsWith(line.toLowerCase()),
  );
  return [line.length === 0 ? CHAT_COMPLETIONS : matches, line];
}

export function createChatTerminal({
  input = process.stdin,
  output = process.stdout,
  signalEmitter = process,
  createReadline = (options) => createInterface(options),
}: ChatTerminalDependencies = {}): ChatTerminal {
  const interface_ = createReadline({
    input,
    output,
    completer: completeChatInput,
    historySize: 100,
    removeHistoryDuplicates: true,
  });
  const queuedLines: string[] = [];
  let queueObserver: ((count: number) => void) | undefined;
  const reportQueue = (): void => queueObserver?.(queuedLines.length);
  let closed = false;
  let promptInitialized = false;
  let pending:
    | {
        resolve: (value: string | null) => void;
        removeAbortListener: () => void;
      }
    | undefined;

  interface_.on('line', (line) => {
    if (!pending) {
      queuedLines.push(line);
      reportQueue();
      return;
    }
    const current = pending;
    pending = undefined;
    current.removeAbortListener();
    current.resolve(line);
  });
  interface_.on('close', () => {
    closed = true;
    if (pending) {
      const current = pending;
      pending = undefined;
      current.removeAbortListener();
      current.resolve(null);
    }
  });
  interface_.on('SIGINT', () => {
    signalEmitter.emit('SIGINT');
  });

  return {
    prompt(label, signal) {
      const queued = queuedLines.shift();
      if (queued !== undefined) {
        interface_.setPrompt(label);
        promptInitialized = true;
        output.write(label);
        reportQueue();
        return Promise.resolve(queued);
      }
      if (closed || signal?.aborted) {
        return Promise.resolve(null);
      }
      interface_.setPrompt(label);
      promptInitialized = true;
      if (interface_.line) {
        interface_.prompt(true);
      } else {
        interface_.prompt();
      }
      return new Promise<string | null>((resolvePromise) => {
        const onAbort = (): void => {
          // Defensive only: this can differ when prompts overlap, while the
          // coordinator awaits every prompt before starting another one.
          if (pending?.resolve !== resolvePromise) {
            return;
          }
          pending = undefined;
          resolvePromise(null);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        pending = {
          resolve: resolvePromise,
          removeAbortListener: () =>
            signal?.removeEventListener('abort', onAbort),
        };
      });
    },
    write(text) {
      output.write(text);
    },
    redrawPrompt() {
      if (promptInitialized && !closed) {
        interface_.prompt(true);
      }
    },
    setQueuedInputObserver(observer) {
      queueObserver = observer;
      reportQueue();
    },
    pause() {
      interface_.pause();
    },
    resume() {
      interface_.resume();
    },
    close() {
      interface_.close();
    },
  };
}
