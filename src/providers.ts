import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  isTransientAgentFailure,
  type AgentName,
  type ReasoningEffort,
} from './core.ts';
import { runProcess, type ProcessResult } from './process.ts';
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

export interface ProviderRunOptions {
  cwd: string;
  tempDirectory: string;
  writeAccess: boolean;
  verbose: boolean;
  dryRun: boolean;
  timeoutMs: number;
  responseKind: ResponseKind;
  isGitRepository: boolean;
  screenReader: boolean;
  signal?: AbortSignal;
  model?: string;
  effort?: ReasoningEffort;
  onEvent?: ProviderEventSink;
}

export interface AgentProvider {
  readonly name: AgentName;
  readonly label: string;
  run(prompt: string, options: ProviderRunOptions): Promise<AgentResponse>;
  version(): Promise<ProcessResult>;
  authStatus(): Promise<ProcessResult>;
}

export class CodexProvider implements AgentProvider {
  readonly name = 'codex';
  readonly label = 'Codex';

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

    if (options.dryRun) {
      return {
        text: `[dry-run] codex ${args.join(' ')}`,
        ...(options.responseKind === 'turn'
          ? { decision: 'continue' as const }
          : {}),
      };
    }

    await writeFile(
      schemaPath,
      `${JSON.stringify(schemaFor(options.responseKind), null, 2)}\n`,
      { mode: 0o600 },
    );
    const events = new CodexEventStream(options.responseKind, options.onEvent);
    await runProcess('codex', args, {
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
  }
}

export class ClaudeProvider implements AgentProvider {
  readonly name = 'claude';
  readonly label = 'Claude';

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
    const systemPrompt = options.writeAccess
      ? `You are the designated implementation agent in a controlled
implement-review workflow. Use the provided tools to inspect and edit only the
task's repository. Preserve unrelated user changes. Never commit, stage,
discard, or revert work. Agent Bridge runs user-approved verification commands;
do not try to execute shell commands yourself.
Discover and read applicable AGENTS.md and CLAUDE.md files before editing.`
      : `You are the read-only analysis agent in a controlled technical
workflow. Inspect the provided repository when useful, but never edit, stage,
commit, revert, or run mutating commands. Base findings on concrete evidence.
Discover and read applicable AGENTS.md and CLAUDE.md files before analysis.`;
    const tools = options.writeAccess
      ? 'Edit,Read,Write,Glob,Grep'
      : 'Read,Glob,Grep';
    const args = [
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--json-schema',
      JSON.stringify(schemaFor(options.responseKind)),
      '--system-prompt',
      systemPrompt,
      '--permission-mode',
      options.writeAccess ? 'acceptEdits' : 'plan',
      '--tools',
      tools,
      '--no-session-persistence',
      '--max-turns',
      '50',
      '--safe-mode',
      '--allowedTools',
      options.writeAccess
        ? ['Read', 'Glob', 'Grep', 'Edit', 'Write'].join(',')
        : 'Read,Glob,Grep',
    ];

    if (options.model) {
      args.push('--model', options.model);
    }
    if (options.effort) {
      args.push('--effort', options.effort);
    }
    if (options.screenReader) {
      args.push('--ax-screen-reader');
    }

    if (options.dryRun) {
      return {
        text: `[dry-run] claude ${args.join(' ')}`,
        ...(options.responseKind === 'turn'
          ? { decision: 'continue' as const }
          : {}),
      };
    }

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
