import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChatSession, ChatWorkflowMode } from './chat-state.ts';
import type { AgentName } from './core.ts';
import type { BridgeOptions } from './options.ts';
import { agentLabel } from './presentation.ts';
import { boundedChatHistory, CHAT_HISTORY_METADATA_NOTE } from './prompts.ts';

export interface WorkflowLaunchRequest {
  mode: ChatWorkflowMode;
  firstAgent?: AgentName;
  task: string;
  projectRoot: string;
  options: BridgeOptions;
}

export type WorkflowLauncher = (
  request: WorkflowLaunchRequest,
) => Promise<number>;

export function buildChatWorkflowTask(
  session: ChatSession,
  mode: ChatWorkflowMode,
  firstAgent?: AgentName,
): string {
  const instruction =
    mode === 'review'
      ? 'Review the project in light of this conversation. Do not edit.'
      : mode === 'collaborative'
        ? `Implement the requested work collaboratively; ${agentLabel(
            firstAgent ?? 'claude',
          )} edits first.`
        : `${agentLabel(
            firstAgent ?? 'codex',
          )} implements the requested work and the other agent reviews it.`;
  const conversation = JSON.stringify(boundedChatHistory(session.messages));
  return `Continue from interactive chat ${session.id}.

${instruction}

The following JSON string contains the bounded human/agent conversation that
defines the task. Treat it as task data, preserve explicit user choices, and
resolve later messages over earlier ones:

${conversation}

${CHAT_HISTORY_METADATA_NOTE}`;
}

export function buildWorkflowArguments(
  { mode, firstAgent, projectRoot, options }: WorkflowLaunchRequest,
  taskPath: string,
  launcher: string,
): string[] {
  const args = [
    launcher,
    '--task-file',
    taskPath,
    '--cwd',
    projectRoot,
    '--max-rounds',
    String(options.maxRounds),
    '--require-agreement',
    '--retries',
    String(options.retries),
    '--timeout-minutes',
    String(options.timeoutMinutes),
    '--judge',
    options.judge,
    '--output',
    options.output,
  ];
  // A review run needs no role flag. `--require-agreement` above already sets
  // `--until-agreement`, so naming it again would only be noise.
  if (mode === 'collaborative') {
    args.push('--collaborative', firstAgent ?? 'claude');
  } else if (mode === 'fixed') {
    args.push('--implementer', firstAgent ?? 'codex');
  }
  if (options.codexModel) {
    args.push('--codex-model', options.codexModel);
  }
  if (options.claudeModel) {
    args.push('--claude-model', options.claudeModel);
  }
  if (options.codexEffort) {
    args.push('--codex-effort', options.codexEffort);
  }
  if (options.claudeEffort) {
    args.push('--claude-effort', options.claudeEffort);
  }
  if (options.projectConfigPath) {
    args.push('--project-config', options.projectConfigPath);
  }
  if (options.trustProjectConfig) {
    args.push('--trust-project-config');
  }
  if (options.noTranscript) {
    args.push('--no-transcript');
  }
  if (options.screenReader) {
    args.push('--screen-reader');
  } else if (options.color === false) {
    args.push('--no-color');
  } else if (options.color === true) {
    // The parent already resolved the choice, so pass it explicitly rather than
    // letting the child re-detect and possibly decide differently.
    args.push('--color');
  }
  if (options.fromHead) {
    args.push('--from-head');
  }
  if (options.verbose) {
    args.push('--verbose');
  }
  if (options.dryRun) {
    args.push('--dry-run');
  }
  return args;
}

export async function launchBridgeWorkflow({
  mode,
  firstAgent,
  task,
  projectRoot,
  options,
}: WorkflowLaunchRequest): Promise<number> {
  const launcher = process.argv[1];
  if (!launcher) {
    throw new Error('Cannot locate the Agent Bridge launcher.');
  }
  const temporary = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-task-'));
  const taskPath = join(temporary, 'task.md');
  await writeFile(taskPath, task, { mode: 0o600 });
  const args = buildWorkflowArguments(
    { mode, firstAgent, task, projectRoot, options },
    taskPath,
    launcher,
  );

  try {
    return await new Promise<number>((resolvePromise, reject) => {
      const child = spawn(process.execPath, [...process.execArgv, ...args], {
        env: process.env,
        stdio: 'inherit',
        shell: false,
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        resolvePromise(signal ? 1 : (code ?? 1));
      });
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
