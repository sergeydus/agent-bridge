import type { VerificationCommand } from './project-config.ts';
import { ProcessAbortError, runProcess } from './process.ts';

const MAX_VERIFICATION_OUTPUT_CHARS = 40_000;

export interface VerificationResult {
  command: string;
  exitCode: number;
  output: string;
  passed: boolean;
}

function boundedOutput(value: string): string {
  if (value.length <= MAX_VERIFICATION_OUTPUT_CHARS) {
    return value;
  }
  const half = Math.floor(MAX_VERIFICATION_OUTPUT_CHARS / 2);
  return `${value.slice(0, half)}

...[verification output clipped]...

${value.slice(-half)}`;
}

export async function runVerificationCommands({
  commands,
  cwd,
  defaultTimeoutMs,
  signal,
}: {
  commands: VerificationCommand[];
  cwd: string;
  defaultTimeoutMs: number;
  signal?: AbortSignal;
}): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  for (const verification of commands) {
    const display = [verification.command, ...verification.args].join(' ');
    try {
      const result = await runProcess(verification.command, verification.args, {
        cwd,
        signal,
        timeoutMs:
          verification.timeoutMinutes === undefined
            ? defaultTimeoutMs
            : verification.timeoutMinutes * 60_000,
        maxOutputChars: 1_000_000,
      });
      results.push({
        command: display,
        exitCode: result.exitCode,
        output: boundedOutput(
          [result.stdout, result.stderr].filter(Boolean).join('\n').trim(),
        ),
        passed: true,
      });
    } catch (error) {
      if (error instanceof ProcessAbortError) {
        throw error;
      }
      results.push({
        command: display,
        exitCode: -1,
        output: boundedOutput(
          error instanceof Error ? error.message : String(error),
        ),
        passed: false,
      });
    }
  }
  return results;
}

export function formatVerificationResults(
  results: VerificationResult[],
): string {
  if (results.length === 0) {
    return 'No bridge-managed verification commands were configured.';
  }
  return results
    .map(
      (result) =>
        `${result.passed ? 'PASS' : 'FAIL'} ${result.command}\n${
          result.output || '[no output]'
        }`,
    )
    .join('\n\n');
}
