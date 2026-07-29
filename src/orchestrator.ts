import {
  editorForRound,
  type AgentName,
  type RunStatus,
  type WorkflowKind,
} from './core.ts';
import {
  implementationPrompt,
  participantPrompt,
  reviewPrompt,
  synthesisPrompt,
} from './prompts.ts';
import type { AgentResponse, ResponseKind } from './response.ts';
import type { PendingReview, SavedRound } from './state.ts';
import type { ProgressReporter } from './ui.ts';

export interface OrchestrationCheckpoint {
  status: RunStatus;
  rounds: SavedRound[];
  codexPrevious: string;
  claudePrevious: string;
  handoff: string;
  converged: boolean;
  currentRevision?: string;
  pendingReview?: PendingReview;
}

export interface OrchestrationResult extends Omit<
  OrchestrationCheckpoint,
  'status'
> {
  synthesis: string;
}

export interface OrchestratorOptions {
  task: string;
  workflowKind: WorkflowKind;
  firstAgent?: AgentName;
  roundLimit: number;
  untilAgreement: boolean;
  judge: AgentName;
  dryRun: boolean;
  initial?: Partial<OrchestrationCheckpoint>;
  reporter: ProgressReporter;
  runAgent: (
    agent: AgentName,
    prompt: string,
    options: { writeAccess: boolean; responseKind: ResponseKind },
  ) => Promise<AgentResponse>;
  captureWorkspace: () => Promise<{
    snapshot: string;
    revision?: string;
    changedFiles?: number;
  }>;
  runVerification: () => Promise<string>;
  checkpoint: (checkpoint: OrchestrationCheckpoint) => Promise<void>;
}

function conciseAnswer(answer: string): string {
  const line = answer
    .split('\n')
    .map((value) => value.replace(/^#+\s*/, '').trim())
    .find((value) => value && !/^\d+\.$/.test(value));
  if (!line) {
    return 'Response received';
  }
  return line.length > 180 ? `${line.slice(0, 177)}…` : line;
}

function responseForAgent(response: AgentResponse, revision?: string): string {
  return `${response.text}${
    response.decision
      ? `\n\nDecision: ${response.decision.toUpperCase()}${
          revision ? `\nRevision: ${revision}` : ''
        }`
      : ''
  }`;
}

function accountForVerificationChanges(
  response: AgentResponse,
  beforeRevision: string | undefined,
  afterRevision: string | undefined,
): AgentResponse {
  if (!beforeRevision || !afterRevision || beforeRevision === afterRevision) {
    return response;
  }
  return {
    text: `${response.text}

Agent Bridge note: approved verification commands changed the workspace after
this implementation report. The resulting revision requires another
implementation decision before the workflow can converge.`,
    decision: 'continue',
  };
}

export async function runOrchestration({
  task,
  workflowKind,
  firstAgent,
  roundLimit,
  untilAgreement,
  judge,
  dryRun,
  initial,
  reporter,
  runAgent,
  captureWorkspace,
  runVerification,
  checkpoint,
}: OrchestratorOptions): Promise<OrchestrationResult> {
  const rounds = initial?.rounds ? [...initial.rounds] : [];
  let codexPrevious = initial?.codexPrevious ?? '';
  let claudePrevious = initial?.claudePrevious ?? '';
  let handoff = initial?.handoff ?? '';
  let converged = initial?.converged ?? false;
  let currentRevision = initial?.currentRevision;
  let pendingReview = initial?.pendingReview;

  const save = (status: RunStatus): Promise<void> =>
    checkpoint({
      status,
      rounds,
      codexPrevious,
      claudePrevious,
      handoff,
      converged,
      currentRevision,
      pendingReview,
    });

  const completedPlanningRounds = rounds.filter(
    (round) => round.phase === 'Planning',
  ).length;
  if (workflowKind === 'collaborative' && completedPlanningRounds < 2) {
    reporter.heading('Planning');
    const planningTask = `Discuss and reconcile a concrete implementation plan.
Do not edit files in this phase. Identify scope, risks, verification, and the
simplest safe approach.

${task}`;

    for (
      let planningRound = completedPlanningRounds + 1;
      planningRound <= 2;
      planningRound += 1
    ) {
      reporter.phase(`Planning round ${planningRound}/2`);
      const [codexResponse, claudeResponse] = await Promise.all([
        runAgent(
          'codex',
          participantPrompt({
            agent: 'codex',
            task: planningTask,
            round: planningRound,
            ownPrevious: codexPrevious,
            peerPrevious: claudePrevious,
            untilAgreement: false,
          }),
          { writeAccess: false, responseKind: 'turn' },
        ),
        runAgent(
          'claude',
          participantPrompt({
            agent: 'claude',
            task: planningTask,
            round: planningRound,
            ownPrevious: claudePrevious,
            peerPrevious: codexPrevious,
            untilAgreement: false,
          }),
          { writeAccess: false, responseKind: 'turn' },
        ),
      ]);
      const codex = responseForAgent(codexResponse);
      const claude = responseForAgent(claudeResponse);
      rounds.push({
        phase: 'Planning',
        round: planningRound,
        codex,
        claude,
        codexDecision: codexResponse.decision,
        claudeDecision: claudeResponse.decision,
      });
      codexPrevious = codex;
      claudePrevious = claude;
      await save('planning');
      reporter.success(`Codex: ${conciseAnswer(codex)}`);
      reporter.success(`Claude: ${conciseAnswer(claude)}`);
      if (reporter.verbose) {
        console.log('\nCodex plan:\n', codex);
        console.log('\nClaude plan:\n', claude);
      }
    }

    handoff = `Final planning responses:

Codex:
${codexPrevious}

Claude:
${claudePrevious}`;
    await save('planning');
  }

  const editingWorkflow = workflowKind !== 'review';
  reporter.heading(editingWorkflow ? 'Implementation and review' : 'Review');
  const firstPendingRound =
    rounds.filter((round) => round.phase !== 'Planning').length + 1;

  for (let round = firstPendingRound; round <= roundLimit; round += 1) {
    reporter.phase(
      `${editingWorkflow ? 'Implementation' : 'Discussion'} cycle ${round}/${roundLimit}`,
    );
    let codexResponse: AgentResponse;
    let claudeResponse: AgentResponse;

    if (editingWorkflow) {
      if (!firstAgent) {
        throw new Error('Editing workflow is missing its first agent.');
      }
      const implementer =
        workflowKind === 'collaborative'
          ? editorForRound(firstAgent, round)
          : firstAgent;
      const reviewer: AgentName = implementer === 'codex' ? 'claude' : 'codex';

      let implementerResponse: AgentResponse;
      let verification: string;
      let captured: Awaited<ReturnType<typeof captureWorkspace>>;
      if (pendingReview?.round === round) {
        if (pendingReview.implementer !== implementer) {
          throw new Error(
            `Saved review for cycle ${round} has an inconsistent implementer.`,
          );
        }
        reporter.info(
          `Recovering pending read-only review for cycle ${round}.`,
        );
        captured = await captureWorkspace();
        if (
          pendingReview.revision &&
          captured.revision !== pendingReview.revision
        ) {
          throw new Error(
            `The saved workspace changed before review cycle ${round}.`,
          );
        }
        implementerResponse = {
          text: pendingReview.implementerResponse,
          decision: pendingReview.implementerDecision,
        };
        currentRevision = pendingReview.revision ?? captured.revision;
        if (pendingReview.verificationComplete) {
          verification = pendingReview.verification;
        } else {
          const beforeVerificationRevision = currentRevision;
          verification = dryRun
            ? '[dry-run: verification was not executed]'
            : await runVerification();
          captured = dryRun ? captured : await captureWorkspace();
          currentRevision = captured.revision;
          implementerResponse = accountForVerificationChanges(
            implementerResponse,
            beforeVerificationRevision,
            currentRevision,
          );
          pendingReview = {
            ...pendingReview,
            implementerResponse: implementerResponse.text,
            implementerDecision: implementerResponse.decision,
            revision: currentRevision,
            verification,
            verificationComplete: true,
          };
          await save('reviewing');
        }
      } else {
        await save('implementing');
        reporter.agentAction(implementer, 'is editing');
        implementerResponse = await runAgent(
          implementer,
          implementationPrompt({
            agent: implementer,
            task,
            round,
            handoff,
          }),
          { writeAccess: true, responseKind: 'turn' },
        );

        pendingReview = {
          round,
          implementer,
          implementerResponse: implementerResponse.text,
          implementerDecision: implementerResponse.decision,
          verification: '',
          verificationComplete: false,
        };
        await save('reviewing');

        captured = dryRun
          ? {
              snapshot: '[dry-run: no files were changed]',
              revision: `dry-run-${round}`,
            }
          : await captureWorkspace();
        currentRevision = captured.revision;
        const beforeVerificationRevision = currentRevision;
        pendingReview = {
          ...pendingReview,
          revision: currentRevision,
        };
        await save('reviewing');

        verification = dryRun
          ? '[dry-run: verification was not executed]'
          : await runVerification();
        captured = dryRun ? captured : await captureWorkspace();
        currentRevision = captured.revision;
        implementerResponse = accountForVerificationChanges(
          implementerResponse,
          beforeVerificationRevision,
          currentRevision,
        );
        pendingReview = {
          ...pendingReview,
          implementerResponse: implementerResponse.text,
          implementerDecision: implementerResponse.decision,
          revision: currentRevision,
          verification,
          verificationComplete: true,
        };
        await save('reviewing');
      }
      if (captured.changedFiles !== undefined) {
        reporter.success(
          `${captured.changedFiles} changed file${
            captured.changedFiles === 1 ? '' : 's'
          } after the edit`,
        );
      }

      reporter.agentAction(reviewer, 'is reviewing');
      const reviewerResponse = await runAgent(
        reviewer,
        reviewPrompt({
          agent: reviewer,
          task,
          round,
          implementerAnswer: implementerResponse.text,
          snapshot: `${captured.snapshot}

WORKSPACE REVISION
${currentRevision ?? '[not available]'}

BRIDGE-MANAGED VERIFICATION
${verification}`,
        }),
        { writeAccess: false, responseKind: 'turn' },
      );

      codexResponse =
        implementer === 'codex' ? implementerResponse : reviewerResponse;
      claudeResponse =
        implementer === 'claude' ? implementerResponse : reviewerResponse;
      handoff = reviewerResponse.text;
    } else {
      [codexResponse, claudeResponse] = await Promise.all([
        runAgent(
          'codex',
          participantPrompt({
            agent: 'codex',
            task,
            round,
            ownPrevious: codexPrevious,
            peerPrevious: claudePrevious,
            untilAgreement,
          }),
          { writeAccess: false, responseKind: 'turn' },
        ),
        runAgent(
          'claude',
          participantPrompt({
            agent: 'claude',
            task,
            round,
            ownPrevious: claudePrevious,
            peerPrevious: codexPrevious,
            untilAgreement,
          }),
          { writeAccess: false, responseKind: 'turn' },
        ),
      ]);
    }

    const codex = responseForAgent(codexResponse, currentRevision);
    const claude = responseForAgent(claudeResponse, currentRevision);
    rounds.push({
      phase: editingWorkflow ? 'Implementation' : 'Discussion',
      round,
      codex,
      claude,
      codexDecision: codexResponse.decision,
      claudeDecision: claudeResponse.decision,
      revision: currentRevision,
    });
    pendingReview = undefined;
    codexPrevious = codex;
    claudePrevious = claude;
    await save('reviewing');

    reporter.success(`Codex: ${conciseAnswer(codex)}`);
    reporter.success(`Claude: ${conciseAnswer(claude)}`);
    if (reporter.verbose) {
      console.log('\nCodex:\n', codex);
      console.log('\nClaude:\n', claude);
    }

    if (
      untilAgreement &&
      (editingWorkflow || round > 1) &&
      codexResponse.decision === 'done' &&
      claudeResponse.decision === 'done'
    ) {
      converged = true;
      reporter.success(`Both agents approved cycle ${round}.`);
      break;
    }

    if (
      dryRun &&
      (workflowKind !== 'collaborative' || round >= Math.min(2, roundLimit))
    ) {
      break;
    }
  }

  if (untilAgreement && !converged && !dryRun) {
    reporter.warning(
      `Agreement was not reached within the ${roundLimit}-cycle safety cap.`,
    );
  }

  let transcript = rounds
    .map(
      (round) => `${round.phase || 'Discussion'} Round ${round.round}

Codex:
${round.codex}

Claude:
${round.claude}`,
    )
    .join('\n\n');
  if (editingWorkflow && !dryRun) {
    const reviewedRevision = currentRevision;
    const finalWorkspace = await captureWorkspace();
    currentRevision = finalWorkspace.revision ?? currentRevision;
    if (
      converged &&
      reviewedRevision &&
      currentRevision &&
      reviewedRevision !== currentRevision
    ) {
      converged = false;
      reporter.warning(
        'The workspace changed after the approving review; agreement was revoked.',
      );
    }
    transcript += `\n\nFinal authoritative working-tree snapshot:
${finalWorkspace.snapshot}

Final workspace revision: ${currentRevision ?? '[not available]'}
Revision approved by the last reviewer: ${reviewedRevision ?? '[not available]'}`;
  }

  reporter.heading('Final synthesis');
  reporter.agentAction(judge, 'is preparing the final result');
  await save('synthesizing');
  const synthesisResponse = await runAgent(
    judge,
    synthesisPrompt({
      judge,
      task,
      transcript,
      convergence: untilAgreement
        ? converged
          ? `Both agents reported done for revision ${currentRevision ?? 'the same reviewed state'}.`
          : `Not reached within ${roundLimit} rounds.`
        : 'Agreement mode was not requested.',
    }),
    { writeAccess: false, responseKind: 'synthesis' },
  );
  reporter.success(conciseAnswer(synthesisResponse.text));

  return {
    rounds,
    codexPrevious,
    claudePrevious,
    handoff,
    converged,
    currentRevision,
    pendingReview,
    synthesis: synthesisResponse.text,
  };
}
