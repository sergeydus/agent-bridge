import type { BridgeOptions } from './options.ts';
import {
  deleteRun,
  discardRunWorkspace,
  formatRunList,
  pruneCompletedRuns,
} from './runs.ts';
import type { RunStateStore } from './state.ts';
import { sanitizeTerminalText } from './terminal-text.ts';

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
    const lock = await store.acquireLock(run.id);
    let result: Awaited<ReturnType<typeof deleteRun>>;
    try {
      result = await deleteRun({ run, store });
    } finally {
      await lock.release();
    }
    console.log(`Deleted saved artifacts for ${run.id}.`);
    if (result.workspacePreserved) {
      console.log(
        `Preserved editable workspace: ${sanitizeTerminalText(
          result.workspacePreserved,
        )}`,
      );
    }
    return true;
  }
  if (options.discardWorkspace) {
    const run = await store.load(options.discardWorkspace);
    const lock = await store.acquireLock(run.id);
    let removed: string;
    try {
      removed = await discardRunWorkspace({ run, store });
    } finally {
      await lock.release();
    }
    console.log(
      `Discarded isolated workspace: ${sanitizeTerminalText(removed)}`,
    );
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
