import { randomUUID } from 'node:crypto';

export type AgentName = 'codex' | 'claude';
export type WorkflowKind = 'review' | 'fixed' | 'collaborative';
export type AgentDecision = 'done' | 'continue';
export type PairedExchangeStatus =
  | 'none'
  | 'pending-peer'
  | 'pending-confirmation'
  | 'open'
  | 'both-done'
  | 'confirmed'
  | 'abandoned';
export type PendingExchangeStage = 'awaiting-peer' | 'awaiting-confirmation';
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ProjectKind = 'git' | 'directory';
export type RunOutcome =
  | 'agreed'
  | 'completed-fixed-rounds'
  | 'agreement-cap-reached'
  | 'failed'
  | 'cancelled';
export type RunStatus =
  | 'created'
  | 'planning'
  | 'implementing'
  | 'reviewing'
  | 'synthesizing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface WorkflowSelection {
  kind: WorkflowKind;
  firstAgent?: AgentName;
  maxRounds: number;
}

export interface CallEstimate {
  minimum: number;
  maximum: number;
  description: string;
}

export interface ChangeSummary {
  files: string[];
  stagedFiles: number;
  modifiedFiles: number;
  untrackedFiles: number;
}

export interface PairedExchangeMessage {
  readonly sequence: number;
  readonly role: string;
  readonly decision?: AgentDecision;
}

export interface PairedExchangeRecord {
  readonly firstMessageSequence: number;
  readonly secondMessageSequence?: number;
  readonly confirmationMessageSequence?: number;
  readonly outcome: 'open' | 'confirmed' | 'abandoned';
}

function deriveLegacyPairedExchangeStatus(
  messages: readonly PairedExchangeMessage[],
): PairedExchangeStatus {
  const latest = messages.slice(-2);
  if (
    latest.length !== 2 ||
    !latest.every(
      (message) => message.role === 'codex' || message.role === 'claude',
    ) ||
    latest[0]?.role === latest[1]?.role
  ) {
    return 'none';
  }
  return latest.every((message) => message.decision === 'done')
    ? 'both-done'
    : 'open';
}

function pendingExchangeStatus(
  stage: PendingExchangeStage | undefined,
): PairedExchangeStatus | undefined {
  if (stage === 'awaiting-peer') {
    return 'pending-peer';
  }
  if (stage === 'awaiting-confirmation') {
    return 'pending-confirmation';
  }
  return undefined;
}

export function recordedExchangeFinalSequence(
  exchange: PairedExchangeRecord,
): number {
  return (
    exchange.confirmationMessageSequence ??
    exchange.secondMessageSequence ??
    exchange.firstMessageSequence
  );
}

export function deriveCurrentPairedExchangeStatus({
  messages,
  pendingStage,
  latestExchange,
}: {
  messages: readonly PairedExchangeMessage[];
  pendingStage?: PendingExchangeStage;
  latestExchange?: PairedExchangeRecord;
}): PairedExchangeStatus {
  const pending = pendingExchangeStatus(pendingStage);
  if (pending) {
    return pending;
  }
  if (latestExchange) {
    return messages.at(-1)?.sequence ===
      recordedExchangeFinalSequence(latestExchange)
      ? latestExchange.outcome
      : 'none';
  }
  return deriveLegacyPairedExchangeStatus(messages);
}

export function deriveHistoricalPairedExchangeStatus({
  messages,
  pendingStage,
  latestExchange,
}: {
  messages: readonly PairedExchangeMessage[];
  pendingStage?: PendingExchangeStage;
  latestExchange?: PairedExchangeRecord;
}): PairedExchangeStatus {
  return (
    pendingExchangeStatus(pendingStage) ??
    latestExchange?.outcome ??
    deriveLegacyPairedExchangeStatus(messages)
  );
}

export function describePairedExchangeStatus(
  status: PairedExchangeStatus,
): string {
  switch (status) {
    case 'none':
      return 'none yet';
    case 'pending-peer':
      return 'waiting for peer response';
    case 'pending-confirmation':
      return 'waiting for reciprocal confirmation';
    case 'open':
      return 'open; another exchange may help';
    case 'both-done':
      return 'both agents marked the legacy pair done; not reciprocally confirmed';
    case 'confirmed':
      return 'both agents reciprocally marked this exchange done';
    case 'abandoned':
      return 'exchange left unfinished when the session was completed';
  }
}

export function otherAgent(agent: AgentName): AgentName {
  return agent === 'codex' ? 'claude' : 'codex';
}

export function editorForRound(
  firstAgent: AgentName,
  round: number,
): AgentName {
  if (!Number.isInteger(round) || round < 1) {
    throw new Error('round must be a positive integer');
  }
  return round % 2 === 1 ? firstAgent : otherAgent(firstAgent);
}

/**
 * Compatibility parser for older providers. New providers use JSON Schema.
 * A legacy status is accepted only when it is the one final tag in the answer.
 */
export function legacyDecision(answer: string): AgentDecision | null {
  const matches = [
    ...answer.matchAll(/<status>\s*(DONE|CONTINUE)\s*<\/status>/gi),
  ];
  if (matches.length !== 1) {
    return null;
  }
  const match = matches[0];
  if (!match || match.index === undefined) {
    return null;
  }
  const trailing = answer.slice(match.index + match[0].length).trim();
  if (trailing) {
    return null;
  }
  return match[1]?.toUpperCase() === 'DONE' ? 'done' : 'continue';
}

export function isTransientAgentFailure(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error);
  return [
    'timeout',
    'timed out',
    'econnreset',
    'econnrefused',
    'network',
    'overloaded',
    'rate limit',
    'temporarily unavailable',
    'service unavailable',
    '502',
    '503',
    '504',
  ].some((pattern) => message.includes(pattern));
}

export function estimateCalls(selection: WorkflowSelection): CallEstimate {
  if (selection.kind === 'collaborative') {
    return {
      minimum: 7,
      maximum: 5 + selection.maxRounds * 2,
      description:
        'Four planning calls, two calls per implementation cycle, and one synthesis call.',
    };
  }

  if (selection.kind === 'fixed') {
    return {
      minimum: 3,
      maximum: 1 + selection.maxRounds * 2,
      description: 'Two calls per implementation cycle and one synthesis call.',
    };
  }

  return {
    minimum: 5,
    maximum: 1 + selection.maxRounds * 2,
    description:
      'Two independent opening calls, critique rounds, and one synthesis call.',
  };
}

export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function summarizePorcelainStatus(status: string): ChangeSummary {
  const files: string[] = [];
  let stagedFiles = 0;
  let modifiedFiles = 0;
  let untrackedFiles = 0;

  for (const line of status.split('\n').filter(Boolean)) {
    const indexStatus = line[0] ?? ' ';
    const workingStatus = line[1] ?? ' ';
    const path = line.slice(3).trim();
    if (path) {
      files.push(path);
    }
    if (line.startsWith('??')) {
      untrackedFiles += 1;
    } else {
      if (indexStatus !== ' ') {
        stagedFiles += 1;
      }
      if (workingStatus !== ' ') {
        modifiedFiles += 1;
      }
    }
  }

  return {
    files,
    stagedFiles,
    modifiedFiles,
    untrackedFiles,
  };
}

export function makeRunId(
  date = new Date(),
  uniqueSuffix = randomUUID().slice(0, 8),
): string {
  const timestamp = date
    .toISOString()
    .replaceAll(':', '-')
    .replaceAll('.', '-');
  return `${timestamp}-${uniqueSuffix}`;
}

export function isSafeRunId(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId);
}
