import { formatDuration, type AgentName } from './core.ts';
import type { TerminalRenderer } from './presentation.ts';
import type {
  PresentedActivity,
  PresentedMessage,
  TerminalViewModel,
} from './presentation-model.ts';
import { sanitizeTerminalText } from './terminal-text.ts';

const ENTER_ALTERNATE_SCREEN = '\u001B[?1049h';
const LEAVE_ALTERNATE_SCREEN = '\u001B[?1049l';
const CLEAR_AND_HOME = '\u001B[2J\u001B[H';
const GRAPHEME_SEGMENTER = new Intl.Segmenter('en', {
  granularity: 'grapheme',
});

export interface TerminalDimensions {
  columns: number;
  rows: number;
}

function isWideSymbol(symbol: string, codePoint: number): boolean {
  return (
    /\p{Extended_Pictographic}/u.test(symbol) ||
    (codePoint >= 0x1100 &&
      (codePoint <= 0x115f ||
        codePoint === 0x2329 ||
        codePoint === 0x232a ||
        (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
        (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
        (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
        (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
        (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
        (codePoint >= 0xff00 && codePoint <= 0xff60) ||
        (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
        (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
        (codePoint >= 0x20000 && codePoint <= 0x3fffd)))
  );
}

function graphemes(text: string): string[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(text), (part) => part.segment);
}

function symbolWidth(symbol: string): number {
  if (/\p{Extended_Pictographic}/u.test(symbol) || symbol.includes('\u20E3')) {
    return 2;
  }
  let width = 0;
  for (const character of symbol) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint === 0x200c ||
      codePoint === 0x200d ||
      (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
      /\p{Mark}/u.test(character)
    ) {
      continue;
    }
    width += isWideSymbol(character, codePoint) ? 2 : 1;
  }
  return width;
}

export function printableWidth(text: string): number {
  return graphemes(text).reduce(
    (width, symbol) => width + symbolWidth(symbol),
    0,
  );
}

export { sanitizeTerminalText };

function clipLine(text: string, width: number): string {
  let result = '';
  let currentWidth = 0;
  for (const symbol of graphemes(sanitizeTerminalText(text))) {
    const nextWidth = symbolWidth(symbol);
    if (currentWidth + nextWidth > width) {
      break;
    }
    result += symbol;
    currentWidth += nextWidth;
  }
  return result;
}

function fitLine(text: string, width: number): string {
  const clipped = clipLine(text, width);
  return `${clipped}${' '.repeat(Math.max(0, width - printableWidth(clipped)))}`;
}

function wrapText(
  unsafeText: string,
  width: number,
  maxLines: number,
): string[] {
  if (maxLines <= 0 || width <= 0) {
    return [];
  }
  const paragraphs = sanitizeTerminalText(unsafeText).split('\n');
  const lines: string[] = [];
  let truncated = false;

  outer: for (
    let paragraphIndex = 0;
    paragraphIndex < paragraphs.length;
    paragraphIndex += 1
  ) {
    const paragraph = paragraphs[paragraphIndex] ?? '';
    let line = '';
    let lineWidth = 0;
    for (const symbol of graphemes(paragraph)) {
      const nextWidth = symbolWidth(symbol);
      if (lineWidth + nextWidth > width) {
        if (line) {
          lines.push(line);
          if (lines.length >= maxLines) {
            truncated = true;
            break outer;
          }
          line = '';
          lineWidth = 0;
        }
        if (nextWidth > width) {
          truncated = true;
          continue;
        }
      }
      line += symbol;
      lineWidth += nextWidth;
    }
    lines.push(line);
    if (lines.length >= maxLines) {
      truncated = paragraphIndex < paragraphs.length - 1 || lineWidth > width;
      break;
    }
  }

  if (truncated && lines.length > 0) {
    const index = lines.length - 1;
    lines[index] = `${clipLine(lines[index] ?? '', Math.max(1, width - 1))}…`;
  }
  return lines.slice(0, maxLines);
}

function agentLabel(agent: AgentName): string {
  return agent === 'codex' ? 'Codex' : 'Claude';
}

function messageLabel(message: PresentedMessage): string {
  const speaker = {
    user: 'You',
    codex: 'Codex',
    claude: 'Claude',
    system: 'Agent Bridge',
  }[message.role];
  return `${speaker}${message.decision ? ` [${message.decision}]` : ''}`;
}

function conversationLines(
  model: TerminalViewModel,
  width: number,
  maxLines: number,
): string[] {
  const entries: Array<{ label: string; text: string }> = model.messages.map(
    (message) => ({
      label: messageLabel(message),
      text: message.text,
    }),
  );
  if (model.activity?.liveText) {
    entries.push({
      label: `${agentLabel(model.activity.agent)} [Live]`,
      text: model.activity.liveText,
    });
  }
  if (entries.length === 0) {
    return wrapText(
      'Type a message to discuss; files stay unchanged.\n' +
        'Make safe changes: /edit.\n' +
        'Advanced roles: /implement or /collaborate.',
      width,
      maxLines,
    );
  }

  const result: string[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) {
      continue;
    }
    const available = maxLines - result.length;
    if (available <= 0) {
      break;
    }
    const wrapped = wrapText(`${entry.label}: ${entry.text}`, width, available);
    result.unshift(...wrapped);
  }
  return result.slice(-maxLines);
}

function activityLines(
  activity: PresentedActivity | undefined,
  width: number,
  maxLines: number,
): string[] {
  if (!activity) {
    return wrapText('Ready · read-only chat', width, maxLines);
  }
  const elapsed = formatDuration(
    Math.max(0, activity.observedAt - activity.startedAt),
  );
  const lines = [
    `${agentLabel(activity.agent)} · ${
      activity.model ?? 'provider default'
    } · ${activity.state} · ${elapsed}`,
    activity.message ? `Activity: ${activity.message}` : 'Response in progress',
  ];
  return wrapText(lines.join('\n'), width, maxLines);
}

function sessionHeading(model: TerminalViewModel): string {
  const id =
    model.session.id.length > 12
      ? `…${model.session.id.slice(-8)}`
      : model.session.id;
  const state = model.activity
    ? `${agentLabel(model.activity.agent)} responding`
    : model.session.status === 'active'
      ? 'Ready'
      : model.session.status;
  return `Agent Bridge · ${model.session.projectLabel} · ${id} · ${state}`;
}

function compactFrame(
  model: TerminalViewModel,
  width: number,
  rows: number,
): string[] {
  const conversationRows = Math.max(1, rows - 4);
  return [
    clipLine(sessionHeading(model), width),
    ...conversationLines(model, width, conversationRows),
    ...activityLines(model.activity, width, 1),
    clipLine(
      'Input · discuss normally · safe changes: /edit · help: /help',
      width,
    ),
  ].slice(0, rows - 1);
}

function stackedFrame(
  model: TerminalViewModel,
  width: number,
  rows: number,
): string[] {
  const divider = '─'.repeat(width);
  const conversationRows = Math.max(1, rows - 10);
  return [
    fitLine(sessionHeading(model), width),
    divider,
    'Conversation',
    ...conversationLines(model, width, conversationRows),
    divider,
    'Activity',
    ...activityLines(model.activity, width, 2),
    divider,
    clipLine(
      'Input · discuss normally · safe changes with /edit · help: /help',
      width,
    ),
  ].slice(0, rows - 1);
}

function wideFrame(
  model: TerminalViewModel,
  width: number,
  rows: number,
): string[] {
  const leftWidth = Math.max(40, Math.floor(width * 0.68));
  const rightWidth = width - leftWidth - 3;
  const bodyRows = Math.max(1, rows - 5);
  const left = [
    'Conversation',
    ...conversationLines(model, leftWidth, bodyRows - 1),
  ].slice(0, bodyRows);
  const right = [
    'Activity',
    ...activityLines(model.activity, rightWidth, bodyRows - 1),
  ].slice(0, bodyRows);
  const body = Array.from({ length: bodyRows }, (_, index) => {
    return `${fitLine(left[index] ?? '', leftWidth)} │ ${fitLine(
      right[index] ?? '',
      rightWidth,
    )}`;
  });
  return [
    fitLine(sessionHeading(model), width),
    '─'.repeat(width),
    ...body,
    '─'.repeat(width),
    clipLine(
      'Input · discuss normally · safe changes with /edit · help: /help',
      width,
    ),
  ].slice(0, rows - 1);
}

export function renderEnhancedFrame(
  model: TerminalViewModel,
  dimensions: TerminalDimensions,
): string {
  const width =
    Number.isFinite(dimensions.columns) && dimensions.columns > 0
      ? Math.max(1, Math.floor(dimensions.columns))
      : 80;
  const rows =
    Number.isFinite(dimensions.rows) && dimensions.rows > 0
      ? Math.max(2, Math.floor(dimensions.rows))
      : 24;
  const lines =
    width < 60 || rows < 12
      ? compactFrame(model, width, rows)
      : width < 100
        ? stackedFrame(model, width, rows)
        : wideFrame(model, width, rows);
  return `${CLEAR_AND_HOME}${lines.join('\n')}\n`;
}

export function createEnhancedTerminalRenderer({
  dimensions = () => ({
    columns: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  }),
}: {
  dimensions?: () => TerminalDimensions;
} = {}): TerminalRenderer {
  let started = false;
  let suspended = false;

  return {
    start(model): string {
      if (started) {
        return '';
      }
      started = true;
      suspended = false;
      return `${ENTER_ALTERNATE_SCREEN}${renderEnhancedFrame(
        model,
        dimensions(),
      )}`;
    },
    render(event, model): string {
      if (
        event.type === 'provider-event' &&
        event.event.type === 'text-delta'
      ) {
        return '';
      }
      return started && !suspended
        ? renderEnhancedFrame(model, dimensions())
        : '';
    },
    redraw(model): string {
      return started && !suspended
        ? renderEnhancedFrame(model, dimensions())
        : '';
    },
    suspend(): string {
      if (!started || suspended) {
        return '';
      }
      suspended = true;
      return LEAVE_ALTERNATE_SCREEN;
    },
    resume(model): string {
      if (!started || !suspended) {
        return '';
      }
      suspended = false;
      return `${ENTER_ALTERNATE_SCREEN}${renderEnhancedFrame(
        model,
        dimensions(),
      )}`;
    },
    stop(): string {
      if (!started) {
        return '';
      }
      started = false;
      if (suspended) {
        suspended = false;
        return '';
      }
      return LEAVE_ALTERNATE_SCREEN;
    },
  };
}
