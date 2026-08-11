import { createInterface } from 'node:readline/promises';

import {
  applyPatch,
  canApplyPatch,
  createPatch,
  currentCommit,
  removeIsolatedWorktree,
} from './git.ts';
import {
  boundedCompletionReason,
  errorMessage,
  type CompletionOutcome,
} from './core.ts';
import type { ProgressReporter } from './ui.ts';

/**
 * The completion step's only input source. `ask` reports a declined question as
 * `undefined` rather than as a rejection, so no completion question can end a
 * run that has already finished successfully.
 */
export interface CompletionPrompt {
  ask(question: string): Promise<string | undefined>;
  close(): void;
}

type TerminalInput = NodeJS.ReadableStream & { isTTY?: boolean };
type TerminalOutput = NodeJS.WritableStream & { isTTY?: boolean };

function isEndOfInput(error: unknown): boolean {
  return (
    error instanceof Error &&
    ((error as NodeJS.ErrnoException).code === 'ABORT_ERR' ||
      error.name === 'AbortError')
  );
}

export function createReadlineCompletionPrompt({
  input,
  output,
}: {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}): CompletionPrompt {
  const interface_ = createInterface({ input, output });
  return {
    /**
     * Ctrl+D rejects readline's question with `ABORT_ERR`, and a closed stream
     * never settles it at all. Both are the same answer — none — so both
     * resolve `undefined` instead of escaping as a failure.
     */
    ask: (question) =>
      new Promise<string | undefined>((resolve, reject) => {
        const onClose = () => {
          resolve(undefined);
        };
        interface_.once('close', onClose);
        interface_.question(question).then(
          (answer) => {
            interface_.off('close', onClose);
            resolve(answer);
          },
          (error: unknown) => {
            interface_.off('close', onClose);
            if (isEndOfInput(error)) {
              resolve(undefined);
              return;
            }
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      }),
    close: () => interface_.close(),
  };
}

/** Interactive completion is offered only when both streams are terminals. */
export function createTerminalCompletionPrompt({
  input = process.stdin,
  output = process.stdout,
}: { input?: TerminalInput; output?: TerminalOutput } = {}):
  CompletionPrompt | undefined {
  if (!input.isTTY || !output.isTTY) {
    return undefined;
  }
  return createReadlineCompletionPrompt({ input, output });
}

/**
 * Asks until the answer is one of `choices`. A retry repeats only
 * `retryQuestion`, so a long menu is not reprinted after every mistake.
 */
async function askForChoice(
  prompt: CompletionPrompt,
  {
    question,
    retryQuestion = question,
    choices,
    defaultChoice,
  }: {
    question: string;
    retryQuestion?: string;
    choices: string[];
    defaultChoice: string;
  },
): Promise<string | undefined> {
  let asked = question;
  while (true) {
    const answer = await prompt.ask(asked);
    if (answer === undefined) {
      return undefined;
    }
    const choice = answer.trim().toLowerCase() || defaultChoice;
    if (choices.includes(choice)) {
      return choice;
    }
    asked = `Please enter ${choices.join(', ')}.\n${retryQuestion}`;
  }
}

const COMPLETION_CHOICE = 'Choose 1, 2, or 3 [1]: ';

const COMPLETION_MENU = `
What should happen to the completed changes?
  1) Keep the isolated workspace for inspection (safest)
  2) Apply the patch to the original checkout and keep the workspace
  3) Discard the isolated workspace

${COMPLETION_CHOICE}`;

export async function patchApplicationRefusalReason({
  repository,
  patchPath,
  baseRevision,
}: {
  repository: string;
  patchPath: string;
  baseRevision?: string;
}): Promise<string | undefined> {
  if (!baseRevision) {
    return 'This saved run predates base-revision tracking. The patch was not applied automatically.';
  }
  if ((await currentCommit(repository)) !== baseRevision) {
    return 'The original checkout moved to a different commit. The patch was not applied.';
  }
  if (!(await canApplyPatch({ repository, patchPath }))) {
    return 'The patch conflicts with the original checkout. It was not applied.';
  }
  return undefined;
}

export interface CompletionResult {
  outcome: CompletionOutcome;
  reason?: string;
  patchPath?: string;
  workspace?: string;
  applied?: boolean;
}

/**
 * Resolves the end of an editing run to exactly one outcome. Every failure here
 * is reported as an outcome rather than thrown, because the agents' work is
 * already finished and complete by the time this runs.
 */
export async function finishIsolatedRun({
  repository,
  workspace,
  patchPath,
  baseRevision,
  reporter,
  createPrompt = createTerminalCompletionPrompt,
  apply = applyPatch,
  removeWorkspace = removeIsolatedWorktree,
}: {
  repository: string;
  workspace: string;
  patchPath: string;
  baseRevision?: string;
  reporter: ProgressReporter;
  createPrompt?: () => CompletionPrompt | undefined;
  apply?: typeof applyPatch;
  removeWorkspace?: typeof removeIsolatedWorktree;
}): Promise<CompletionResult> {
  let patchCreated: boolean;
  try {
    patchCreated = await createPatch({ workspace, destination: patchPath });
  } catch (error) {
    const reason = boundedCompletionReason(
      `The patch could not be created: ${errorMessage(error)}`,
    );
    reporter.warning(reason);
    return { outcome: 'patch-failed', reason, workspace };
  }
  if (!patchCreated) {
    reporter.warning('The agents produced no file changes.');
    return { outcome: 'no-changes', workspace };
  }
  reporter.success(`Saved a portable patch to ${patchPath}`);
  const prompt = createPrompt();
  if (!prompt) {
    return { outcome: 'kept', patchPath, workspace };
  }

  try {
    const choice = await askForChoice(prompt, {
      question: COMPLETION_MENU,
      retryQuestion: COMPLETION_CHOICE,
      choices: ['1', '2', '3'],
      defaultChoice: '1',
    });
    if (choice === undefined) {
      return { outcome: 'declined', patchPath, workspace };
    }
    if (choice === '2') {
      const refusalReason = await patchApplicationRefusalReason({
        repository,
        patchPath,
        baseRevision,
      });
      if (refusalReason) {
        reporter.warning(refusalReason);
        return {
          outcome: 'apply-refused',
          reason: refusalReason,
          patchPath,
          workspace,
        };
      }
      try {
        await apply({ repository, patchPath });
      } catch (error) {
        const reason = boundedCompletionReason(
          `The patch could not be applied: ${errorMessage(error)}`,
        );
        reporter.warning(reason);
        return { outcome: 'apply-failed', reason, patchPath, workspace };
      }
      reporter.success('Applied the patch to the original checkout.');
      return { outcome: 'applied', patchPath, workspace, applied: true };
    }
    if (choice === '3') {
      const confirmed = await askForChoice(prompt, {
        question: 'Discard this isolated workspace permanently? [y/N]: ',
        choices: ['y', 'yes', 'n', 'no'],
        defaultChoice: 'n',
      });
      if (confirmed === undefined) {
        return { outcome: 'declined', patchPath, workspace };
      }
      if (['y', 'yes'].includes(confirmed)) {
        try {
          await removeWorkspace({ repository, workspace });
        } catch (error) {
          const reason = boundedCompletionReason(
            `The isolated workspace could not be removed: ${errorMessage(error)}`,
          );
          reporter.warning(reason);
          return { outcome: 'discard-failed', reason, patchPath, workspace };
        }
        reporter.success('Discarded the isolated workspace.');
        return { outcome: 'discarded', patchPath };
      }
    }
    return { outcome: 'kept', patchPath, workspace };
  } finally {
    prompt.close();
  }
}

/**
 * The one-way completion boundary. The run is marked complete *before* the
 * completion step runs, and failing to record the outcome leaves that durable
 * `completed` checkpoint standing rather than replacing it with a failure.
 * Nothing here may reopen a run whose work is already finished.
 */
export async function recordRunCompletion({
  markCompleted,
  finish,
  recordOutcome,
  reporter,
}: {
  markCompleted: () => Promise<void>;
  finish?: () => Promise<CompletionResult>;
  recordOutcome: (result: CompletionResult) => Promise<void>;
  reporter: ProgressReporter;
}): Promise<CompletionResult | undefined> {
  await markCompleted();
  if (!finish) {
    return undefined;
  }
  const result = await finish();
  try {
    await recordOutcome(result);
  } catch (error) {
    reporter.warning(
      `The run finished, but its completion outcome could not be recorded: ${errorMessage(error)}`,
    );
  }
  return result;
}
