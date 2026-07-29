import type { ChatWorkflowMode } from './chat-state.ts';
import { agentLabel } from './presentation.ts';
import { estimateCalls, type AgentName } from './core.ts';
import type { BridgeOptions } from './options.ts';
import { loadProjectConfig, type ProjectConfig } from './project-config.ts';
import { workingTreeStatus } from './snapshot.ts';
import { sanitizeTerminalText } from './terminal-text.ts';

export interface WorkflowPreflight {
  dirtyStatus: string;
  estimate: ReturnType<typeof estimateCalls>;
  projectConfig: {
    config: ProjectConfig;
    path?: string;
  };
}

export async function inspectWorkflowPreflight({
  mode,
  firstAgent,
  options,
}: {
  mode: ChatWorkflowMode;
  firstAgent?: AgentName;
  options: BridgeOptions;
}): Promise<WorkflowPreflight> {
  const [dirtyStatus, projectConfig] = await Promise.all([
    mode === 'review' ? Promise.resolve('') : workingTreeStatus(options),
    loadProjectConfig({
      projectRoot: options.cwd,
      configPath: options.projectConfigPath,
    }),
  ]);
  return {
    dirtyStatus,
    projectConfig,
    estimate: estimateCalls({
      kind: mode,
      firstAgent,
      maxRounds: options.maxRounds,
    }),
  };
}

export function formatWorkflowPreflight({
  mode,
  firstAgent,
  options,
  preflight,
}: {
  mode: ChatWorkflowMode;
  firstAgent?: AgentName;
  options: BridgeOptions;
  preflight: WorkflowPreflight;
}): string {
  const role =
    mode === 'review'
      ? 'Both agents review; nobody edits'
      : mode === 'collaborative'
        ? `${agentLabel(firstAgent ?? 'claude')} edits first; the agents alternate editing and review`
        : `${agentLabel(firstAgent ?? 'codex')} edits; the other agent reviews`;
  const verification =
    mode === 'review'
      ? 'Not run during read-only review'
      : preflight.projectConfig.config.verification.length === 0
        ? 'No project verification commands configured'
        : options.trustProjectConfig
          ? `${preflight.projectConfig.config.verification.length} project verification command(s) approved`
          : `${preflight.projectConfig.config.verification.length} project verification command(s) not approved`;
  const dirty =
    mode === 'review'
      ? 'Read-only; existing files are not changed'
      : preflight.dirtyStatus
        ? options.isolation
          ? 'Existing changes stay in your checkout; isolated work starts from committed HEAD'
          : 'Agents edit alongside acknowledged existing changes'
        : 'Working tree is clean';

  const patchDecision =
    mode !== 'review' && options.isolation
      ? '\nAfter editing, you choose whether to apply, keep, or discard the result.'
      : '';
  const heading = options.screenReader
    ? 'Workflow preview.'
    : 'Workflow preview\n----------------';
  return sanitizeTerminalText(`${heading}
Project: ${options.cwd}
Plan: ${role}
Workspace: ${mode === 'review' ? 'Selected project (read-only)' : options.isolation ? 'New isolated Git worktree' : 'Selected checkout'}
Existing changes: ${dirty}
Verification: ${verification}
Maximum cycles: ${options.maxRounds}
Estimated provider calls: ${preflight.estimate.minimum}–${preflight.estimate.maximum}
The agents will not commit, push, or stage your files.${patchDecision}
`);
}
