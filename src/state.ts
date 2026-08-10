import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import {
  completionOutcomeRequiresReason,
  isCompletionOutcome,
  isSafeRunId,
  type AgentDecision,
  type AgentName,
  type CompletionOutcome,
  type ProjectKind,
  type ReasoningEffort,
  type RunStatus,
  type WorkflowKind,
} from './core.ts';
import { acquireFileLock, FileLock } from './file-lock.ts';
import { readFilePrefixBytes, writePrivateFileAtomic } from './filesystem.ts';
import {
  isSafeProtectedPath,
  isVerificationCommand,
  type VerificationCommand,
} from './project-config.ts';
import { sanitizeTerminalText } from './terminal-text.ts';

const MAX_RUN_STATE_BYTES = 50_000_000;
export const MAX_COMPLETION_REASON_CHARS = 2_000;

export interface SavedRound {
  phase: string;
  round: number;
  codex: string;
  claude: string;
  codexDecision?: AgentDecision;
  claudeDecision?: AgentDecision;
  revision?: string;
}

export interface PendingReview {
  round: number;
  implementer: AgentName;
  implementerResponse: string;
  implementerDecision?: AgentDecision;
  revision?: string;
  verification: string;
  verificationComplete: boolean;
}

/**
 * How this run's own completion step resolved. Run management never writes it:
 * a workspace removed later through `--discard-workspace` leaves whatever the
 * run itself recorded.
 */
export interface SavedRunCompletion {
  outcome: CompletionOutcome;
  recordedAt: string;
  reason?: string;
}

export interface SavedRun {
  version: 3;
  id: string;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  task: string;
  originalCwd: string;
  agentCwd: string;
  projectKind: ProjectKind;
  outputDirectory: string;
  recoveryPatchPath?: string;
  workspace?: string;
  baseRevision?: string;
  currentRevision?: string;
  workflow: {
    kind: WorkflowKind;
    firstAgent?: AgentName;
    maxRounds: number;
  };
  judge: AgentName;
  codexModel?: string;
  claudeModel?: string;
  codexEffort?: ReasoningEffort;
  claudeEffort?: ReasoningEffort;
  retries: number;
  timeoutMinutes: number;
  untilAgreement: boolean;
  requireAgreement: boolean;
  noTranscript: boolean;
  verification: VerificationCommand[];
  protectedPaths: string[];
  protectedPathFingerprints: Record<string, string>;
  completedCycles: number;
  codexPrevious: string;
  claudePrevious: string;
  handoff: string;
  converged: boolean;
  pendingReview?: PendingReview;
  rounds: SavedRound[];
  error?: string;
  completion?: SavedRunCompletion;
}

export { FileLock as RunLock };

/**
 * Version 3 is the compatibility baseline. No run-state migration ships, so an
 * older checkpoint is reported and left alone rather than upgraded in place.
 */
export const RUN_STATE_VERSION = 3;

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

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

function isAgentDecision(value: unknown): value is AgentDecision {
  return value === 'done' || value === 'continue';
}

function isSavedRound(value: unknown): value is SavedRound {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !hasOnlyKeys(value, [
      'phase',
      'round',
      'codex',
      'claude',
      'codexDecision',
      'claudeDecision',
      'revision',
    ])
  ) {
    return false;
  }
  const round = value as Partial<SavedRound>;
  return (
    isString(round.phase) &&
    Number.isInteger(round.round) &&
    (round.round ?? 0) >= 1 &&
    isString(round.codex) &&
    isString(round.claude) &&
    (round.codexDecision === undefined ||
      isAgentDecision(round.codexDecision)) &&
    (round.claudeDecision === undefined ||
      isAgentDecision(round.claudeDecision)) &&
    (round.revision === undefined || isString(round.revision))
  );
}

function isPendingReview(value: unknown): value is PendingReview {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !hasOnlyKeys(value, [
      'round',
      'implementer',
      'implementerResponse',
      'implementerDecision',
      'revision',
      'verification',
      'verificationComplete',
    ])
  ) {
    return false;
  }
  const pending = value as Partial<PendingReview>;
  return (
    Number.isInteger(pending.round) &&
    (pending.round ?? 0) >= 1 &&
    (pending.implementer === 'codex' || pending.implementer === 'claude') &&
    isString(pending.implementerResponse) &&
    (pending.implementerDecision === undefined ||
      isAgentDecision(pending.implementerDecision)) &&
    (pending.revision === undefined || isString(pending.revision)) &&
    isString(pending.verification) &&
    typeof pending.verificationComplete === 'boolean'
  );
}

function isSavedRunCompletion(value: unknown): value is SavedRunCompletion {
  if (!isRecord(value)) {
    return false;
  }
  if (!hasOnlyKeys(value, ['outcome', 'recordedAt', 'reason'])) {
    return false;
  }
  const completion = value as Partial<SavedRunCompletion>;
  if (
    !isCompletionOutcome(completion.outcome) ||
    !isIsoDateTime(completion.recordedAt)
  ) {
    return false;
  }
  if (!completionOutcomeRequiresReason(completion.outcome)) {
    // A succeeded action must not carry failure data.
    return completion.reason === undefined;
  }
  return (
    isString(completion.reason) &&
    completion.reason.trim() !== '' &&
    completion.reason.length <= MAX_COMPLETION_REASON_CHARS &&
    // Persisted reasons are rendered later, so they are stored already
    // sanitized rather than sanitized at every display site.
    sanitizeTerminalText(completion.reason) === completion.reason
  );
}

/**
 * Rules that no single field can express. The JSON Schema documents the shape;
 * these keep a checkpoint from describing a state that cannot have happened.
 */
function hasConsistentCompletion(run: Partial<SavedRun>): boolean {
  const completion = run.completion;
  if (completion === undefined) {
    return true;
  }
  if (!isSavedRunCompletion(completion)) {
    return false;
  }
  if (run.status !== 'completed') {
    return false;
  }
  if (
    completion.outcome === 'discarded' &&
    !(run.workspace === undefined && run.agentCwd === run.originalCwd)
  ) {
    return false;
  }
  // Nothing was captured to a patch, so the workspace is the only copy.
  return !(
    ['no-changes', 'patch-failed'].includes(completion.outcome) &&
    run.workspace === undefined
  );
}

function hasValidWorkflow(
  workflow: Partial<SavedRun['workflow']> | undefined,
): boolean {
  return (
    Boolean(workflow) &&
    hasOnlyKeys(workflow as Record<string, unknown>, [
      'kind',
      'firstAgent',
      'maxRounds',
    ]) &&
    ['review', 'fixed', 'collaborative'].includes(workflow?.kind ?? '') &&
    (workflow?.firstAgent === undefined ||
      workflow.firstAgent === 'codex' ||
      workflow.firstAgent === 'claude') &&
    Number.isInteger(workflow?.maxRounds) &&
    (workflow?.maxRounds ?? 0) >= 1 &&
    (workflow?.maxRounds ?? 0) <= 20
  );
}

function hasValidBaseFields(run: Partial<SavedRun>): boolean {
  return (
    isString(run.id) &&
    isSafeRunId(run.id) &&
    isIsoDateTime(run.createdAt) &&
    isIsoDateTime(run.updatedAt) &&
    isString(run.status) &&
    [
      'created',
      'planning',
      'implementing',
      'reviewing',
      'synthesizing',
      'completed',
      'failed',
      'cancelled',
    ].includes(run.status) &&
    isString(run.task) &&
    isString(run.originalCwd) &&
    isString(run.agentCwd) &&
    (run.workspace === undefined || isString(run.workspace)) &&
    hasValidWorkflow(run.workflow) &&
    isString(run.codexPrevious) &&
    isString(run.claudePrevious) &&
    isString(run.handoff) &&
    typeof run.converged === 'boolean' &&
    (run.pendingReview === undefined || isPendingReview(run.pendingReview)) &&
    Array.isArray(run.rounds) &&
    run.rounds.every(isSavedRound) &&
    (run.error === undefined || isString(run.error))
  );
}

const RUN_KEYS = [
  'version',
  'id',
  'createdAt',
  'updatedAt',
  'status',
  'task',
  'originalCwd',
  'agentCwd',
  'projectKind',
  'outputDirectory',
  'recoveryPatchPath',
  'workspace',
  'baseRevision',
  'currentRevision',
  'workflow',
  'judge',
  'codexModel',
  'claudeModel',
  'codexEffort',
  'claudeEffort',
  'retries',
  'timeoutMinutes',
  'untilAgreement',
  'requireAgreement',
  'noTranscript',
  'verification',
  'protectedPaths',
  'protectedPathFingerprints',
  'completedCycles',
  'codexPrevious',
  'claudePrevious',
  'handoff',
  'converged',
  'pendingReview',
  'rounds',
  'error',
  'completion',
] as const;

export function isSavedRun(value: unknown): value is SavedRun {
  if (!isRecord(value) || !hasOnlyKeys(value, RUN_KEYS)) {
    return false;
  }
  const run = value as Partial<SavedRun>;
  return (
    run.version === RUN_STATE_VERSION &&
    hasValidBaseFields(run) &&
    hasConsistentCompletion(run) &&
    (run.projectKind === 'git' || run.projectKind === 'directory') &&
    isString(run.outputDirectory) &&
    (run.recoveryPatchPath === undefined || isString(run.recoveryPatchPath)) &&
    (run.baseRevision === undefined || isString(run.baseRevision)) &&
    (run.currentRevision === undefined || isString(run.currentRevision)) &&
    (run.judge === 'codex' || run.judge === 'claude') &&
    (run.codexModel === undefined || isString(run.codexModel)) &&
    (run.claudeModel === undefined || isString(run.claudeModel)) &&
    (run.codexEffort === undefined ||
      ['low', 'medium', 'high', 'xhigh', 'max'].includes(run.codexEffort)) &&
    (run.claudeEffort === undefined ||
      ['low', 'medium', 'high', 'xhigh', 'max'].includes(run.claudeEffort)) &&
    Number.isInteger(run.retries) &&
    (run.retries ?? -1) >= 0 &&
    (run.retries ?? 4) <= 3 &&
    Number.isInteger(run.timeoutMinutes) &&
    (run.timeoutMinutes ?? 0) >= 1 &&
    (run.timeoutMinutes ?? 181) <= 180 &&
    typeof run.untilAgreement === 'boolean' &&
    typeof run.requireAgreement === 'boolean' &&
    typeof run.noTranscript === 'boolean' &&
    Array.isArray(run.verification) &&
    run.verification.every(isVerificationCommand) &&
    Array.isArray(run.protectedPaths) &&
    new Set(run.protectedPaths).size === run.protectedPaths.length &&
    run.protectedPaths.every(isSafeProtectedPath) &&
    isRecord(run.protectedPathFingerprints) &&
    Object.entries(run.protectedPathFingerprints ?? {}).every(
      ([key, value]) => isSafeProtectedPath(key) && isString(value),
    ) &&
    Number.isInteger(run.completedCycles) &&
    (run.completedCycles ?? -1) >= 0
  );
}

/**
 * Recognizes a checkpoint written by an older build so it can be reported
 * precisely instead of being called invalid. Nothing about it is trusted beyond
 * the version number itself.
 */
function supersededRunStateVersion(value: unknown): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const version = value.version;
  return typeof version === 'number' &&
    Number.isInteger(version) &&
    version >= 1 &&
    version < RUN_STATE_VERSION
    ? version
    : undefined;
}

export class RunStateStore {
  #directory: string;
  #onWarning: (message: string) => void;

  constructor(
    directory: string,
    onWarning: (message: string) => void = () => {},
  ) {
    this.#directory = directory;
    this.#onWarning = onWarning;
  }

  pathFor(runId: string): string {
    if (!isSafeRunId(runId)) {
      throw new Error(`Unsafe run id: ${runId}`);
    }
    return join(this.#directory, `${runId}.json`);
  }

  lockPathFor(runId: string): string {
    if (!isSafeRunId(runId)) {
      throw new Error(`Unsafe run id: ${runId}`);
    }
    return join(this.#directory, `${runId}.lock`);
  }

  acquireLock(runId: string): Promise<FileLock> {
    return acquireFileLock({
      path: this.lockPathFor(runId),
      activeMessage: `Run ${runId} is already active in another Agent Bridge process.`,
    });
  }

  async save(run: SavedRun): Promise<string> {
    const destination = this.pathFor(run.id);
    const persisted = { ...run, updatedAt: new Date().toISOString() };
    if (!isSavedRun(persisted)) {
      throw new Error(`Refusing to save invalid run: ${run.id}`);
    }
    const serialized = `${JSON.stringify(persisted, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_RUN_STATE_BYTES) {
      throw new Error(`Run checkpoint is larger than 50 MB: ${run.id}`);
    }
    await writePrivateFileAtomic(destination, serialized);
    return destination;
  }

  async load(runId: string): Promise<SavedRun> {
    let contents: Buffer;
    try {
      contents = await readFilePrefixBytes({
        path: this.pathFor(runId),
        maxBytes: MAX_RUN_STATE_BYTES + 1,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`Saved run not found: ${runId}`, { cause: error });
      }
      throw error;
    }
    if (contents.length > MAX_RUN_STATE_BYTES) {
      throw new Error(`Saved run is larger than 50 MB: ${runId}`);
    }
    const parsed: unknown = JSON.parse(contents.toString('utf8'));
    if (isSavedRun(parsed)) {
      return parsed;
    }
    const olderVersion = supersededRunStateVersion(parsed);
    if (olderVersion !== undefined) {
      throw new Error(
        `Saved run ${runId} uses checkpoint version ${olderVersion}, which this ` +
          `version of Agent Bridge no longer reads (version ${RUN_STATE_VERSION} ` +
          `is the supported baseline). Nothing was changed or deleted: the ` +
          `checkpoint is still at ${this.pathFor(runId)} and any isolated ` +
          `workspace it created is untouched. Inspect that workspace directly, ` +
          `or remove the checkpoint once you no longer need it.`,
      );
    }
    throw new Error(`Invalid saved run: ${runId}`);
  }

  async list(): Promise<SavedRun[]> {
    let names: string[];
    try {
      names = await readdir(this.#directory);
    } catch {
      return [];
    }
    const runs = await Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          try {
            return await this.load(name.slice(0, -5));
          } catch (error) {
            this.#onWarning(
              `Ignoring unreadable saved run ${name}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            return null;
          }
        }),
    );
    return runs
      .filter((run): run is SavedRun => run !== null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async delete(runId: string): Promise<void> {
    await unlink(this.pathFor(runId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
  }

  async latestIncomplete(): Promise<SavedRun | null> {
    const runs = await this.list();
    return (
      runs.find((run) => !['completed', 'cancelled'].includes(run.status)) ??
      null
    );
  }
}
