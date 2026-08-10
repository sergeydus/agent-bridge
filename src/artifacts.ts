import { createInterface } from 'node:readline/promises';

import {
  applyPatch,
  canApplyPatch,
  createPatch,
  currentCommit,
  removeIsolatedWorktree,
} from './git.ts';
import type { ProgressReporter } from './ui.ts';

/**
 * The completion step's only input source. `ask` reports a declined question as
 * `undefined` rather than as a rejection, so callers must handle "no answer"
 * explicitly. The terminal implementation does not yet normalize end of input;
 * until it does, a real Ctrl+D still rejects.
 */
export interface CompletionPrompt {
  ask(question: string): Promise<string | undefined>;
  close(): void;
}

type TerminalInput = NodeJS.ReadableStream & { isTTY?: boolean };
type TerminalOutput = NodeJS.WritableStream & { isTTY?: boolean };

export function createReadlineCompletionPrompt({
  input,
  output,
}: {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}): CompletionPrompt {
  const interface_ = createInterface({ input, output });
  return {
    ask: (question) => interface_.question(question),
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

export async function finishIsolatedRun({
  repository,
  workspace,
  patchPath,
  baseRevision,
  reporter,
  createPrompt = createTerminalCompletionPrompt,
}: {
  repository: string;
  workspace: string;
  patchPath: string;
  baseRevision?: string;
  reporter: ProgressReporter;
  createPrompt?: () => CompletionPrompt | undefined;
}): Promise<{ patchPath?: string; workspace?: string; applied?: boolean }> {
  const patchCreated = await createPatch({
    workspace,
    destination: patchPath,
  });
  if (!patchCreated) {
    reporter.warning('The agents produced no file changes.');
    return { workspace };
  }
  reporter.success(`Saved a portable patch to ${patchPath}`);
  const prompt = createPrompt();
  if (!prompt) {
    return { patchPath, workspace };
  }

  try {
    const choice = await askForChoice(prompt, {
      question: COMPLETION_MENU,
      retryQuestion: COMPLETION_CHOICE,
      choices: ['1', '2', '3'],
      defaultChoice: '1',
    });
    if (choice === '2') {
      const refusalReason = await patchApplicationRefusalReason({
        repository,
        patchPath,
        baseRevision,
      });
      if (refusalReason) {
        reporter.warning(refusalReason);
        return { patchPath, workspace };
      }
      await applyPatch({ repository, patchPath });
      reporter.success('Applied the patch to the original checkout.');
      return { patchPath, workspace, applied: true };
    }
    if (choice === '3') {
      const confirmed = await askForChoice(prompt, {
        question: 'Discard this isolated workspace permanently? [y/N]: ',
        choices: ['y', 'yes', 'n', 'no'],
        defaultChoice: 'n',
      });
      if (confirmed !== undefined && ['y', 'yes'].includes(confirmed)) {
        await removeIsolatedWorktree({ repository, workspace });
        reporter.success('Discarded the isolated workspace.');
        return { patchPath };
      }
    }
    return { patchPath, workspace };
  } finally {
    prompt.close();
  }
}
