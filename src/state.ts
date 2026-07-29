import { readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  isSafeRunId,
  legacyDecision,
  type AgentDecision,
  type AgentName,
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

const MAX_RUN_STATE_BYTES = 50_000_000;

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

export interface SavedRun {
  version: 2;
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
}

export { FileLock as RunLock };

interface SavedRunV1 {
  version: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  task: string;
  originalCwd: string;
  agentCwd: string;
  workspace?: string;
  workflow: SavedRun['workflow'];
  completedImplementationRounds: number;
  codexPrevious: string;
  claudePrevious: string;
  handoff: string;
  converged: boolean;
  rounds: Array<Omit<SavedRound, 'codexDecision' | 'claudeDecision'>>;
  error?: string;
}

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

export function isSavedRun(value: unknown): value is SavedRun {
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
    ])
  ) {
    return false;
  }
  const run = value as Partial<SavedRun>;
  return (
    run.version === 2 &&
    hasValidBaseFields(run) &&
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

function isSavedRunV1(value: unknown): value is SavedRunV1 {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const run = value as Partial<SavedRunV1>;
  return (
    run.version === 1 &&
    hasValidBaseFields(run as unknown as Partial<SavedRun>) &&
    Number.isInteger(run.completedImplementationRounds)
  );
}

function migrateV1(run: SavedRunV1, outputDirectory: string): SavedRun {
  return {
    version: 2,
    id: run.id,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    status: run.status,
    task: run.task,
    originalCwd: run.originalCwd,
    agentCwd: run.agentCwd,
    projectKind: 'git',
    outputDirectory,
    workspace: run.workspace,
    workflow: run.workflow,
    judge: 'codex',
    retries: 1,
    timeoutMinutes: 30,
    untilAgreement: true,
    requireAgreement: false,
    noTranscript: false,
    verification: [],
    protectedPaths: [],
    protectedPathFingerprints: {},
    completedCycles: run.completedImplementationRounds,
    codexPrevious: run.codexPrevious,
    claudePrevious: run.claudePrevious,
    handoff: run.handoff,
    converged: run.converged,
    rounds: run.rounds.map((round) => ({
      ...round,
      codexDecision: legacyDecision(round.codex) ?? undefined,
      claudeDecision: legacyDecision(round.claude) ?? undefined,
    })),
    error: run.error,
  };
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
    if (isSavedRunV1(parsed)) {
      return migrateV1(parsed, dirname(this.#directory));
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
              `Ignoring invalid saved run ${name}: ${
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
