import { randomUUID } from 'node:crypto';

export type AgentName = 'codex' | 'claude';
export type WorkflowKind = 'review' | 'fixed' | 'collaborative';
export type AgentDecision = 'done' | 'continue';
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
