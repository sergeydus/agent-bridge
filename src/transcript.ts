import type { AgentName, ProjectKind } from './core.ts';
import type { SavedRound } from './state.ts';

export interface TranscriptMetadata {
  startedAt: string;
  cwd: string;
  agentCwd: string;
  workspace: string | null;
  roundCount: number;
  judge: AgentName;
  untilAgreement: boolean;
  converged: boolean | null;
  implementer: AgentName | null;
  collaborative: AgentName | null;
  projectKind: ProjectKind;
  baseRevision: string | null;
  finalRevision: string | null;
}

export interface Transcript {
  metadata: TranscriptMetadata;
  task: string;
  rounds: SavedRound[];
  synthesis: string;
}

export function formatMarkdownTranscript({
  task,
  rounds,
  synthesis,
  metadata,
}: Transcript): string {
  const sections = [
    '# Agent Bridge Deliberation',
    '',
    `- Started: ${metadata.startedAt}`,
    `- Working directory: ${metadata.cwd}`,
    `- Project type: ${metadata.projectKind}`,
    `- Base revision: ${metadata.baseRevision ?? 'not applicable'}`,
    `- Final revision: ${metadata.finalRevision ?? 'not available'}`,
    `- Rounds: ${metadata.roundCount}`,
    `- Judge: ${metadata.judge}`,
    `- Agreement mode: ${metadata.untilAgreement ? 'yes' : 'no'}`,
    `- Implementer: ${metadata.implementer ?? 'none (advisory only)'}`,
    `- Collaborative alternating edits: ${
      metadata.collaborative
        ? `yes (${metadata.collaborative} edits first)`
        : 'no'
    }`,
    ...(metadata.untilAgreement
      ? [`- Converged: ${metadata.converged ? 'yes' : 'no'}`]
      : []),
    '',
    '## Task',
    '',
    task,
  ];

  rounds.forEach((round) => {
    sections.push(
      '',
      `## ${round.phase || 'Discussion'} Round ${round.round}`,
      '',
      '### Codex',
      '',
      round.codex,
      '',
      '### Claude',
      '',
      round.claude,
    );
  });

  sections.push('', '## Synthesis', '', synthesis, '');
  return sections.join('\n');
}
