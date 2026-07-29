import {
  formatDuration,
  type AgentName,
  type ChangeSummary,
  type RunOutcome,
} from './core.ts';

const agentLabel = (agent: AgentName): string =>
  agent === 'codex' ? 'Codex' : 'Claude';

export class ProgressReporter {
  readonly #startedAt = Date.now();
  readonly #verbose: boolean;
  readonly #silent: boolean;

  constructor({
    verbose = false,
    silent = false,
  }: { verbose?: boolean; silent?: boolean } = {}) {
    this.#verbose = verbose;
    this.#silent = silent;
  }

  get verbose(): boolean {
    return this.#verbose;
  }

  heading(title: string): void {
    if (!this.#silent) {
      process.stdout.write(`\n${title}\n${'─'.repeat(title.length)}\n`);
    }
  }

  phase(message: string): void {
    if (!this.#silent) {
      process.stdout.write(`● ${message}\n`);
    }
  }

  success(message: string): void {
    if (!this.#silent) {
      process.stdout.write(`✓ ${message}\n`);
    }
  }

  info(message: string): void {
    if (!this.#silent) {
      process.stdout.write(`  ${message}\n`);
    }
  }

  warning(message: string): void {
    if (!this.#silent) {
      process.stdout.write(`! ${message}\n`);
    }
  }

  agentAction(agent: AgentName, action: string): void {
    this.phase(`${agentLabel(agent)} ${action}`);
  }

  elapsed(): string {
    return formatDuration(Date.now() - this.#startedAt);
  }
}

export function printChangeSummary(summary: ChangeSummary): void {
  console.log(`
Changes
───────
Files: ${summary.files.length}
Modified: ${summary.modifiedFiles}
Staged: ${summary.stagedFiles}
New: ${summary.untrackedFiles}`);

  for (const file of summary.files.slice(0, 12)) {
    console.log(`  • ${file}`);
  }
  if (summary.files.length > 12) {
    console.log(`  • …and ${summary.files.length - 12} more`);
  }
}

export function printCompletion({
  outcome,
  cycles,
  elapsed,
  workspace,
  transcript,
  patch,
  recoveryPatch,
}: {
  outcome: RunOutcome;
  cycles: number;
  elapsed: string;
  workspace?: string;
  transcript?: string;
  patch?: string;
  recoveryPatch?: string;
}): void {
  const outcomeLabel = {
    agreed: '✓ Both agents approved the result',
    'completed-fixed-rounds': '✓ Requested review rounds completed',
    'agreement-cap-reached': '! Review cap reached without full agreement',
    failed: '✗ Agent Bridge failed',
    cancelled: '! Agent Bridge was cancelled',
  }[outcome];
  console.log(`
${outcomeLabel}
${'═'.repeat(42)}
Review cycles: ${cycles}
Elapsed: ${elapsed}${workspace ? `\nWorkspace: ${workspace}` : ''}${
    transcript ? `\nTranscript: ${transcript}` : ''
  }${patch ? `\nPatch: ${patch}` : ''}
${recoveryPatch ? `Recovery patch: ${recoveryPatch}` : ''}
`);
}
