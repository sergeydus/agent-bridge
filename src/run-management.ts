import type { BridgeOptions } from './options.ts';
import {
  deleteRun,
  discardRunWorkspace,
  formatRunList,
  pruneCompletedRuns,
} from './runs.ts';
import type { RunStateStore } from './state.ts';

export async function handleRunManagement(
  options: BridgeOptions,
  store: RunStateStore,
): Promise<boolean> {
  if (options.listRuns) {
    console.log(formatRunList(await store.list()));
    return true;
  }
  if (options.deleteRun) {
    const run = await store.load(options.deleteRun);
    const result = await deleteRun({ run, store });
    console.log(`Deleted saved artifacts for ${run.id}.`);
    if (result.workspacePreserved) {
      console.log(`Preserved editable workspace: ${result.workspacePreserved}`);
    }
    return true;
  }
  if (options.discardWorkspace) {
    const run = await store.load(options.discardWorkspace);
    const removed = await discardRunWorkspace({ run, store });
    console.log(`Discarded isolated workspace: ${removed}`);
    return true;
  }
  if (options.pruneRunsDays !== undefined) {
    const result = await pruneCompletedRuns({
      store,
      olderThanDays: options.pruneRunsDays,
    });
    console.log(`Deleted ${result.deleted} completed run(s).`);
    if (result.skippedWorkspaces) {
      console.log(
        `Preserved ${result.skippedWorkspaces} run(s) with editable workspaces.`,
      );
    }
    return true;
  }
  return false;
}
