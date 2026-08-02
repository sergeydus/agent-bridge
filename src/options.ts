import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { AgentName, ReasoningEffort } from './core.ts';
import { getAppPaths } from './paths.ts';
import type { UiMode } from './terminal-capabilities.ts';

export interface BridgeOptions {
  chat: boolean;
  cwd: string;
  cwdExplicit: boolean;
  rounds: number;
  maxRounds: number;
  maxAutoRounds: number;
  untilAgreement: boolean;
  requireAgreement: boolean;
  allowDirty: boolean;
  fromHead: boolean;
  isolation: boolean;
  verbose: boolean;
  retries: number;
  timeoutMinutes: number;
  judge: AgentName;
  output: string;
  dryRun: boolean;
  noTranscript: boolean;
  screenReader: boolean;
  screenReaderExplicit: boolean;
  noColor: boolean;
  ui: UiMode;
  uiExplicit: boolean;
  trustProjectConfig: boolean;
  doctor: boolean;
  wizard: boolean;
  help?: boolean;
  task?: string;
  taskFile?: string;
  gitDiff?: string;
  implementer?: AgentName;
  collaborative?: AgentName;
  resume?: string;
  codexModel?: string;
  claudeModel?: string;
  codexEffort?: ReasoningEffort;
  claudeEffort?: ReasoningEffort;
  projectConfigPath?: string;
  listRuns?: boolean;
  listChats?: boolean;
  deleteRun?: string;
  deleteChat?: string;
  discardWorkspace?: string;
  pruneRunsDays?: number;
}

export const HELP = `Agent Bridge

Usage:
  agent-bridge
  agent-bridge chat [options]
  agent-bridge chat --resume <id|latest>
  agent-bridge --task "..." [options]
  agent-bridge [options] < task.md

Options:
  --wizard                Guided setup, including safe Git setup for editing
  --list-chats            List saved interactive chats and exit
  --delete-chat <id>      Delete one saved interactive chat
  --task <text>           Task to discuss; otherwise read stdin
  --task-file <path>      Read the task from a file
  --git-diff <source>     working-tree, last-commit, or a Git diff range
  --cwd <path>            Project folder visible to the agents
  --rounds <number>       Response rounds, default: 2
  --until-agreement       Continue until both agents return done
  --require-agreement     Return a non-zero exit code if agreement is not reached
  --max-rounds <number>   Workflow agreement/cycle cap, default: 6
  --max-auto-rounds <n>   Automatic chat exchange cap, default: 6
  --implementer <agent>   Let codex or claude edit; the other reviews
  --collaborative <agent> Discuss, then alternate edits; agent edits first
  --allow-dirty           Permit direct editing with existing local changes
  --from-head             Explicitly ignore local changes in an isolated run
  --no-isolation          Edit the current checkout instead of a safe worktree
  --resume <id|latest>    Continue a run, or reopen a chat in chat mode
  --retries <number>      Retry transient read-only failures, default: 1
  --timeout-minutes <n>   Per-agent call timeout, default: 30
  --verbose               Show provider diagnostic output
  --judge codex|claude    Synthesis agent, default: codex
  --codex-model <name>    Optional Codex model override
  --claude-model <name>   Optional Claude model override
  --codex-effort <level>  low, medium, high, xhigh, or max
  --claude-effort <level> low, medium, high, xhigh, or max
  --output <directory>    Override transcript and workspace storage
  --no-transcript         Remove completed run or chat transcripts
  --screen-reader         Use append-only, screen-reader-friendly presentation
  --no-color              Disable Agent Bridge color output
  --ui <mode>             Chat interface: plain, enhanced, or auto
  --project-config <path> Use a specific .agent-bridge.json configuration
  --trust-project-config  Run verification commands from project configuration
  --list-runs             List saved runs and exit
  --delete-run <id>       Delete one run's saved state and artifacts
  --discard-workspace <id>  Safely remove a completed run's isolated worktree
  --prune-runs <days>     Delete completed run artifacts older than N days
  --dry-run               Print planned commands without calling agents
  --doctor                Check versions, auth, storage, and required features
  --help                  Show this help
`;

export function parseArgs(
  argv: string[],
  {
    initialCwd = process.cwd(),
    defaultOutput = getAppPaths().runsDirectory,
  }: { initialCwd?: string; defaultOutput?: string } = {},
): BridgeOptions {
  const args = [...argv];
  const chat = args[0] === 'chat';
  if (chat) {
    args.shift();
  }
  const options: BridgeOptions = {
    chat,
    cwd: initialCwd,
    cwdExplicit: false,
    rounds: 2,
    maxRounds: 6,
    maxAutoRounds: 6,
    untilAgreement: false,
    requireAgreement: false,
    allowDirty: false,
    fromHead: false,
    isolation: true,
    verbose: false,
    retries: 1,
    timeoutMinutes: 30,
    judge: 'codex',
    output: defaultOutput,
    dryRun: false,
    noTranscript: false,
    screenReader: false,
    screenReaderExplicit: false,
    noColor: false,
    ui: 'auto',
    uiExplicit: false,
    trustProjectConfig: false,
    doctor: false,
    wizard: false,
  };

  const valueSetters: Record<string, (value: string) => void> = {
    task: (value) => {
      options.task = value;
    },
    'task-file': (value) => {
      options.taskFile = value;
    },
    'git-diff': (value) => {
      options.gitDiff = value;
    },
    cwd: (value) => {
      options.cwd = value;
      options.cwdExplicit = true;
    },
    rounds: (value) => {
      options.rounds = Number(value);
    },
    'max-rounds': (value) => {
      options.maxRounds = Number(value);
    },
    'max-auto-rounds': (value) => {
      options.maxAutoRounds = Number(value);
    },
    implementer: (value) => {
      options.implementer = value as AgentName;
    },
    collaborative: (value) => {
      options.collaborative = value as AgentName;
    },
    resume: (value) => {
      options.resume = value;
    },
    retries: (value) => {
      options.retries = Number(value);
    },
    'timeout-minutes': (value) => {
      options.timeoutMinutes = Number(value);
    },
    judge: (value) => {
      options.judge = value as AgentName;
    },
    'codex-model': (value) => {
      options.codexModel = value;
    },
    'claude-model': (value) => {
      options.claudeModel = value;
    },
    'codex-effort': (value) => {
      options.codexEffort = value as ReasoningEffort;
    },
    'claude-effort': (value) => {
      options.claudeEffort = value as ReasoningEffort;
    },
    output: (value) => {
      options.output = value;
    },
    'project-config': (value) => {
      options.projectConfigPath = value;
    },
    ui: (value) => {
      options.ui = value as UiMode;
      options.uiExplicit = true;
    },
    'delete-run': (value) => {
      options.deleteRun = value;
    },
    'delete-chat': (value) => {
      options.deleteChat = value;
    },
    'discard-workspace': (value) => {
      options.discardWorkspace = value;
    },
    'prune-runs': (value) => {
      options.pruneRunsDays = Number(value);
    },
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }

    const booleanOption = {
      '--help': (): void => {
        options.help = true;
      },
      '-h': (): void => {
        options.help = true;
      },
      '--dry-run': (): void => {
        options.dryRun = true;
      },
      '--doctor': (): void => {
        options.doctor = true;
      },
      '--wizard': (): void => {
        options.wizard = true;
      },
      '--until-agreement': (): void => {
        options.untilAgreement = true;
      },
      '--require-agreement': (): void => {
        options.untilAgreement = true;
        options.requireAgreement = true;
      },
      '--allow-dirty': (): void => {
        options.allowDirty = true;
      },
      '--from-head': (): void => {
        options.fromHead = true;
      },
      '--no-isolation': (): void => {
        options.isolation = false;
      },
      '--verbose': (): void => {
        options.verbose = true;
      },
      '--no-transcript': (): void => {
        options.noTranscript = true;
      },
      '--screen-reader': (): void => {
        options.screenReader = true;
        options.screenReaderExplicit = true;
        options.noColor = true;
      },
      '--no-color': (): void => {
        options.noColor = true;
      },
      '--trust-project-config': (): void => {
        options.trustProjectConfig = true;
      },
      '--list-runs': (): void => {
        options.listRuns = true;
      },
      '--list-chats': (): void => {
        options.listChats = true;
      },
    }[arg];
    if (booleanOption) {
      booleanOption();
      continue;
    }

    const key = arg.startsWith('--') ? arg.slice(2) : '';
    const setter = valueSetters[key];
    if (!setter) {
      throw new Error(`Unknown argument: ${arg}`);
    }

    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    index += 1;
    setter(value);
  }

  options.cwd = resolve(options.cwd);
  options.output = resolve(options.output);

  if (
    !Number.isInteger(options.rounds) ||
    options.rounds < 1 ||
    options.rounds > 10
  ) {
    throw new Error('--rounds must be an integer from 1 to 10');
  }
  if (
    !Number.isInteger(options.maxRounds) ||
    options.maxRounds < 2 ||
    options.maxRounds > 20
  ) {
    throw new Error('--max-rounds must be an integer from 2 to 20');
  }
  if (
    !Number.isInteger(options.maxAutoRounds) ||
    options.maxAutoRounds < 1 ||
    options.maxAutoRounds > 20
  ) {
    throw new Error('--max-auto-rounds must be an integer from 1 to 20');
  }
  if (
    !Number.isInteger(options.retries) ||
    options.retries < 0 ||
    options.retries > 3
  ) {
    throw new Error('--retries must be an integer from 0 to 3');
  }
  if (
    !Number.isInteger(options.timeoutMinutes) ||
    options.timeoutMinutes < 1 ||
    options.timeoutMinutes > 180
  ) {
    throw new Error('--timeout-minutes must be an integer from 1 to 180');
  }
  if (!['codex', 'claude'].includes(options.judge)) {
    throw new Error('--judge must be codex or claude');
  }
  if (
    options.implementer &&
    !['codex', 'claude'].includes(options.implementer)
  ) {
    throw new Error('--implementer must be codex or claude');
  }
  if (
    options.collaborative &&
    !['codex', 'claude'].includes(options.collaborative)
  ) {
    throw new Error('--collaborative must be codex or claude');
  }
  if (options.implementer && options.collaborative) {
    throw new Error('Use either --implementer or --collaborative, not both');
  }
  if (
    options.chat &&
    (options.implementer || options.collaborative || options.gitDiff)
  ) {
    throw new Error(
      'Choose editing or review roles inside chat with /edit, /implement, /collaborate, or /review',
    );
  }
  if (options.chat && (!options.isolation || options.allowDirty)) {
    throw new Error(
      'Interactive chat editing always uses the isolated workflow; remove --no-isolation and --allow-dirty',
    );
  }
  const validEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
  if (options.codexEffort && !validEfforts.includes(options.codexEffort)) {
    throw new Error('--codex-effort must be low, medium, high, xhigh, or max');
  }
  // Which levels a given model accepts is the provider's decision, not a fixed
  // list here: Claude's xhigh support varies by model.
  if (options.claudeEffort && !validEfforts.includes(options.claudeEffort)) {
    throw new Error('--claude-effort must be low, medium, high, xhigh, or max');
  }
  if (!['plain', 'enhanced', 'auto'].includes(options.ui)) {
    throw new Error('--ui must be plain, enhanced, or auto');
  }
  if (!options.chat && options.uiExplicit && options.ui !== 'plain') {
    throw new Error('--ui enhanced and --ui auto currently require chat mode');
  }
  for (const [flag, model] of [
    ['--codex-model', options.codexModel],
    ['--claude-model', options.claudeModel],
  ] as const) {
    if (model && (model.length > 200 || /\s/.test(model))) {
      throw new Error(`${flag} must be one model name without spaces`);
    }
  }
  if (options.implementer || options.collaborative) {
    options.untilAgreement = true;
  }
  if (
    options.pruneRunsDays !== undefined &&
    (!Number.isInteger(options.pruneRunsDays) ||
      options.pruneRunsDays < 0 ||
      options.pruneRunsDays > 3650)
  ) {
    throw new Error('--prune-runs must be an integer from 0 to 3650');
  }
  const managementActions = [
    Boolean(options.listRuns),
    Boolean(options.listChats),
    Boolean(options.deleteRun),
    Boolean(options.deleteChat),
    Boolean(options.discardWorkspace),
    options.pruneRunsDays !== undefined,
  ].filter(Boolean).length;
  if (managementActions > 1) {
    throw new Error('Use only one run-management option at a time');
  }
  if ((options.listChats || options.deleteChat) && !options.chat) {
    throw new Error(
      '--list-chats and --delete-chat require `agent-bridge chat`',
    );
  }
  if (!existsSync(options.cwd)) {
    throw new Error(`Working directory does not exist: ${options.cwd}`);
  }

  return options;
}
