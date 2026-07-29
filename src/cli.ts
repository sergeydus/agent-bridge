#!/usr/bin/env -S node --experimental-strip-types

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { finishIsolatedRun } from './artifacts.ts';
import { runInteractiveChat } from './chat.ts';
import {
  makeRunId,
  summarizePorcelainStatus,
  type AgentName,
  type RunOutcome,
  type RunStatus,
} from './core.ts';
import { runDoctor } from './doctor.ts';
import {
  createIsolatedWorktree,
  createPatch,
  currentCommit,
  repositoryRoot,
  workspaceFingerprint,
} from './git.ts';
import { loadInstructionContext } from './instructions.ts';
import { runOrchestration } from './orchestrator.ts';
import { HELP, parseArgs } from './options.ts';
import { getAppPaths } from './paths.ts';
import { createProviderEventPresenter } from './presentation.ts';
import { ProcessAbortError } from './process.ts';
import { loadProjectConfig } from './project-config.ts';
import { isPathInside, resolveProject } from './project.ts';
import { createDefaultProviders, runProviderWithRetry } from './providers.ts';
import { handleRunManagement } from './run-management.ts';
import {
  pathFingerprint,
  workingTreePaths,
  workingTreeSnapshot,
  workingTreeStatus,
} from './snapshot.ts';
import { RunStateStore, type RunLock, type SavedRun } from './state.ts';
import { appendGitDiff, resolveTask } from './task.ts';
import {
  formatMarkdownTranscript,
  type TranscriptMetadata,
} from './transcript.ts';
import { printChangeSummary, printCompletion, ProgressReporter } from './ui.ts';
import {
  formatVerificationResults,
  runVerificationCommands,
} from './verification.ts';
import { runWizard } from './wizard.ts';
import { sanitizeTerminalText } from './terminal-text.ts';

const APP_PATHS = getAppPaths();
const PROVIDERS = createDefaultProviders();
const INSTALL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const stateStore = new RunStateStore(APP_PATHS.stateDirectory, (message) =>
    console.warn(sanitizeTerminalText(message)),
  );

  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.doctor) {
    const report = await runDoctor({
      appPaths: APP_PATHS,
      providers: PROVIDERS,
    });
    report.lines.forEach((line) => console.log(sanitizeTerminalText(line)));
    if (!report.passed) {
      process.exitCode = 1;
    }
    return;
  }
  if (await handleRunManagement(options, stateStore)) {
    return;
  }
  if (
    (options.wizard && !options.chat) ||
    (!options.task &&
      !options.taskFile &&
      !options.resume &&
      !options.chat &&
      process.stdin.isTTY)
  ) {
    await runWizard({
      options,
      appPaths: APP_PATHS,
      installRoot: INSTALL_ROOT,
    });
  }
  if (options.chat) {
    await runInteractiveChat({
      options,
      appPaths: APP_PATHS,
      providers: PROVIDERS,
    });
    return;
  }

  let resumedRun: SavedRun | undefined;
  if (options.resume) {
    resumedRun =
      options.resume === 'latest'
        ? ((await stateStore.latestIncomplete()) ?? undefined)
        : await stateStore.load(options.resume);
    if (!resumedRun) {
      throw new Error('There is no incomplete run to continue.');
    }
    if (['completed', 'cancelled'].includes(resumedRun.status)) {
      throw new Error(`Run ${resumedRun.id} is already ${resumedRun.status}.`);
    }
    options.task = resumedRun.task;
    options.taskFile = undefined;
    options.cwd = resumedRun.originalCwd;
    options.output = resumedRun.outputDirectory;
    options.maxRounds = resumedRun.workflow.maxRounds;
    options.untilAgreement = resumedRun.untilAgreement;
    options.requireAgreement = resumedRun.requireAgreement;
    options.implementer =
      resumedRun.workflow.kind === 'fixed'
        ? resumedRun.workflow.firstAgent
        : undefined;
    options.collaborative =
      resumedRun.workflow.kind === 'collaborative'
        ? resumedRun.workflow.firstAgent
        : undefined;
    options.judge = resumedRun.judge;
    options.codexModel = resumedRun.codexModel;
    options.claudeModel = resumedRun.claudeModel;
    options.codexEffort = resumedRun.codexEffort;
    options.claudeEffort = resumedRun.claudeEffort;
    options.retries = resumedRun.retries;
    options.timeoutMinutes = resumedRun.timeoutMinutes;
    options.noTranscript = resumedRun.noTranscript;
    options.isolation = Boolean(resumedRun.workspace);
    console.log(`Continuing run ${resumedRun.id}…`);
  }

  const selectedProject = await resolveProject(options.cwd);
  const projectKind = resumedRun?.projectKind ?? selectedProject.kind;
  const originalCwd = resumedRun?.originalCwd ?? selectedProject.root;
  options.cwd = originalCwd;
  const editingWorkflow = Boolean(options.implementer || options.collaborative);
  if (editingWorkflow && projectKind !== 'git') {
    throw new Error(
      'Safe editing requires Git. Initialize this folder with `git init`, or use review-only mode.',
    );
  }
  if (editingWorkflow && (await isPathInside(originalCwd, options.output))) {
    throw new Error(
      '--output must be outside the target repository for editing workflows',
    );
  }

  let task = resumedRun?.task ?? (await resolveTask(options));
  if (!task) {
    throw new Error('Task cannot be empty');
  }
  if (!resumedRun) {
    task = await appendGitDiff(task, options, projectKind);
    const instructions = await loadInstructionContext(originalCwd);
    task += `\n\nShared project instruction context:\n${instructions.prompt}`;
  }

  const projectConfiguration = resumedRun
    ? { config: { version: 1 as const, verification: [], protectedPaths: [] } }
    : await loadProjectConfig({
        projectRoot: originalCwd,
        configPath: options.projectConfigPath,
      });
  const verificationCommands =
    resumedRun?.verification ??
    (options.trustProjectConfig
      ? projectConfiguration.config.verification
      : []);
  let configuredProtectedPaths =
    resumedRun?.protectedPaths ??
    (options.trustProjectConfig
      ? projectConfiguration.config.protectedPaths
      : []);
  let protectedPathFingerprints = resumedRun?.protectedPathFingerprints ?? {};
  if (
    !resumedRun &&
    projectConfiguration.config.verification.length > 0 &&
    !options.trustProjectConfig
  ) {
    console.warn(
      'Project verification commands were not run because the configuration was not trusted.',
    );
  }

  let repository: string | undefined;
  let workspace = resumedRun?.workspace;
  let baseRevision = resumedRun?.baseRevision;
  let recoveryPatchPath = resumedRun?.recoveryPatchPath;
  let needsDirectDirtyRecoveryPatch = false;
  if (projectKind === 'git') {
    repository = await repositoryRoot(originalCwd);
    baseRevision ??= options.dryRun
      ? 'dry-run-head'
      : await currentCommit(repository);
  }

  if (editingWorkflow && projectKind === 'git' && !resumedRun) {
    const status = await workingTreeStatus({ cwd: originalCwd });
    if (options.isolation && status && !options.fromHead) {
      throw new Error(
        'The selected repository has local changes. An isolated run would ignore ' +
          'them. Commit/stash them or rerun with --from-head.',
      );
    }
    if (!options.isolation && status && !options.allowDirty) {
      throw new Error(
        `Direct editing requires a clean working tree. Commit/stash changes or ` +
          `rerun with --allow-dirty:\n${status}`,
      );
    }
    if (!options.isolation && status) {
      needsDirectDirtyRecoveryPatch = true;
      const preExistingPaths = await workingTreePaths({ cwd: originalCwd });
      configuredProtectedPaths = [
        ...new Set([...configuredProtectedPaths, ...preExistingPaths]),
      ];
      task += `\n\nPre-existing user changes are protected. Do not modify them:\n${JSON.stringify(status)}`;
    }
  }

  const startedAt = resumedRun?.createdAt ?? new Date().toISOString();
  const runId = resumedRun?.id ?? makeRunId(new Date(startedAt));
  let runLock: RunLock | undefined;
  let ownsRunState = options.dryRun;
  const reporter = new ProgressReporter({
    verbose: options.verbose,
    screenReader: options.screenReader,
  });
  const abortController = new AbortController();
  const onSignal = (): void => abortController.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const tempDirectory = await mkdtemp(join(tmpdir(), 'agent-bridge-'));

  let runtime = {
    rounds: resumedRun?.rounds ?? [],
    codexPrevious: resumedRun?.codexPrevious ?? '',
    claudePrevious: resumedRun?.claudePrevious ?? '',
    handoff: resumedRun?.handoff ?? '',
    converged: resumedRun?.converged ?? false,
    currentRevision: resumedRun?.currentRevision,
    pendingReview: resumedRun?.pendingReview,
  };
  if (
    resumedRun &&
    editingWorkflow &&
    !resumedRun.pendingReview &&
    ['implementing', 'failed'].includes(resumedRun.status)
  ) {
    runtime.handoff += `

Recovery note: a previous write call may have stopped after making partial
edits. Inspect the current workspace first, preserve completed work, and
continue from its actual state instead of repeating changes blindly.`;
  }
  const workflowKind = options.collaborative
    ? 'collaborative'
    : options.implementer
      ? 'fixed'
      : 'review';
  const roundLimit = options.untilAgreement
    ? options.maxRounds
    : options.rounds;

  const saveState = async (
    status: RunStatus,
    error?: string,
  ): Promise<void> => {
    if (options.dryRun) {
      return;
    }
    await stateStore.save({
      version: 2,
      id: runId,
      createdAt: startedAt,
      updatedAt: new Date().toISOString(),
      status,
      task,
      originalCwd,
      agentCwd: options.cwd,
      projectKind,
      outputDirectory: options.output,
      recoveryPatchPath,
      workspace,
      baseRevision,
      currentRevision: runtime.currentRevision,
      workflow: {
        kind: workflowKind,
        firstAgent: options.collaborative ?? options.implementer,
        maxRounds: roundLimit,
      },
      judge: options.judge,
      codexModel: options.codexModel,
      claudeModel: options.claudeModel,
      codexEffort: options.codexEffort,
      claudeEffort: options.claudeEffort,
      retries: options.retries,
      timeoutMinutes: options.timeoutMinutes,
      untilAgreement: options.untilAgreement,
      requireAgreement: options.requireAgreement,
      noTranscript: options.noTranscript,
      verification: verificationCommands,
      protectedPaths: configuredProtectedPaths,
      protectedPathFingerprints,
      completedCycles: runtime.rounds.filter(
        (round) => round.phase !== 'Planning',
      ).length,
      codexPrevious: runtime.codexPrevious,
      claudePrevious: runtime.claudePrevious,
      handoff: runtime.handoff,
      converged: runtime.converged,
      pendingReview: runtime.pendingReview,
      rounds: runtime.rounds,
      error,
    });
  };

  try {
    if (!options.dryRun) {
      runLock = await stateStore.acquireLock(runId);
      ownsRunState = true;
    }
    if (needsDirectDirtyRecoveryPatch && !options.dryRun) {
      recoveryPatchPath = join(options.output, `${runId}.preexisting.patch`);
      const recoveryPatch = await createPatch({
        workspace: originalCwd,
        destination: recoveryPatchPath,
      });
      if (!recoveryPatch) {
        throw new Error(
          'Direct dirty editing was refused because a complete recovery patch could not be created.',
        );
      }
      reporter.success(
        `Saved pre-existing work recovery patch: ${recoveryPatchPath}`,
      );
    }
    if (workspace) {
      options.cwd = workspace;
      reporter.success(`Reusing isolated workspace: ${workspace}`);
    } else if (
      editingWorkflow &&
      options.isolation &&
      !options.dryRun &&
      repository
    ) {
      reporter.phase('Creating an isolated Git workspace');
      workspace = await createIsolatedWorktree({
        repository,
        runsDirectory: options.output,
        runId,
      });
      options.cwd = workspace;
      task +=
        '\n\nWork in this isolated Git worktree. Do not commit or stage changes.';
      reporter.success(`Isolated workspace ready: ${workspace}`);
    }
    if (!resumedRun) {
      protectedPathFingerprints = Object.fromEntries(
        await Promise.all(
          configuredProtectedPaths.map(async (path) => [
            path,
            await pathFingerprint({ cwd: options.cwd, path }),
          ]),
        ),
      );
    } else {
      for (const [path, expected] of Object.entries(
        protectedPathFingerprints,
      )) {
        const actual = await pathFingerprint({ cwd: options.cwd, path });
        if (actual !== expected) {
          throw new Error(
            `Protected path changed during the interrupted run: ${path}`,
          );
        }
      }
    }
    await saveState('created');

    const callAgent = async (
      agent: AgentName,
      prompt: string,
      {
        writeAccess,
        responseKind,
      }: {
        writeAccess: boolean;
        responseKind: 'turn' | 'synthesis';
      },
    ) => {
      const eventPresenter = createProviderEventPresenter({
        agent,
        preferences: {
          screenReader: options.screenReader,
          color: false,
        },
        streamText: false,
      });
      const heartbeat = setInterval(() => {
        reporter.info(
          `${agent === 'codex' ? 'Codex' : 'Claude'} is still working (${reporter.elapsed()})`,
        );
      }, 30_000);
      heartbeat.unref();
      try {
        try {
          const response = await runProviderWithRetry({
            provider: PROVIDERS[agent],
            prompt,
            options: {
              cwd: options.cwd,
              tempDirectory,
              writeAccess,
              verbose: options.verbose,
              dryRun: options.dryRun,
              timeoutMs: options.timeoutMinutes * 60_000,
              responseKind,
              isGitRepository: projectKind === 'git',
              model:
                agent === 'codex' ? options.codexModel : options.claudeModel,
              effort:
                agent === 'codex' ? options.codexEffort : options.claudeEffort,
              screenReader: options.screenReader,
              signal: abortController.signal,
              onEvent: (event) => reporter.write(eventPresenter.render(event)),
            },
            retries: options.retries,
            onRetry: (attempt) => {
              reporter.write(eventPresenter.reset());
              reporter.warning(
                `Temporary ${agent} failure; retrying (${attempt}/${options.retries})…`,
              );
            },
          });
          reporter.write(eventPresenter.finish());
          return response;
        } catch (error) {
          reporter.write(eventPresenter.reset());
          throw error;
        }
      } finally {
        clearInterval(heartbeat);
      }
    };

    const result = await runOrchestration({
      task,
      workflowKind,
      firstAgent: options.collaborative ?? options.implementer,
      roundLimit,
      untilAgreement: options.untilAgreement,
      judge: options.judge,
      dryRun: options.dryRun,
      initial: runtime,
      reporter,
      runAgent: callAgent,
      captureWorkspace: async () => {
        if (projectKind !== 'git') {
          return { snapshot: '[directory review: inspect project directly]' };
        }
        const [snapshot, status, revision] = await Promise.all([
          workingTreeSnapshot(options),
          workingTreeStatus(options),
          workspaceFingerprint(options.cwd),
        ]);
        for (const [path, expected] of Object.entries(
          protectedPathFingerprints,
        )) {
          const actual = await pathFingerprint({ cwd: options.cwd, path });
          if (actual !== expected) {
            throw new Error(`Agent modified protected path: ${path}`);
          }
        }
        return {
          snapshot,
          revision,
          changedFiles: summarizePorcelainStatus(status).files.length,
        };
      },
      runVerification: async () =>
        formatVerificationResults(
          await runVerificationCommands({
            commands: verificationCommands,
            cwd: options.cwd,
            defaultTimeoutMs: options.timeoutMinutes * 60_000,
            signal: abortController.signal,
          }),
        ),
      checkpoint: async (checkpoint) => {
        runtime = {
          rounds: [...checkpoint.rounds],
          codexPrevious: checkpoint.codexPrevious,
          claudePrevious: checkpoint.claudePrevious,
          handoff: checkpoint.handoff,
          converged: checkpoint.converged,
          currentRevision: checkpoint.currentRevision,
          pendingReview: checkpoint.pendingReview,
        };
        await saveState(checkpoint.status);
      },
    });
    runtime = {
      rounds: result.rounds,
      codexPrevious: result.codexPrevious,
      claudePrevious: result.claudePrevious,
      handoff: result.handoff,
      converged: result.converged,
      currentRevision: result.currentRevision,
      pendingReview: result.pendingReview,
    };

    if (options.dryRun) {
      console.log('\nDry run complete.');
      return;
    }

    const metadata: TranscriptMetadata = {
      startedAt,
      cwd: originalCwd,
      agentCwd: options.cwd,
      workspace: workspace ?? null,
      roundCount: result.rounds.length,
      judge: options.judge,
      untilAgreement: options.untilAgreement,
      converged: options.untilAgreement ? result.converged : null,
      implementer: options.implementer ?? null,
      collaborative: options.collaborative ?? null,
      projectKind,
      baseRevision: baseRevision ?? null,
      finalRevision: result.currentRevision ?? null,
    };
    let transcriptPath: string | undefined;
    if (!options.noTranscript) {
      await mkdir(options.output, { recursive: true, mode: 0o700 });
      transcriptPath = join(options.output, `${runId}.md`);
      const transcript = {
        metadata,
        task,
        rounds: result.rounds,
        synthesis: result.synthesis,
      };
      await Promise.all([
        writeFile(transcriptPath, formatMarkdownTranscript(transcript), {
          mode: 0o600,
        }),
        writeFile(
          join(options.output, `${runId}.json`),
          `${JSON.stringify(transcript, null, 2)}\n`,
          { mode: 0o600 },
        ),
        writeFile(
          join(options.output, `${runId}.context.json`),
          `${JSON.stringify(
            {
              runId,
              projectKind,
              originalCwd,
              agentCwd: options.cwd,
              baseRevision,
              finalRevision: result.currentRevision,
              instructionFiles: (
                await loadInstructionContext(originalCwd)
              ).files.map((file) => file.path),
              verificationCommands,
              providers: ['codex', 'claude'],
            },
            null,
            2,
          )}\n`,
          { mode: 0o600 },
        ),
      ]);
      reporter.success(`Saved the transcript to ${transcriptPath}`);
    }

    let patchPath: string | undefined;
    let isolatedSummary;
    if (workspace && repository) {
      isolatedSummary = summarizePorcelainStatus(
        await workingTreeStatus({ cwd: workspace }),
      );
      const finished = await finishIsolatedRun({
        repository,
        workspace,
        patchPath: join(options.output, `${runId}.patch`),
        baseRevision,
        reporter,
      });
      patchPath = finished.patchPath;
      workspace = finished.workspace;
    }
    if (editingWorkflow) {
      printChangeSummary(
        isolatedSummary ??
          summarizePorcelainStatus(await workingTreeStatus(options)),
        options.screenReader,
      );
    }

    const outcome: RunOutcome = options.untilAgreement
      ? result.converged
        ? 'agreed'
        : 'agreement-cap-reached'
      : 'completed-fixed-rounds';
    reporter.heading('Final result');
    console.log(`${sanitizeTerminalText(result.synthesis)}\n`);
    printCompletion({
      outcome,
      cycles: result.rounds.filter((round) => round.phase !== 'Planning')
        .length,
      elapsed: reporter.elapsed(),
      workspace,
      transcript: transcriptPath,
      patch: patchPath,
      recoveryPatch: options.noTranscript ? undefined : recoveryPatchPath,
      screenReader: options.screenReader,
    });
    await saveState('completed');
    if (options.noTranscript) {
      if (recoveryPatchPath) {
        await rm(recoveryPatchPath, { force: true });
      }
      await stateStore.delete(runId);
    }
    if (options.requireAgreement && !result.converged) {
      process.exitCode = 2;
    }
  } catch (error) {
    if (abortController.signal.aborted || error instanceof ProcessAbortError) {
      if (ownsRunState) {
        await saveState('cancelled', 'Cancelled by user');
      }
      reporter.warning(
        `Cancelled safely.${workspace ? ` Workspace preserved: ${workspace}` : ''}`,
      );
      process.exitCode = 130;
      return;
    }
    if (ownsRunState) {
      await saveState('failed', errorMessage(error));
    }
    throw error;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await runLock?.release();
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(`agent-bridge: ${sanitizeTerminalText(errorMessage(error))}`);
  process.exitCode = 1;
});
