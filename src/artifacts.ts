import { createInterface } from 'node:readline/promises';

import {
  applyPatch,
  canApplyPatch,
  createPatch,
  currentCommit,
  describeCommitsSinceBase,
  isCommitAnchored,
  removeIsolatedWorktree,
} from './git.ts';
import {
  boundedCompletionReason,
  errorMessage,
  summarizePorcelainStatus,
  type CompletionInstruction,
  type CompletionOutcome,
} from './core.ts';
import { workingTreeStatus } from './snapshot.ts';
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
  /**
   * True when an explicit `--on-complete` instruction was refused. An unattended
   * script asked for an action that did not happen, so the run must not read as
   * a success; an interactive refusal is a decision the user saw instead.
   */
  refusedInstruction?: boolean;
}

export type WorkspaceRemovalPlan =
  | {
      removable: false;
      outcome: 'patch-failed' | 'discard-failed';
      reason: string;
    }
  | {
      removable: true;
      patchPath?: string;
      unanchoredHistory?: { commits?: number; diverged: boolean };
    };

function describeUnanchoredHistory(history: {
  commits?: number;
  diverged: boolean;
}): string {
  return history.diverged
    ? 'has diverged from the revision it started at'
    : `is ${history.commits} commit${history.commits === 1 ? '' : 's'} ahead of the revision it started at`;
}

/**
 * Decides whether a workspace can be removed without losing work, and is the
 * single gate for both the completion step and run management. Removal is
 * permanent, so every question is answered from the workspace's current
 * contents rather than from an artifact written earlier.
 */
export async function planWorkspaceRemoval({
  workspace,
  patchPath,
  baseRevision,
  interactive,
}: {
  workspace: string;
  patchPath: string;
  baseRevision?: string;
  interactive: boolean;
}): Promise<WorkspaceRemovalPlan> {
  if (!baseRevision) {
    return {
      removable: false,
      outcome: 'discard-failed',
      reason: boundedCompletionReason(
        'This run recorded no base revision, so the workspace cannot be ' +
          `proven safe to remove. It was kept: ${workspace}`,
      ),
    };
  }

  // A retained workspace may have been edited since its patch was written, so
  // the patch is rewritten from the current contents before anything is lost.
  let patchCreated: boolean;
  try {
    patchCreated = await createPatch({
      workspace,
      destination: patchPath,
      baseRevision,
    });
  } catch (error) {
    return {
      removable: false,
      outcome: 'patch-failed',
      reason: boundedCompletionReason(
        `The workspace was kept because a complete patch could not be created: ${errorMessage(error)}`,
      ),
    };
  }

  let history: Awaited<ReturnType<typeof describeCommitsSinceBase>>;
  let anchored: boolean;
  try {
    history = await describeCommitsSinceBase({ workspace, baseRevision });
    // Only commits made inside the workspace are at stake; on the normal path
    // HEAD still equals the base and none of this engages.
    anchored =
      history.head === baseRevision ||
      (await isCommitAnchored({ workspace, revision: history.head }));
  } catch (error) {
    // Unable to tell whether removal would drop the last reference to any
    // commit, so removal is refused. The patch above may already have been
    // refreshed, and saying where it is makes the refusal actionable.
    return {
      removable: false,
      outcome: 'discard-failed',
      reason: boundedCompletionReason(
        'The workspace was kept because its history could not be inspected ' +
          `against the recorded base revision: ${errorMessage(error)}` +
          (patchCreated ? ` A complete patch is at ${patchPath}.` : '') +
          ` Workspace: ${workspace}`,
      ),
    };
  }
  if (!anchored && !interactive) {
    return {
      removable: false,
      outcome: 'discard-failed',
      reason: boundedCompletionReason(
        `The workspace ${describeUnanchoredHistory(history)}, and no branch or ` +
          'tag contains those commits. A patch preserves the resulting files ' +
          'but not commit messages, authorship, signatures, or topology. Run ' +
          `\`git branch <name> ${history.head}\` from inside the workspace to ` +
          `keep that history, then remove it again. Workspace: ${workspace}`,
      ),
    };
  }

  return {
    removable: true,
    patchPath: patchCreated ? patchPath : undefined,
    ...(anchored ? {} : { unanchoredHistory: history }),
  };
}

/**
 * Unattended application refuses a checkout that holds the user's own
 * uncommitted work: applied on top of it, agent changes and user changes become
 * indistinguishable, and Agent Bridge never commits or stages, so there is no
 * undo. Counts are reported rather than paths, because compact output does not
 * expose project paths by default.
 */
async function dirtyCheckoutRefusalReason(
  repository: string,
): Promise<string | undefined> {
  const summary = summarizePorcelainStatus(
    await workingTreeStatus({ cwd: repository }),
  );
  const dirty = summary.modifiedFiles + summary.stagedFiles;
  if (dirty === 0 && summary.untrackedFiles === 0) {
    return undefined;
  }
  return boundedCompletionReason(
    'The original checkout has uncommitted work ' +
      `(${dirty} changed, ${summary.untrackedFiles} untracked), and applying ` +
      "unattended would mix it with the agents' changes. The patch was not " +
      'applied. Commit or stash that work, or apply interactively.',
  );
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
  derivedBaseRevision,
  instruction = 'ask',
  reporter,
  createPrompt = createTerminalCompletionPrompt,
  apply = applyPatch,
  removeWorkspace = removeIsolatedWorktree,
}: {
  repository: string;
  workspace: string;
  patchPath: string;
  baseRevision?: string;
  derivedBaseRevision?: string;
  instruction?: CompletionInstruction;
  reporter: ProgressReporter;
  createPrompt?: () => CompletionPrompt | undefined;
  apply?: typeof applyPatch;
  removeWorkspace?: typeof removeIsolatedWorktree;
}): Promise<CompletionResult> {
  // Capturing a patch is non-destructive, so a derived baseline may serve a
  // resumed run that recorded none. Applying and removing may not: those read
  // `baseRevision` and refuse when it is absent.
  const patchBaseRevision = baseRevision ?? derivedBaseRevision;
  if (!patchBaseRevision) {
    const reason = boundedCompletionReason(
      'No base revision is available, so no patch could be captured. ' +
        `The workspace was kept: ${workspace}`,
    );
    reporter.warning(reason);
    return { outcome: 'patch-failed', reason, workspace };
  }
  let patchCreated: boolean;
  try {
    patchCreated = await createPatch({
      workspace,
      destination: patchPath,
      baseRevision: patchBaseRevision,
    });
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

  const applyToCheckout = async (
    interactive: boolean,
  ): Promise<CompletionResult> => {
    let refusalReason: string | undefined;
    try {
      refusalReason =
        (await patchApplicationRefusalReason({
          repository,
          patchPath,
          baseRevision,
        })) ??
        // A disclosure printed to a process nobody is watching authorizes
        // nothing, and the instruction may execute hours after it was typed.
        (interactive
          ? undefined
          : await dirtyCheckoutRefusalReason(repository));
    } catch (error) {
      // The safety checks could not be evaluated, so nothing was applied.
      // This is reported as a failure rather than a refusal: a refusal is a
      // known answer, and here the state of the checkout is unknown.
      const reason = boundedCompletionReason(
        `The patch was not applied because the original checkout could not be checked: ${errorMessage(error)}`,
      );
      reporter.warning(reason);
      return { outcome: 'apply-failed', reason, patchPath, workspace };
    }
    if (refusalReason) {
      reporter.warning(refusalReason);
      return {
        outcome: 'apply-refused',
        reason: refusalReason,
        patchPath,
        workspace,
        // Only set when an unattended instruction was refused; an interactive
        // refusal is a decision the user saw, not a failed instruction.
        ...(interactive ? {} : { refusedInstruction: true }),
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
  };

  const removeAfterConfirmation = async (
    confirm?: (
      plan: WorkspaceRemovalPlan & { removable: true },
    ) => Promise<'yes' | 'no' | 'unanswered'>,
  ): Promise<CompletionResult> => {
    const plan = await planWorkspaceRemoval({
      workspace,
      patchPath,
      baseRevision,
      interactive: confirm !== undefined,
    });
    if (!plan.removable) {
      reporter.warning(plan.reason);
      return {
        outcome: plan.outcome,
        reason: plan.reason,
        patchPath,
        workspace,
      };
    }
    const answer = confirm ? await confirm(plan) : 'yes';
    if (answer === 'unanswered') {
      return { outcome: 'declined', patchPath: plan.patchPath, workspace };
    }
    if (answer === 'no') {
      return { outcome: 'kept', patchPath: plan.patchPath, workspace };
    }
    try {
      await removeWorkspace({ repository, workspace });
    } catch (error) {
      const reason = boundedCompletionReason(
        `The isolated workspace could not be removed: ${errorMessage(error)}`,
      );
      reporter.warning(reason);
      return {
        outcome: 'discard-failed',
        reason,
        patchPath: plan.patchPath,
        workspace,
      };
    }
    reporter.success('Discarded the isolated workspace.');
    return { outcome: 'discarded', patchPath: plan.patchPath };
  };

  if (instruction === 'keep') {
    return { outcome: 'kept', patchPath, workspace };
  }
  if (instruction === 'apply') {
    return applyToCheckout(false);
  }
  if (instruction === 'discard') {
    // The flag is itself the explicit instruction, so there is nothing left to
    // confirm; the preservation gate still runs.
    return removeAfterConfirmation();
  }

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
      return await applyToCheckout(true);
    }
    if (choice === '3') {
      return await removeAfterConfirmation(async (plan) => {
        const confirmed = await askForChoice(prompt, {
          question: plan.unanchoredHistory
            ? `This workspace ${describeUnanchoredHistory(plan.unanchoredHistory)}, ` +
              'and no branch or tag contains those commits. The patch preserves ' +
              'the resulting files, but not commit messages, authorship, ' +
              'signatures, or topology.\n' +
              'Discard this isolated workspace permanently? [y/N]: '
            : 'Discard this isolated workspace permanently? [y/N]: ',
          retryQuestion: 'Discard this isolated workspace permanently? [y/N]: ',
          choices: ['y', 'yes', 'n', 'no'],
          defaultChoice: 'n',
        });
        if (confirmed === undefined) {
          return 'unanswered';
        }
        return ['y', 'yes'].includes(confirmed) ? 'yes' : 'no';
      });
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
