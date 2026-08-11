import { readdir, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import {
  deriveHistoricalPairedExchangeStatus,
  describePairedExchangeStatus,
  isSafeRunId,
  recordedExchangeFinalSequence,
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

export const LEGACY_PENDING_EXCHANGE_WARNING =
  'An unfinished exchange from an older version was discarded; send a message to start a new one.';

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

export type PendingChatExchange =
  | {
      stage: 'awaiting-peer';
      firstAgent: AgentName;
      secondAgent: AgentName;
      firstMessageSequence: number;
    }
  | {
      stage: 'awaiting-confirmation';
      firstAgent: AgentName;
      secondAgent: AgentName;
      firstMessageSequence: number;
      secondMessageSequence: number;
    };

export interface SettledChatExchange {
  firstAgent: AgentName;
  secondAgent: AgentName;
  firstMessageSequence: number;
  secondMessageSequence: number;
  confirmationMessageSequence?: number;
  outcome: 'open' | 'confirmed';
}

export interface AbandonedChatExchange {
  firstAgent: AgentName;
  secondAgent: AgentName;
  firstMessageSequence: number;
  secondMessageSequence?: number;
  outcome: 'abandoned';
}

export type RecordedChatExchange = SettledChatExchange | AbandonedChatExchange;

export interface ChatSession {
  version: 4;
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
  /**
   * `true` chose color, `false` chose no color, `undefined` made no choice and
   * defers to the global preference and then to automatic detection.
   */
  color?: boolean;
  ui: UiMode;
  codexModel?: string;
  claudeModel?: string;
  codexEffort?: ReasoningEffort;
  claudeEffort?: ReasoningEffort;
  nextFirstAgent?: AgentName;
  pendingExchange?: PendingChatExchange;
  latestPairedExchange?: RecordedChatExchange;
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

const CHAT_SESSION_KEYS = [
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
  'color',
  'ui',
  'codexModel',
  'claudeModel',
  'codexEffort',
  'claudeEffort',
  'nextFirstAgent',
  'pendingExchange',
  'latestPairedExchange',
  'messages',
  'workflows',
] as const;

const VERSION_THREE_CHAT_SESSION_KEYS = CHAT_SESSION_KEYS.filter(
  (key) => key !== 'latestPairedExchange',
);

function referencedMessage(
  messages: ChatMessage[],
  sequence: unknown,
): ChatMessage | undefined {
  if (!Number.isInteger(sequence) || Number(sequence) < 1) {
    return undefined;
  }
  const message = messages[Number(sequence) - 1];
  return message?.sequence === sequence ? message : undefined;
}

function hasValidExchangeAgents(value: Record<string, unknown>): boolean {
  return (
    isAgent(value.firstAgent) &&
    isAgent(value.secondAgent) &&
    value.firstAgent !== value.secondAgent
  );
}

function isPendingExchange(
  value: unknown,
  messages: ChatMessage[],
): value is PendingChatExchange {
  if (!isRecord(value) || !hasValidExchangeAgents(value)) {
    return false;
  }
  const firstMessage = referencedMessage(messages, value.firstMessageSequence);
  if (!firstMessage || firstMessage.role !== value.firstAgent) {
    return false;
  }
  if (value.stage === 'awaiting-peer') {
    return (
      hasOnlyKeys(value, [
        'stage',
        'firstAgent',
        'secondAgent',
        'firstMessageSequence',
      ]) && firstMessage.sequence === messages.length
    );
  }
  if (
    value.stage !== 'awaiting-confirmation' ||
    !hasOnlyKeys(value, [
      'stage',
      'firstAgent',
      'secondAgent',
      'firstMessageSequence',
      'secondMessageSequence',
    ])
  ) {
    return false;
  }
  const secondMessage = referencedMessage(
    messages,
    value.secondMessageSequence,
  );
  return (
    secondMessage !== undefined &&
    secondMessage.role === value.secondAgent &&
    secondMessage.sequence === firstMessage.sequence + 1 &&
    secondMessage.sequence === messages.length &&
    firstMessage.decision === 'done' &&
    secondMessage.decision === 'done'
  );
}

function isRecordedExchange(
  value: unknown,
  messages: ChatMessage[],
): value is RecordedChatExchange {
  if (!isRecord(value) || !hasValidExchangeAgents(value)) {
    return false;
  }
  const firstMessage = referencedMessage(messages, value.firstMessageSequence);
  if (!firstMessage || firstMessage.role !== value.firstAgent) {
    return false;
  }
  if (value.outcome === 'abandoned') {
    if (
      !hasOnlyKeys(value, [
        'firstAgent',
        'secondAgent',
        'firstMessageSequence',
        'secondMessageSequence',
        'outcome',
      ])
    ) {
      return false;
    }
    if (value.secondMessageSequence === undefined) {
      return true;
    }
    const secondMessage = referencedMessage(
      messages,
      value.secondMessageSequence,
    );
    return (
      secondMessage !== undefined &&
      secondMessage.role === value.secondAgent &&
      secondMessage.sequence === firstMessage.sequence + 1 &&
      firstMessage.decision === 'done' &&
      secondMessage.decision === 'done'
    );
  }
  if (
    (value.outcome !== 'open' && value.outcome !== 'confirmed') ||
    !hasOnlyKeys(value, [
      'firstAgent',
      'secondAgent',
      'firstMessageSequence',
      'secondMessageSequence',
      'confirmationMessageSequence',
      'outcome',
    ])
  ) {
    return false;
  }
  const secondMessage = referencedMessage(
    messages,
    value.secondMessageSequence,
  );
  if (
    !secondMessage ||
    secondMessage.role !== value.secondAgent ||
    secondMessage.sequence !== firstMessage.sequence + 1
  ) {
    return false;
  }
  const confirmationMessage =
    value.confirmationMessageSequence === undefined
      ? undefined
      : referencedMessage(messages, value.confirmationMessageSequence);
  if (value.confirmationMessageSequence !== undefined && !confirmationMessage) {
    return false;
  }
  if (
    confirmationMessage &&
    (confirmationMessage.role !== value.firstAgent ||
      confirmationMessage.sequence !== secondMessage.sequence + 1)
  ) {
    return false;
  }
  if (value.outcome === 'confirmed') {
    return (
      confirmationMessage !== undefined &&
      firstMessage.decision === 'done' &&
      secondMessage.decision === 'done' &&
      confirmationMessage.decision === 'done'
    );
  }
  if (confirmationMessage) {
    return (
      firstMessage.decision === 'done' &&
      secondMessage.decision === 'done' &&
      confirmationMessage.decision === 'continue'
    );
  }
  return (
    firstMessage.decision === 'continue' ||
    secondMessage.decision === 'continue'
  );
}

function hasValidCommonSessionFields(value: Record<string, unknown>): boolean {
  const session = value as Partial<ChatSession>;
  return (
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
    (session.color === undefined || typeof session.color === 'boolean') &&
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
    Array.isArray(session.workflows) &&
    session.workflows.every(isWorkflowEvent) &&
    session.workflows.every((event, index) => event.sequence === index + 1)
  );
}

function isLegacyPendingExchange(
  value: unknown,
  messages: ChatMessage[],
): value is Omit<
  Extract<PendingChatExchange, { stage: 'awaiting-peer' }>,
  'stage'
> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'firstAgent',
      'secondAgent',
      'firstMessageSequence',
    ]) ||
    !hasValidExchangeAgents(value)
  ) {
    return false;
  }
  const firstMessage = referencedMessage(messages, value.firstMessageSequence);
  return firstMessage !== undefined && firstMessage.role === value.firstAgent;
}

function isVersionThreeChatSession(value: unknown): value is Record<
  string,
  unknown
> & {
  version: 3;
  status: ChatStatus;
  pendingExchange?: Omit<
    Extract<PendingChatExchange, { stage: 'awaiting-peer' }>,
    'stage'
  >;
  messages: ChatMessage[];
} {
  if (
    !isRecord(value) ||
    value.version !== 3 ||
    !hasOnlyKeys(value, VERSION_THREE_CHAT_SESSION_KEYS) ||
    !hasValidCommonSessionFields(value)
  ) {
    return false;
  }
  const messages = value.messages as ChatMessage[];
  return (
    value.pendingExchange === undefined ||
    isLegacyPendingExchange(value.pendingExchange, messages)
  );
}

export function isChatSession(value: unknown): value is ChatSession {
  if (
    !isRecord(value) ||
    value.version !== 4 ||
    !hasOnlyKeys(value, CHAT_SESSION_KEYS) ||
    !hasValidCommonSessionFields(value)
  ) {
    return false;
  }
  const session = value as unknown as ChatSession;
  if (
    session.pendingExchange !== undefined &&
    !isPendingExchange(session.pendingExchange, session.messages)
  ) {
    return false;
  }
  if (
    session.latestPairedExchange !== undefined &&
    !isRecordedExchange(session.latestPairedExchange, session.messages)
  ) {
    return false;
  }
  if (session.status === 'completed' && session.pendingExchange) {
    return false;
  }
  return !(
    session.pendingExchange &&
    session.latestPairedExchange &&
    session.pendingExchange.firstMessageSequence <=
      recordedExchangeFinalSequence(session.latestPairedExchange)
  );
}

/**
 * Converts a stored `noColor` boolean into the tri-state `color` choice.
 *
 * The asymmetry is deliberate. The CLI that wrote `noColor` had no positive
 * `--color`, so `false` only ever meant "nothing was said" — `NO_COLOR` and a
 * redirected stream still suppressed color. Reading it as an explicit `true`
 * would silently promote every legacy session to overriding `NO_COLOR`.
 * `true`, by contrast, could only come from `--no-color` or the screen-reader
 * choice, so it carries forward as a real preference.
 */
function migratedColorChoice(noColor: unknown): boolean | undefined {
  return noColor === true ? false : undefined;
}

/**
 * Rejects legacy records whose version-specific fields were never valid, so a
 * migration cannot launder them into an acceptable current record. Migration
 * transforms a record before validation runs, so anything it drops or rewrites
 * has to be checked here instead: dropping a malformed `noColor` would present
 * it as "no choice was made", and `color` did not exist before version 3, so a
 * record carrying it was never a legitimate version 1 or 2 checkpoint.
 */
function hasValidLegacyFields(value: Record<string, unknown>): boolean {
  return (
    !('color' in value) &&
    (!('noColor' in value) || typeof value.noColor === 'boolean')
  );
}

function migrateChatSession(
  value: unknown,
  onWarning: (message: string) => void,
): unknown {
  if (!isRecord(value)) {
    return value;
  }
  // An unmigrated version is rejected by validation, which is what an invalid
  // legacy record should get rather than a silently repaired one.
  if (
    (value.version === 1 || value.version === 2) &&
    !hasValidLegacyFields(value)
  ) {
    return value;
  }
  let migrated = value;
  if (migrated.version === 1) {
    migrated = {
      ...migrated,
      version: 2,
      maxWorkflowRounds: migrated.maxAutoRounds,
      ui: 'plain',
    };
  }
  if (migrated.version === 2) {
    const { noColor, ...rest } = migrated;
    const color = migratedColorChoice(noColor);
    migrated = {
      ...rest,
      version: 3,
      ...(color === undefined ? {} : { color }),
    };
  }
  if (migrated.version === 3) {
    if (!isVersionThreeChatSession(migrated)) {
      return migrated;
    }
    const pending = migrated.pendingExchange;
    if (!pending) {
      return { ...migrated, version: 4 };
    }
    const rest: Record<string, unknown> = { ...migrated };
    delete rest.pendingExchange;
    if (pending.firstMessageSequence !== migrated.messages.length) {
      onWarning(LEGACY_PENDING_EXCHANGE_WARNING);
      return { ...rest, version: 4 };
    }
    if (migrated.status === 'completed') {
      return {
        ...rest,
        version: 4,
        latestPairedExchange: {
          firstAgent: pending.firstAgent,
          secondAgent: pending.secondAgent,
          firstMessageSequence: pending.firstMessageSequence,
          outcome: 'abandoned',
        },
      };
    }
    return {
      ...rest,
      version: 4,
      pendingExchange: {
        stage: 'awaiting-peer',
        ...pending,
      },
    };
  }
  return migrated;
}

export function formatChatTranscript(session: ChatSession): string {
  const exchangeStatus = deriveHistoricalPairedExchangeStatus({
    messages: session.messages,
    pendingStage: session.pendingExchange?.stage,
    latestExchange: session.latestPairedExchange,
  });
  const lines = [
    '# Agent Bridge Interactive Chat',
    '',
    `- Session: ${session.id}`,
    `- Started: ${session.createdAt}`,
    `- Updated: ${session.updatedAt}`,
    `- Status: ${session.status}`,
    `- Project: ${session.projectRoot}`,
    `- Project type: ${session.projectKind}`,
    `- Latest paired exchange: ${describePairedExchangeStatus(exchangeStatus)}`,
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
    // The JSON checkpoint is authoritative. Prepare its derived transcript
    // first so a transcript failure cannot make a response durable after
    // save() reports that the checkpoint failed. A JSON write failure may
    // leave a newer transcript temporarily, but load/resume continues from the
    // last valid JSON and the next successful save repairs the transcript.
    if (session.noTranscript) {
      await rm(this.transcriptPathFor(session.id), { force: true });
    } else {
      await writePrivateFileAtomic(
        this.transcriptPathFor(session.id),
        formatChatTranscript(persisted),
      );
    }
    await writePrivateFileAtomic(destination, serialized);
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
      this.#onWarning,
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
      // The lock is a directory, so its removal has to be recursive. Deletion
      // holds the lock while doing this, so it is removing its own.
      rm(this.lockPathFor(id), { force: true, recursive: true }),
    ]);
  }
}
