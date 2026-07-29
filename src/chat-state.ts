import { readdir, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import {
  isSafeRunId,
  type AgentDecision,
  type AgentName,
  type ProjectKind,
  type ReasoningEffort,
} from './core.ts';
import { acquireFileLock, FileLock } from './file-lock.ts';
import { readFilePrefixBytes, writePrivateFileAtomic } from './filesystem.ts';
import type { UiMode } from './terminal-capabilities.ts';
import { sanitizeTerminalText } from './terminal-text.ts';

const MAX_CHAT_FILE_BYTES = 50_000_000;
const MAX_CHAT_MESSAGES = 10_000;
const MAX_CHAT_MESSAGE_CHARS = 2_000_000;

export type ChatStatus = 'active' | 'paused' | 'completed';
export type ChatRole = 'user' | 'codex' | 'claude' | 'system';
export type ChatWorkflowMode = 'review' | 'fixed' | 'collaborative';

export interface ChatMessage {
  sequence: number;
  createdAt: string;
  role: ChatRole;
  text: string;
  decision?: AgentDecision;
}

export interface ChatWorkflowEvent {
  sequence: number;
  startedAt: string;
  completedAt: string;
  mode: ChatWorkflowMode;
  firstAgent?: AgentName;
  exitCode: number;
}

export interface PendingChatExchange {
  firstAgent: AgentName;
  secondAgent: AgentName;
  firstMessageSequence: number;
}

export interface ChatSession {
  version: 2;
  id: string;
  createdAt: string;
  updatedAt: string;
  status: ChatStatus;
  projectRoot: string;
  projectKind: ProjectKind;
  maxAutoRounds: number;
  maxWorkflowRounds: number;
  retries: number;
  timeoutMinutes: number;
  noTranscript: boolean;
  screenReader?: boolean;
  noColor?: boolean;
  ui: UiMode;
  codexModel?: string;
  claudeModel?: string;
  codexEffort?: ReasoningEffort;
  claudeEffort?: ReasoningEffort;
  nextFirstAgent?: AgentName;
  pendingExchange?: PendingChatExchange;
  messages: ChatMessage[];
  workflows: ChatWorkflowEvent[];
}

export { FileLock as ChatLock };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isIsoDateTime(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const timestamp = Date.parse(value);
  return (
    !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function isAgent(value: unknown): value is AgentName {
  return value === 'codex' || value === 'claude';
}

function isEffort(value: unknown): value is ReasoningEffort {
  return ['low', 'medium', 'high', 'xhigh', 'max'].includes(String(value));
}

function isMessage(value: unknown): value is ChatMessage {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !hasOnlyKeys(value, ['sequence', 'createdAt', 'role', 'text', 'decision'])
  ) {
    return false;
  }
  const isAgentRole = value.role === 'codex' || value.role === 'claude';
  const hasValidDecision = isAgentRole
    ? value.decision === 'done' || value.decision === 'continue'
    : value.decision === undefined;
  return (
    Number.isInteger(value.sequence) &&
    Number(value.sequence) >= 1 &&
    isIsoDateTime(value.createdAt) &&
    ['user', 'codex', 'claude', 'system'].includes(String(value.role)) &&
    typeof value.text === 'string' &&
    value.text.length > 0 &&
    value.text.length <= MAX_CHAT_MESSAGE_CHARS &&
    hasValidDecision
  );
}

function isWorkflowEvent(value: unknown): value is ChatWorkflowEvent {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !hasOnlyKeys(value, [
      'sequence',
      'startedAt',
      'completedAt',
      'mode',
      'firstAgent',
      'exitCode',
    ])
  ) {
    return false;
  }
  return (
    Number.isInteger(value.sequence) &&
    Number(value.sequence) >= 1 &&
    isIsoDateTime(value.startedAt) &&
    isIsoDateTime(value.completedAt) &&
    ['review', 'fixed', 'collaborative'].includes(String(value.mode)) &&
    (value.mode === 'review'
      ? value.firstAgent === undefined
      : isAgent(value.firstAgent)) &&
    Date.parse(String(value.completedAt)) >=
      Date.parse(String(value.startedAt)) &&
    Number.isInteger(value.exitCode) &&
    Number(value.exitCode) >= 0 &&
    Number(value.exitCode) <= 255
  );
}

function isPendingExchange(
  value: unknown,
  messages: ChatMessage[],
): value is PendingChatExchange {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'firstAgent',
      'secondAgent',
      'firstMessageSequence',
    ]) ||
    !isAgent(value.firstAgent) ||
    !isAgent(value.secondAgent) ||
    value.firstAgent === value.secondAgent ||
    !Number.isInteger(value.firstMessageSequence)
  ) {
    return false;
  }
  const firstMessage = messages[Number(value.firstMessageSequence) - 1];
  return (
    Number(value.firstMessageSequence) >= 1 &&
    firstMessage !== undefined &&
    firstMessage.sequence === value.firstMessageSequence &&
    firstMessage.role === value.firstAgent
  );
}

export function isChatSession(value: unknown): value is ChatSession {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !hasOnlyKeys(value, [
      'version',
      'id',
      'createdAt',
      'updatedAt',
      'status',
      'projectRoot',
      'projectKind',
      'maxAutoRounds',
      'maxWorkflowRounds',
      'retries',
      'timeoutMinutes',
      'noTranscript',
      'screenReader',
      'noColor',
      'ui',
      'codexModel',
      'claudeModel',
      'codexEffort',
      'claudeEffort',
      'nextFirstAgent',
      'pendingExchange',
      'messages',
      'workflows',
    ])
  ) {
    return false;
  }
  const session = value as Partial<ChatSession>;
  return (
    session.version === 2 &&
    typeof session.id === 'string' &&
    isSafeRunId(session.id) &&
    isIsoDateTime(session.createdAt) &&
    isIsoDateTime(session.updatedAt) &&
    ['active', 'paused', 'completed'].includes(String(session.status)) &&
    typeof session.projectRoot === 'string' &&
    Boolean(session.projectRoot) &&
    isAbsolute(session.projectRoot) &&
    (session.projectKind === 'git' || session.projectKind === 'directory') &&
    Number.isInteger(session.maxAutoRounds) &&
    (session.maxAutoRounds ?? 0) >= 1 &&
    (session.maxAutoRounds ?? 21) <= 20 &&
    Number.isInteger(session.maxWorkflowRounds) &&
    (session.maxWorkflowRounds ?? 0) >= 1 &&
    (session.maxWorkflowRounds ?? 21) <= 20 &&
    Number.isInteger(session.retries) &&
    (session.retries ?? -1) >= 0 &&
    (session.retries ?? 4) <= 3 &&
    Number.isInteger(session.timeoutMinutes) &&
    (session.timeoutMinutes ?? 0) >= 1 &&
    (session.timeoutMinutes ?? 181) <= 180 &&
    typeof session.noTranscript === 'boolean' &&
    (session.screenReader === undefined ||
      typeof session.screenReader === 'boolean') &&
    (session.noColor === undefined || typeof session.noColor === 'boolean') &&
    ['plain', 'enhanced', 'auto'].includes(String(session.ui)) &&
    (session.codexModel === undefined ||
      typeof session.codexModel === 'string') &&
    (session.claudeModel === undefined ||
      typeof session.claudeModel === 'string') &&
    (session.codexEffort === undefined || isEffort(session.codexEffort)) &&
    (session.claudeEffort === undefined || isEffort(session.claudeEffort)) &&
    (session.nextFirstAgent === undefined || isAgent(session.nextFirstAgent)) &&
    Array.isArray(session.messages) &&
    session.messages.length <= MAX_CHAT_MESSAGES &&
    session.messages.every(isMessage) &&
    session.messages.every(
      (message, index) => message.sequence === index + 1,
    ) &&
    (session.pendingExchange === undefined ||
      isPendingExchange(session.pendingExchange, session.messages)) &&
    Array.isArray(session.workflows) &&
    session.workflows.every(isWorkflowEvent) &&
    session.workflows.every((event, index) => event.sequence === index + 1)
  );
}

function migrateChatSession(value: unknown): unknown {
  if (!isRecord(value) || value.version !== 1) {
    return value;
  }
  return {
    ...value,
    version: 2,
    maxWorkflowRounds: value.maxAutoRounds,
    ui: 'plain',
  };
}

export function formatChatTranscript(session: ChatSession): string {
  const lines = [
    '# Agent Bridge Interactive Chat',
    '',
    `- Session: ${session.id}`,
    `- Started: ${session.createdAt}`,
    `- Updated: ${session.updatedAt}`,
    `- Status: ${session.status}`,
    `- Project: ${session.projectRoot}`,
    `- Project type: ${session.projectKind}`,
    '',
  ];
  for (const message of session.messages) {
    const label = {
      user: 'You',
      codex: 'Codex',
      claude: 'Claude',
      system: 'Agent Bridge',
    }[message.role];
    lines.push(
      `## ${message.sequence}. ${label}`,
      '',
      message.text,
      ...(message.decision ? ['', `Decision: \`${message.decision}\``] : []),
      '',
    );
  }
  if (session.workflows.length > 0) {
    lines.push('## Linked workflows', '');
    for (const workflow of session.workflows) {
      lines.push(
        `- ${workflow.completedAt}: ${workflow.mode}${
          workflow.firstAgent ? ` (${workflow.firstAgent})` : ''
        }, exit ${workflow.exitCode}`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function formatChatList(sessions: ChatSession[]): string {
  if (sessions.length === 0) {
    return 'No saved Agent Bridge chats.';
  }
  return [
    'CHAT ID                                    STATUS      MESSAGES  PROJECT',
    ...sessions.map(
      (session) =>
        `${session.id.padEnd(42)} ${session.status.padEnd(11)} ${String(
          session.messages.length,
        ).padEnd(9)} ${sanitizeTerminalText(session.projectRoot)}`,
    ),
  ].join('\n');
}

export class ChatSessionStore {
  #directory: string;
  #onWarning: (message: string) => void;

  constructor(
    directory: string,
    onWarning: (message: string) => void = () => {},
  ) {
    this.#directory = directory;
    this.#onWarning = onWarning;
  }

  pathFor(id: string): string {
    if (!isSafeRunId(id)) {
      throw new Error(`Unsafe chat id: ${id}`);
    }
    return join(this.#directory, `${id}.json`);
  }

  transcriptPathFor(id: string): string {
    if (!isSafeRunId(id)) {
      throw new Error(`Unsafe chat id: ${id}`);
    }
    return join(this.#directory, `${id}.md`);
  }

  lockPathFor(id: string): string {
    if (!isSafeRunId(id)) {
      throw new Error(`Unsafe chat id: ${id}`);
    }
    return join(this.#directory, `${id}.lock`);
  }

  acquireLock(id: string): Promise<FileLock> {
    return acquireFileLock({
      path: this.lockPathFor(id),
      activeMessage: `Chat ${id} is already open in another Agent Bridge process.`,
    });
  }

  async save(session: ChatSession): Promise<void> {
    const persisted: ChatSession = {
      ...session,
      updatedAt: new Date().toISOString(),
    };
    if (!isChatSession(persisted)) {
      throw new Error(`Refusing to save invalid chat: ${session.id}`);
    }
    const serialized = `${JSON.stringify(persisted, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_CHAT_FILE_BYTES) {
      throw new Error(
        'This chat reached the 50 MB local history limit. Complete it and start a new chat.',
      );
    }
    const destination = this.pathFor(session.id);
    await writePrivateFileAtomic(destination, serialized);
    if (session.noTranscript) {
      await rm(this.transcriptPathFor(session.id), { force: true });
    } else {
      await writePrivateFileAtomic(
        this.transcriptPathFor(session.id),
        formatChatTranscript(persisted),
      );
    }
    Object.assign(session, persisted);
  }

  async load(id: string): Promise<ChatSession> {
    const path = this.pathFor(id);
    let contents: Buffer;
    try {
      contents = await readFilePrefixBytes({
        path,
        maxBytes: MAX_CHAT_FILE_BYTES + 1,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Saved chat not found: ${id}`, { cause: error });
      }
      throw error;
    }
    if (contents.length > MAX_CHAT_FILE_BYTES) {
      throw new Error(`Saved chat is larger than 50 MB: ${id}`);
    }
    const parsed: unknown = migrateChatSession(
      JSON.parse(contents.toString('utf8')),
    );
    if (!isChatSession(parsed)) {
      throw new Error(`Invalid saved chat: ${id}`);
    }
    return parsed;
  }

  async list(): Promise<ChatSession[]> {
    let names: string[];
    try {
      names = await readdir(this.#directory);
    } catch {
      return [];
    }
    const sessions = await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          try {
            return await this.load(name.slice(0, -5));
          } catch (error) {
            this.#onWarning(
              `Ignoring invalid saved chat ${name}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return null;
          }
        }),
    );
    return sessions
      .filter((session): session is ChatSession => session !== null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async latest(): Promise<ChatSession | null> {
    return (await this.list())[0] ?? null;
  }

  async delete(id: string): Promise<void> {
    await Promise.all([
      rm(this.pathFor(id), { force: true }),
      rm(this.transcriptPathFor(id), { force: true }),
      rm(this.lockPathFor(id), { force: true }),
    ]);
  }
}
