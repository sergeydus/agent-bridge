import {
  createInterface,
  type Interface as ReadlineInterface,
} from 'node:readline/promises';

import {
  applyPatch,
  canApplyPatch,
  createPatch,
  currentCommit,
  removeIsolatedWorktree,
} from './git.ts';
import type { ProgressReporter } from './ui.ts';

async function askForChoice(
  interface_: ReadlineInterface,
  prompt: string,
  choices: string[],
  defaultChoice: string,
): Promise<string> {
  while (true) {
    const answer = (await interface_.question(prompt)).trim().toLowerCase();
    const choice = answer || defaultChoice;
    if (choices.includes(choice)) {
      return choice;
    }
    console.log(`Please enter ${choices.join(', ')}.`);
  }
}

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
}: {
  repository: string;
  workspace: string;
  patchPath: string;
  baseRevision?: string;
  reporter: ProgressReporter;
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
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return { patchPath, workspace };
  }

  const interface_ = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    console.log(`
What should happen to the completed changes?
  1) Keep the isolated workspace for inspection (safest)
  2) Apply the patch to the original checkout and keep the workspace
  3) Discard the isolated workspace
`);
    const choice = await askForChoice(
      interface_,
      'Choose 1, 2, or 3 [1]: ',
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
        interface_,
        'Discard this isolated workspace permanently? [y/N]: ',
        ['y', 'yes', 'n', 'no'],
        'n',
      );
      if (['y', 'yes'].includes(confirmed)) {
        await removeIsolatedWorktree({ repository, workspace });
        reporter.success('Discarded the isolated workspace.');
        return { patchPath };
      }
    }
    return { patchPath, workspace };
  } finally {
    interface_.close();
  }
}
