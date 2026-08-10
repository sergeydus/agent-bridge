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
 * The completion step's only input source. `ask` resolves `undefined` when the
 * user declines to answer, so no completion question can reject and end a run
 * that has already finished successfully.
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

async function askForChoice(
  prompt: CompletionPrompt,
  question: string,
  choices: string[],
  defaultChoice: string,
): Promise<string | undefined> {
  let correction = '';
  while (true) {
    const answer = await prompt.ask(`${correction}${question}`);
    if (answer === undefined) {
      return undefined;
    }
    const choice = answer.trim().toLowerCase() || defaultChoice;
    if (choices.includes(choice)) {
      return choice;
    }
    correction = `Please enter ${choices.join(', ')}.\n`;
  }
}

const COMPLETION_MENU = `
What should happen to the completed changes?
  1) Keep the isolated workspace for inspection (safest)
  2) Apply the patch to the original checkout and keep the workspace
  3) Discard the isolated workspace

Choose 1, 2, or 3 [1]: `;

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
    const choice = await askForChoice(
      prompt,
      COMPLETION_MENU,
      ['1', '2', '3'],
      '1',
    );
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
      const confirmed = await askForChoice(
        prompt,
        'Discard this isolated workspace permanently? [y/N]: ',
        ['y', 'yes', 'n', 'no'],
        'n',
      );
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
