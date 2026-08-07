import spawn from 'cross-spawn';

export class ProcessAbortError extends Error {
  constructor(message = 'Process was cancelled') {
    super(message);
    this.name = 'AbortError';
  }
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

/**
 * A CLI may write help and capability information to either stream. Callers
 * that inspect human-readable output should treat both streams as one listing.
 */
export function combinedProcessOutput(
  result: Pick<ProcessResult, 'stdout' | 'stderr'>,
): string {
  return `${result.stdout}\n${result.stderr}`;
}

const TRUNCATION_MARKER = '\n…[output truncated]…\n';

/**
 * Windows resolves npm-installed CLIs such as `codex` and `claude` to `.cmd`
 * shims, which are executed through `cmd.exe`. A line break inside an argument
 * silently terminates that command line, so every later argument is dropped
 * without any error. Refuse to spawn instead of running a truncated command.
 */
export function findLineBreakArgument(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): number {
  if (platform !== 'win32') {
    return -1;
  }
  return args.findIndex((value) => /[\r\n]/.test(value));
}

class OutputCapture {
  private complete = '';
  private readonly enabled: boolean;
  private head = '';
  private readonly limit?: number;
  private tail = '';
  private wasTruncated = false;

  constructor(enabled: boolean, limit?: number) {
    this.enabled = enabled;
    this.limit = limit;
  }

  append(chunk: string): void {
    if (!this.enabled || !chunk) {
      return;
    }
    if (this.limit === undefined) {
      this.complete += chunk;
      return;
    }
    const retainedCharacters = Math.max(
      0,
      this.limit - TRUNCATION_MARKER.length,
    );
    const headLimit = Math.ceil(retainedCharacters / 2);
    const tailLimit = Math.floor(retainedCharacters / 2);
    if (!this.wasTruncated) {
      const combined = this.complete + chunk;
      if (combined.length <= this.limit) {
        this.complete = combined;
        return;
      }
      this.wasTruncated = true;
      this.head = combined.slice(0, headLimit);
      this.tail = tailLimit > 0 ? combined.slice(-tailLimit) : '';
      this.complete = '';
      return;
    }
    if (tailLimit > 0) {
      this.tail = `${this.tail}${chunk}`.slice(-tailLimit);
    }
  }

  get truncated(): boolean {
    return this.wasTruncated;
  }

  text(): string {
    return this.wasTruncated
      ? `${this.head}${TRUNCATION_MARKER}${this.tail}`
      : this.complete;
  }
}

export function runProcess(
  command: string,
  args: string[],
  {
    cwd,
    input = '',
    inheritStderr = false,
    allowedExitCodes = [0],
    acceptAnyExitCode = false,
    timeoutMs,
    signal,
    env = process.env,
    killGraceMs = 2_000,
    maxOutputChars,
    truncateOutputChars,
    captureStdout = true,
    onStdoutChunk,
  }: {
    cwd?: string;
    input?: string;
    inheritStderr?: boolean;
    allowedExitCodes?: number[];
    /**
     * Treat any ordinary exit as success and report its real code, instead of
     * enumerating the codes a command might use. Callers that must distinguish
     * a failing command from a broken one still get rejections for spawn
     * failures, timeouts, cancellation, and exceeded output budgets.
     */
    acceptAnyExitCode?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    killGraceMs?: number;
    maxOutputChars?: number;
    truncateOutputChars?: number;
    captureStdout?: boolean;
    onStdoutChunk?: (chunk: string) => void;
  } = {},
): Promise<ProcessResult> {
  return new Promise<ProcessResult>((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(new ProcessAbortError());
      return;
    }

    const lineBreakArgument = findLineBreakArgument(args);
    if (lineBreakArgument >= 0) {
      rejectPromise(
        new Error(
          `${command} argument ${lineBreakArgument + 1} contains a line break, ` +
            'which Windows command shims silently truncate. Pass the value on ' +
            'a single line, or supply it through standard input or a file.',
        ),
      );
      return;
    }

    const usesProcessGroup = process.platform !== 'win32';
    const child = spawn(command, args, {
      cwd,
      env,
      detached: usesProcessGroup,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutCapture = new OutputCapture(captureStdout, truncateOutputChars);
    const stderrCapture = new OutputCapture(true, truncateOutputChars);
    let stdoutCharacters = 0;
    let stderrCharacters = 0;
    let timedOut = false;
    let aborted = false;
    let exceededOutput: 'stdout' | 'stderr' | undefined;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let terminating = false;
    let stdoutCallbackError: Error | undefined;

    const kill = (processSignal: NodeJS.Signals): void => {
      if (!child.pid) {
        return;
      }
      try {
        if (usesProcessGroup) {
          process.kill(-child.pid, processSignal);
        } else if (processSignal === 'SIGKILL') {
          const treeKill = spawn(
            'taskkill',
            ['/pid', String(child.pid), '/t', '/f'],
            {
              shell: false,
              stdio: 'ignore',
              windowsHide: true,
            },
          );
          treeKill.once('error', () => {
            // taskkill is best-effort during cancellation.
          });
        } else {
          child.kill(processSignal);
        }
      } catch {
        // The process may have exited between the state check and the signal.
      }
    };
    const terminate = (): void => {
      if (terminating) {
        return;
      }
      terminating = true;
      if (!usesProcessGroup) {
        kill('SIGKILL');
        return;
      }
      kill('SIGTERM');
      forceKillTimer = setTimeout(() => kill('SIGKILL'), killGraceMs);
      forceKillTimer.unref();
    };
    const timeout =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            terminate();
          }, timeoutMs);
    timeout?.unref();
    const onAbort = (): void => {
      aborted = true;
      terminate();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = (): void => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      signal?.removeEventListener('abort', onAbort);
    };
    const rejectOnce = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      rejectPromise(error);
    };
    const resolveOnce = (result: ProcessResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolvePromise(result);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      let acceptedChunk = chunk;
      if (
        maxOutputChars !== undefined &&
        stdoutCharacters + chunk.length > maxOutputChars
      ) {
        acceptedChunk = chunk.slice(
          0,
          Math.max(0, maxOutputChars - stdoutCharacters),
        );
        stdoutCharacters += acceptedChunk.length;
        stdoutCapture.append(acceptedChunk);
        exceededOutput ??= 'stdout';
        terminate();
      } else {
        stdoutCharacters += chunk.length;
        stdoutCapture.append(chunk);
      }
      if (acceptedChunk && onStdoutChunk && !stdoutCallbackError) {
        try {
          onStdoutChunk(acceptedChunk);
        } catch (error) {
          stdoutCallbackError =
            error instanceof Error ? error : new Error(String(error));
          terminate();
        }
      }
    });
    child.stderr.on('data', (chunk: string) => {
      if (
        maxOutputChars !== undefined &&
        stderrCharacters + chunk.length > maxOutputChars
      ) {
        const acceptedChunk = chunk.slice(
          0,
          Math.max(0, maxOutputChars - stderrCharacters),
        );
        stderrCharacters += acceptedChunk.length;
        stderrCapture.append(acceptedChunk);
        exceededOutput ??= 'stderr';
        terminate();
      } else {
        stderrCharacters += chunk.length;
        stderrCapture.append(chunk);
      }
      if (inheritStderr) {
        process.stderr.write(chunk);
      }
    });
    child.on('error', (error) => {
      rejectOnce(error);
    });
    child.on('close', (code) => {
      if (terminating && usesProcessGroup) {
        // The direct child may exit before descendants that ignored SIGTERM.
        kill('SIGKILL');
      }
      if (aborted) {
        rejectOnce(new ProcessAbortError());
        return;
      }
      if (timedOut) {
        rejectOnce(
          new Error(`${command} timed out after ${timeoutMs} milliseconds`),
        );
        return;
      }
      if (exceededOutput) {
        rejectOnce(
          new Error(
            `${command} exceeded the ${maxOutputChars}-character ${exceededOutput} limit`,
          ),
        );
        return;
      }
      if (stdoutCallbackError) {
        rejectOnce(stdoutCallbackError);
        return;
      }
      const exitCode = code ?? -1;
      const stdout = stdoutCapture.text();
      const stderr = stderrCapture.text();
      if (!acceptAnyExitCode && !allowedExitCodes.includes(exitCode)) {
        rejectOnce(
          new Error(
            `${command} exited with ${exitCode}\n${
              stderr.trim() || stdout.trim()
            }`,
          ),
        );
        return;
      }

      resolveOnce({
        stdout,
        stderr,
        exitCode,
        stdoutTruncated: stdoutCapture.truncated,
        stderrTruncated: stderrCapture.truncated,
      });
    });

    child.stdin.on('error', () => {
      // EPIPE is expected when a subprocess exits before reading all input.
    });
    child.stdin.end(input);
  });
}
