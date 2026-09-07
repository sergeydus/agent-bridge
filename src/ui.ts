import {
  agentLabel,
  formatDuration,
  type AgentName,
  type ChangeSummary,
  type RunOutcome,
} from './core.ts';
import { sanitizeTerminalText } from './terminal-text.ts';

export class ProgressReporter {
  #startedAt = Date.now();
  #verbose: boolean;
  #silent: boolean;
  #screenReader: boolean;

  constructor({
    verbose = false,
    silent = false,
    screenReader = false,
  }: {
    verbose?: boolean;
    silent?: boolean;
    screenReader?: boolean;
  } = {}) {
    this.#verbose = verbose;
    this.#silent = silent;
    this.#screenReader = screenReader;
  }

  get verbose(): boolean {
    return this.#verbose;
  }

  write(text: string): void {
    if (!this.#silent && text) {
      process.stdout.write(text);
    }
  }

  heading(title: string): void {
    if (!this.#silent) {
      const safeTitle = sanitizeTerminalText(title);
      process.stdout.write(
        this.#screenReader
          ? `\n${safeTitle}\n`
          : `\n${safeTitle}\n${'─'.repeat(safeTitle.length)}\n`,
      );
    }
  }

  phase(message: string): void {
    if (!this.#silent) {
      const safeMessage = sanitizeTerminalText(message);
      process.stdout.write(
        this.#screenReader ? `Phase: ${safeMessage}\n` : `● ${safeMessage}\n`,
      );
    }
  }

  success(message: string): void {
    if (!this.#silent) {
      const safeMessage = sanitizeTerminalText(message);
      process.stdout.write(
        this.#screenReader ? `Success: ${safeMessage}\n` : `✓ ${safeMessage}\n`,
      );
    }
  }

  info(message: string): void {
    if (!this.#silent) {
      process.stdout.write(`  ${sanitizeTerminalText(message)}\n`);
    }
  }

  warning(message: string): void {
    if (!this.#silent) {
      const safeMessage = sanitizeTerminalText(message);
      process.stdout.write(
        this.#screenReader ? `Warning: ${safeMessage}\n` : `! ${safeMessage}\n`,
      );
    }
  }

  agentAction(agent: AgentName, action: string): void {
    this.phase(`${agentLabel(agent)} ${action}`);
  }

  elapsed(): string {
    return formatDuration(Date.now() - this.#startedAt);
  }
}

export function printChangeSummary(
  summary: ChangeSummary,
  screenReader = false,
): void {
  console.log(`
Changes
${screenReader ? '' : '───────\n'}Files: ${summary.files.length}
Modified: ${summary.modifiedFiles}
Staged: ${summary.stagedFiles}
New: ${summary.untrackedFiles}`);

  for (const file of summary.files.slice(0, 12)) {
    const safeFile = sanitizeTerminalText(file);
    console.log(screenReader ? `  File: ${safeFile}` : `  • ${safeFile}`);
  }
  if (summary.files.length > 12) {
    console.log(
      screenReader
        ? `  Additional files: ${summary.files.length - 12}`
        : `  • …and ${summary.files.length - 12} more`,
    );
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
  screenReader = false,
}: {
  outcome: RunOutcome;
  cycles: number;
  elapsed: string;
  workspace?: string;
  transcript?: string;
  patch?: string;
  recoveryPatch?: string;
  screenReader?: boolean;
}): void {
  const visualOutcomeLabel = {
    agreed: '✓ Both agents approved the result',
    'completed-fixed-rounds': '✓ Requested review rounds completed',
    'agreement-cap-reached': '! Review cap reached without full agreement',
    failed: '✗ Agent Bridge failed',
    cancelled: '! Agent Bridge was cancelled',
  }[outcome];
  const plainOutcomeLabel = {
    agreed: 'Both agents approved the result',
    'completed-fixed-rounds': 'Requested review rounds completed',
    'agreement-cap-reached': 'Review cap reached without full agreement',
    failed: 'Agent Bridge failed',
    cancelled: 'Agent Bridge was cancelled',
  }[outcome];
  const outcomeLabel = screenReader ? plainOutcomeLabel : visualOutcomeLabel;
  console.log(
    sanitizeTerminalText(`
${outcomeLabel}
${screenReader ? '' : `${'═'.repeat(42)}\n`}Review cycles: ${cycles}
Elapsed: ${elapsed}${workspace ? `\nWorkspace: ${workspace}` : ''}${
      transcript ? `\nTranscript: ${transcript}` : ''
    }${patch ? `\nPatch: ${patch}` : ''}
${recoveryPatch ? `Recovery patch: ${recoveryPatch}` : ''}
`),
  );
}
