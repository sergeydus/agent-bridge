export const UI_MODES = ['plain', 'enhanced', 'auto'] as const;
export type UiMode = (typeof UI_MODES)[number];

export function isUiMode(value: unknown): value is UiMode {
  return UI_MODES.includes(value as UiMode);
}
export type ResolvedUiMode = 'plain' | 'enhanced';

export interface TerminalCapabilities {
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
  term?: string;
  columns: number;
  rows: number;
}

export interface UiModeResolution {
  mode: ResolvedUiMode;
  notice?: string;
}

export function detectTerminalCapabilities({
  input = process.stdin,
  output = process.stdout,
  environment = process.env,
}: {
  input?: { isTTY?: boolean };
  output?: { isTTY?: boolean; columns?: number; rows?: number };
  environment?: NodeJS.ProcessEnv;
} = {}): TerminalCapabilities {
  const columns =
    Number.isFinite(output.columns) && Number(output.columns) > 0
      ? Math.floor(Number(output.columns))
      : 80;
  const rows =
    Number.isFinite(output.rows) && Number(output.rows) > 0
      ? Math.floor(Number(output.rows))
      : 24;
  return {
    stdinIsTty: Boolean(input.isTTY),
    stdoutIsTty: Boolean(output.isTTY),
    term: environment.TERM,
    columns,
    rows,
  };
}

function unsupportedReason(
  capabilities: TerminalCapabilities,
): string | undefined {
  if (!capabilities.stdinIsTty || !capabilities.stdoutIsTty) {
    return 'Enhanced terminal unavailable because input and output must both be interactive';
  }
  if (capabilities.term?.trim().toLowerCase() === 'dumb') {
    return 'Enhanced terminal unavailable because TERM=dumb';
  }
  if (capabilities.columns < 20 || capabilities.rows < 8) {
    return 'Enhanced terminal unavailable because the terminal is smaller than 20 columns by 8 rows';
  }
  return undefined;
}

export function resolveUiMode(
  {
    requested,
    screenReader,
  }: {
    requested: UiMode;
    screenReader: boolean;
  },
  capabilities: TerminalCapabilities = detectTerminalCapabilities(),
): UiModeResolution {
  if (screenReader) {
    return {
      mode: 'plain',
      ...(requested === 'enhanced'
        ? {
            notice:
              'Screen-reader mode uses the semantic plain interface; ignoring --ui enhanced',
          }
        : {}),
    };
  }
  if (requested === 'plain') {
    return { mode: 'plain' };
  }
  const reason = unsupportedReason(capabilities);
  if (reason) {
    return {
      mode: 'plain',
      ...(requested === 'enhanced' ? { notice: reason } : {}),
    };
  }
  return { mode: 'enhanced' };
}
