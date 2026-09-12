import { randomUUID } from 'node:crypto';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  AGENT_NAMES,
  errorMessage,
  isTransientAgentFailure,
  type AgentName,
  type ReasoningEffort,
} from './core.ts';
import {
  combinedProcessOutput,
  runProcess,
  type ProcessResult,
} from './process.ts';
import {
  ClaudeEventStream,
  CodexEventStream,
  type ProviderEventSink,
} from './provider-events.ts';
import {
  parseProviderResponse,
  schemaFor,
  type AgentResponse,
  type ResponseKind,
} from './response.ts';

const MAX_PROVIDER_RESPONSE_BYTES = 2_000_000;
const MAX_PROVIDER_PROCESS_OUTPUT_CHARS = 10_000_000;

/**
 * Codex only enables its Windows restricted-token sandbox when
 * `windows.sandbox` is configured. Agent Bridge deliberately runs Codex with
 * `--ignore-user-config`, so the value has to be supplied explicitly;
 * otherwise `--sandbox workspace-write` degrades to a read-only sandbox that
 * rejects every edit. `unelevated` is the lower-privilege mode and does not
 * require an administrative terminal.
 */
const CODEX_WINDOWS_SANDBOX = 'unelevated';

/**
 * Provider system prompts are passed as command-line arguments, so they must
 * stay on one line. See `findLineBreakArgument`.
 */
const CLAUDE_WRITE_SYSTEM_PROMPT = [
  'You are the designated implementation agent in a controlled implement-review',
  "workflow. Use the provided tools to inspect and edit only the task's",
  'repository. Preserve unrelated user changes. Never commit, stage, discard,',
  'or revert work. Agent Bridge runs user-approved verification commands; do',
  'not try to execute shell commands yourself. Discover and read applicable',
  'AGENTS.md and CLAUDE.md files before editing.',
].join(' ');

const CLAUDE_READ_ONLY_SYSTEM_PROMPT = [
  'You are the read-only analysis agent in a controlled technical workflow.',
  'Inspect the provided repository when useful, but never edit, stage, commit,',
  'revert, or run mutating commands. Base findings on concrete evidence.',
  'Discover and read applicable AGENTS.md and CLAUDE.md files before analysis.',
].join(' ');

/**
 * Flags the adapters emit on every call and that the provider CLIs advertise in
 * their own help output. `--doctor` verifies these, so a provider release that
 * renames or drops one is reported instead of failing mid-run. Conditional
 * flags are deliberately absent: Codex's `--skip-git-repo-check`, `--config`,
 * and `--model`, and Claude's `--model` and `--effort`, only appear when the
 * project or the user asks for them, so a missing one is not a reason to call
 * an installation incompatible.
 */
export const CODEX_REQUIRED_FLAGS = [
  '--sandbox',
  '--ephemeral',
  '--ignore-user-config',
  '--color',
  '--cd',
  '--json',
  '--output-last-message',
  '--output-schema',
] as const;

export const CLAUDE_REQUIRED_FLAGS = [
  '--print',
  '--output-format',
  '--verbose',
  '--include-partial-messages',
  '--json-schema',
  '--system-prompt',
  '--permission-mode',
  '--tools',
  '--no-session-persistence',
  '--allowedTools',
] as const;

/**
 * Required flags the CLI implements but omits from `--help`. Claude Code
 * registers `--max-turns` as a hidden option, so help inspection cannot confirm
 * it and must not gate it either: omitting the flag would remove the turn bound
 * on every write call. These need a version rule or a parser probe rather than
 * the capability gate used for `CLAUDE_OPTIONAL_FLAGS`.
 */
export const CLAUDE_REQUIRED_HIDDEN_FLAGS = ['--max-turns'] as const;

/**
 * Claude separates tool availability from tool permission, so both flags are
 * needed and are not redundant. `--tools` selects which built-in tools exist
 * for the turn; `--allowedTools` is the allow-without-prompting list that keeps
 * a non-interactive call from stalling on a confirmation. Bash is absent from
 * both: approved project commands are the coordinator's responsibility.
 */
const CLAUDE_WRITE_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write'] as const;
const CLAUDE_READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const;

export interface ProviderRunOptions {
  cwd: string;
  tempDirectory: string;
  writeAccess: boolean;
  verbose: boolean;
  dryRun: boolean;
  timeoutMs: number;
  responseKind: ResponseKind;
  isGitRepository: boolean;
  /**
   * Claude receives its native accessible renderer flag when the installed CLI
   * advertises support. Agent Bridge always keeps its own semantic renderer.
   */
  screenReader: boolean;
  signal?: AbortSignal;
  model?: string;
  effort?: ReasoningEffort;
  onEvent?: ProviderEventSink;
  /** Injected only so platform-specific flags stay unit-testable. */
  platform?: NodeJS.Platform;
}

export interface AgentProvider {
  readonly name: AgentName;
  readonly label: string;
  run(prompt: string, options: ProviderRunOptions): Promise<AgentResponse>;
  version(): Promise<ProcessResult>;
  authStatus(): Promise<ProcessResult>;
}

/**
 * Builds Codex's argument vector. Kept pure so the dry run, the drift test that
 * compares emitted flags against `CODEX_REQUIRED_FLAGS`, and the single-line
 * argument check all work without a provider CLI installed.
 */
export function codexArguments(
  options: Pick<
    ProviderRunOptions,
    'cwd' | 'writeAccess' | 'isGitRepository' | 'model' | 'effort' | 'platform'
  >,
  { outputPath, schemaPath }: { outputPath: string; schemaPath: string },
): string[] {
  const args = [
    'exec',
    '--sandbox',
    options.writeAccess ? 'workspace-write' : 'read-only',
    '--ephemeral',
    '--ignore-user-config',
    '--color',
    'never',
    '--cd',
    options.cwd,
    '--json',
    '--output-last-message',
    outputPath,
    '--output-schema',
    schemaPath,
  ];
  if (!options.isGitRepository) {
    args.push('--skip-git-repo-check');
  }
  if ((options.platform ?? process.platform) === 'win32') {
    args.push(
      '--config',
      `windows.sandbox=${JSON.stringify(CODEX_WINDOWS_SANDBOX)}`,
    );
  }
  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.effort) {
    args.push(
      '--config',
      `model_reasoning_effort=${JSON.stringify(options.effort)}`,
    );
  }
  args.push('-');
  return args;
}

export class CodexProvider implements AgentProvider {
  readonly name = 'codex';
  readonly label = 'Codex';
  // Node 22.6 strips types without accepting `readonly` or `?` on a `#` field.
  #runProcess: typeof runProcess;

  /** The launcher is injected only so per-call cleanup stays unit-testable. */
  constructor(processRunner: typeof runProcess = runProcess) {
    this.#runProcess = processRunner;
  }

  version(): Promise<ProcessResult> {
    return runProcess('codex', ['--version'], { timeoutMs: 10_000 });
  }

  authStatus(): Promise<ProcessResult> {
    return runProcess('codex', ['login', 'status'], { timeoutMs: 10_000 });
  }

  async run(
    prompt: string,
    options: ProviderRunOptions,
  ): Promise<AgentResponse> {
    const outputPath = join(options.tempDirectory, `codex-${randomUUID()}.txt`);
    const schemaPath = join(
      options.tempDirectory,
      `codex-schema-${randomUUID()}.json`,
    );
    const args = codexArguments(options, { outputPath, schemaPath });

    if (options.dryRun) {
      return {
        text: `[dry-run] codex ${args.join(' ')}`,
        ...(options.responseKind === 'turn'
          ? { decision: 'continue' as const }
          : {}),
      };
    }

    try {
      await writeFile(
        schemaPath,
        `${JSON.stringify(schemaFor(options.responseKind), null, 2)}\n`,
        { mode: 0o600 },
      );
      const events = new CodexEventStream(
        options.responseKind,
        options.onEvent,
      );
      await this.#runProcess('codex', args, {
        cwd: options.cwd,
        input: prompt,
        inheritStderr: options.verbose,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        maxOutputChars: MAX_PROVIDER_PROCESS_OUTPUT_CHARS,
        captureStdout: false,
        onStdoutChunk: (chunk) => events.push(chunk),
      });
      events.finish();
      if ((await stat(outputPath)).size > MAX_PROVIDER_RESPONSE_BYTES) {
        throw new Error(
          `Codex response exceeded ${MAX_PROVIDER_RESPONSE_BYTES} bytes.`,
        );
      }
      return parseProviderResponse(
        (await readFile(outputPath, 'utf8')).trim(),
        options.responseKind,
      );
    } finally {
      // These are per-call scratch files holding the prompt's response schema
      // and Codex's last message. The run's temporary directory is only removed
      // when the whole run ends, so a long run would otherwise accumulate one
      // pair per turn. Cleanup runs on success, failure, and cancellation
      // alike, and always after the response has been read.
      await Promise.all([
        rm(schemaPath, { force: true }).catch(() => {}),
        rm(outputPath, { force: true }).catch(() => {}),
      ]);
    }
  }
}

/**
 * Flags Agent Bridge uses when the installed CLI offers them. Provider CLIs
 * gain and lose flags between releases, and an unrecognized flag aborts the
 * whole call, so support is detected rather than assumed in either direction.
 */
export const CLAUDE_OPTIONAL_FLAGS = {
  /** Excludes project and user customizations: CLAUDE.md, hooks, plugins, MCP. */
  safeMode: '--safe-mode',
  /** Provider-native accessible rendering. */
  screenReader: '--ax-screen-reader',
} as const;

/**
 * Extracts the flags a CLI declares as options in its own help output.
 *
 * Two narrowings matter. Whole tokens only, because substring matching would
 * accept `--json` merely because `--json-schema` is present. And declarations
 * only: a flag named inside another option's description is a mention, not an
 * offer, so a removed option must not look supported because some other
 * description still references it. Help lists an option at the start of its
 * line and separates the description by a gap of two or more spaces.
 */
export function parseAdvertisedFlags(helpText: string): ReadonlySet<string> {
  const flags = new Set<string>();
  for (const line of helpText.split('\n')) {
    const declaration = /^\s*(-[^\s].*?)(?:\s{2,}|$)/.exec(line)?.[1];
    if (!declaration) {
      continue;
    }
    for (const flag of declaration.match(/--[a-zA-Z][\w-]*/g) ?? []) {
      flags.add(flag);
    }
  }
  return flags;
}

/**
 * Reads the flags a CLI advertises in its own help output. A failed probe
 * yields an empty set, which omits optional flags rather than risking a call
 * that the installed CLI would reject outright.
 */
export async function probeSupportedFlags(
  command: string,
  args: string[] = ['--help'],
): Promise<ReadonlySet<string>> {
  try {
    const { stdout, stderr } = await runProcess(command, args, {
      timeoutMs: 10_000,
    });
    return parseAdvertisedFlags(combinedProcessOutput({ stdout, stderr }));
  } catch {
    return new Set<string>();
  }
}

/**
 * The oldest Claude Code release Agent Bridge is tested against. It is a tested
 * floor, not the release that introduced any particular flag. It exists so
 * `CLAUDE_REQUIRED_HIDDEN_FLAGS` — which help inspection cannot confirm — still
 * has a check behind it rather than an unverified assumption.
 */
export const CLAUDE_MINIMUM_VERSION = '2.0.0';

/** Parses a leading `major.minor.patch` from a `--version` line. */
export function parseProviderVersion(output: string): number[] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return match
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : undefined;
}

export function meetsMinimumVersion(
  output: string,
  minimum: string,
): boolean | undefined {
  const actual = parseProviderVersion(output);
  const required = parseProviderVersion(minimum);
  if (!actual || !required) {
    return undefined;
  }
  for (const [index, floor] of required.entries()) {
    const value = actual[index] ?? 0;
    if (value !== floor) {
      return value > floor;
    }
  }
  return true;
}

const NO_FLAGS: ReadonlySet<string> = new Set<string>();

/**
 * Builds Claude's argument vector. Optional flags appear only when
 * `supportedFlags` advertises them; every value stays on a single line.
 */
export function claudeArguments(
  options: Pick<
    ProviderRunOptions,
    'writeAccess' | 'responseKind' | 'screenReader' | 'model' | 'effort'
  >,
  supportedFlags: ReadonlySet<string>,
): string[] {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--json-schema',
    JSON.stringify(schemaFor(options.responseKind)),
    '--system-prompt',
    options.writeAccess
      ? CLAUDE_WRITE_SYSTEM_PROMPT
      : CLAUDE_READ_ONLY_SYSTEM_PROMPT,
    '--permission-mode',
    options.writeAccess ? 'acceptEdits' : 'plan',
    '--tools',
    (options.writeAccess ? CLAUDE_WRITE_TOOLS : CLAUDE_READ_ONLY_TOOLS).join(
      ',',
    ),
    '--no-session-persistence',
    '--max-turns',
    '50',
    '--allowedTools',
    (options.writeAccess ? CLAUDE_WRITE_TOOLS : CLAUDE_READ_ONLY_TOOLS).join(
      ',',
    ),
  ];

  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.effort) {
    args.push('--effort', options.effort);
  }
  // Isolating the agent from the target project's discovered customizations
  // matters most here, because the project is untrusted input.
  if (supportedFlags.has(CLAUDE_OPTIONAL_FLAGS.safeMode)) {
    args.push(CLAUDE_OPTIONAL_FLAGS.safeMode);
  }
  if (
    options.screenReader &&
    supportedFlags.has(CLAUDE_OPTIONAL_FLAGS.screenReader)
  ) {
    args.push(CLAUDE_OPTIONAL_FLAGS.screenReader);
  }
  return args;
}

export class ClaudeProvider implements AgentProvider {
  readonly name = 'claude';
  readonly label = 'Claude';
  // Node 22.6 strips types without accepting `readonly` or `?` on a `#` field.
  #probeFlags: () => Promise<ReadonlySet<string>>;
  #supportedFlags: Promise<ReadonlySet<string>> | undefined;

  constructor(
    probeFlags: () => Promise<ReadonlySet<string>> = () =>
      probeSupportedFlags('claude'),
  ) {
    this.#probeFlags = probeFlags;
  }

  /** Probed once per provider instance; every call reuses the result. */
  supportedFlags(): Promise<ReadonlySet<string>> {
    this.#supportedFlags ??= this.#probeFlags();
    return this.#supportedFlags;
  }

  version(): Promise<ProcessResult> {
    return runProcess('claude', ['--version'], { timeoutMs: 10_000 });
  }

  authStatus(): Promise<ProcessResult> {
    return runProcess('claude', ['auth', 'status', '--json'], {
      timeoutMs: 10_000,
    });
  }

  async run(
    prompt: string,
    options: ProviderRunOptions,
  ): Promise<AgentResponse> {
    if (options.dryRun) {
      // A dry run stays side-effect free, so it never probes the installed CLI
      // and prints the version-independent command.
      return {
        text: `[dry-run] claude ${claudeArguments(options, NO_FLAGS).join(' ')}`,
        ...(options.responseKind === 'turn'
          ? { decision: 'continue' as const }
          : {}),
      };
    }

    const args = claudeArguments(options, await this.supportedFlags());
    const events = new ClaudeEventStream(options.responseKind, options.onEvent);
    await runProcess('claude', args, {
      cwd: options.cwd,
      input: prompt,
      inheritStderr: options.verbose,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      maxOutputChars: MAX_PROVIDER_PROCESS_OUTPUT_CHARS,
      captureStdout: false,
      onStdoutChunk: (chunk) => events.push(chunk),
    });

    return events.finish();
  }
}

export type ProviderMap = Record<AgentName, AgentProvider>;

export function createDefaultProviders(): ProviderMap {
  return {
    codex: new CodexProvider(),
    claude: new ClaudeProvider(),
  };
}

export class ProviderAvailabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderAvailabilityError';
  }
}

export async function assertProvidersAvailable(
  providers: ProviderMap,
): Promise<void> {
  const agents = AGENT_NAMES;
  const checks = await Promise.allSettled(
    agents.map(async (agent) => {
      await providers[agent].version();
    }),
  );
  const failures = checks.flatMap((check, index) => {
    if (check.status === 'fulfilled') {
      return [];
    }
    const agent = agents[index];
    return agent
      ? [`- ${providers[agent].label}: ${errorMessage(check.reason)}`]
      : [];
  });
  if (failures.length === 0) {
    return;
  }

  throw new ProviderAvailabilityError(
    [
      'Agent Bridge could not start every required provider CLI:',
      ...failures,
      '',
      'Run `codex --version` and `claude --version` in this terminal.',
      'For complete setup diagnostics, run `agent-bridge --doctor` ' +
        '(or `npm run doctor` from the source checkout).',
    ].join('\n'),
  );
}

export async function runProviderWithRetry({
  provider,
  prompt,
  options,
  retries,
  onRetry,
  sleep = (milliseconds) =>
    new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
}: {
  provider: AgentProvider;
  prompt: string;
  options: ProviderRunOptions;
  retries: number;
  onRetry?: (attempt: number) => void;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<AgentResponse> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await provider.run(prompt, options);
    } catch (error) {
      const canRetry =
        !options.writeAccess &&
        attempt < retries &&
        isTransientAgentFailure(error);
      if (!canRetry) {
        throw error;
      }

      onRetry?.(attempt + 1);
      await sleep(1_000 * (attempt + 1));
    }
  }
}
