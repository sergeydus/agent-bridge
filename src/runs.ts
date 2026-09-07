import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { planWorkspaceRemoval } from './artifacts.ts';
import { isFinishedRunStatus } from './core.ts';
import { removeIsolatedWorktree } from './git.ts';
import type { SavedRun } from './state.ts';
import { RunStateStore } from './state.ts';
import { sanitizeTerminalText } from './terminal-text.ts';

const ARTIFACT_EXTENSIONS = [
  '.md',
  '.json',
  '.patch',
  '.context.json',
  '.preexisting.patch',
] as const;

export function formatRunList(runs: SavedRun[]): string {
  if (runs.length === 0) {
    return 'No saved Agent Bridge runs.';
  }
  const rows = runs.map((run) => {
    const workflow = run.workflow.kind.padEnd(13);
    const status = run.status.padEnd(12);
    return `${run.id}  ${status}  ${workflow}  ${sanitizeTerminalText(
      run.originalCwd,
    )}`;
  });
  return [
    'RUN ID                              STATUS        WORKFLOW       PROJECT',
    ...rows,
  ].join('\n');
}

async function removeRunFiles(run: SavedRun): Promise<void> {
  await Promise.all(
    ARTIFACT_EXTENSIONS.map((extension) =>
      rm(join(run.outputDirectory, `${run.id}${extension}`), { force: true }),
    ),
  );
}

export async function deleteRun({
  run,
  store,
}: {
  run: SavedRun;
  store: RunStateStore;
}): Promise<{ workspacePreserved?: string }> {
  await removeRunFiles(run);
  await store.delete(run.id);
  return { workspacePreserved: run.workspace };
}

export async function discardRunWorkspace({
  run,
  store,
  removeWorkspace = removeIsolatedWorktree,
  plan = planWorkspaceRemoval,
}: {
  run: SavedRun;
  store: RunStateStore;
  removeWorkspace?: typeof removeIsolatedWorktree;
  plan?: typeof planWorkspaceRemoval;
}): Promise<string> {
  if (!run.workspace) {
    throw new Error(`Run ${run.id} has no retained workspace.`);
  }
  if (!isFinishedRunStatus(run.status)) {
    throw new Error(
      `Run ${run.id} is ${run.status}. Only completed or cancelled workspaces can be discarded.`,
    );
  }
  const workspace = run.workspace;
  // The workspace may have been edited since the run wrote its patch, so the
  // same preservation gate the completion step uses runs again here. This path
  // is never interactive, so unanchored history is refused rather than
  // confirmed.
  const removal = await plan({
    workspace,
    patchPath: join(run.outputDirectory, `${run.id}.patch`),
    baseRevision: run.baseRevision,
    interactive: false,
  });
  if (!removal.removable) {
    throw new Error(sanitizeTerminalText(removal.reason));
  }
  await removeWorkspace({
    repository: run.originalCwd,
    workspace,
  });
  await store.save({
    ...run,
    workspace: undefined,
    agentCwd: run.originalCwd,
  });
  return workspace;
}

export async function pruneCompletedRuns({
  store,
  olderThanDays,
  now = Date.now(),
}: {
  store: RunStateStore;
  olderThanDays: number;
  now?: number;
}): Promise<{ deleted: number; skippedWorkspaces: number }> {
  const cutoff = now - olderThanDays * 24 * 60 * 60 * 1_000;
  let deleted = 0;
  let skippedWorkspaces = 0;
  for (const run of await store.list()) {
    if (
      !isFinishedRunStatus(run.status) ||
      Date.parse(run.updatedAt) > cutoff
    ) {
      continue;
    }
    if (run.workspace) {
      skippedWorkspaces += 1;
      continue;
    }
    await removeRunFiles(run);
    await store.delete(run.id);
    deleted += 1;
  }
  return { deleted, skippedWorkspaces };
}
