import {
  describePairedExchangeStatus,
  formatDuration,
  type AgentName,
} from './core.ts';
import type { TerminalRenderer } from './presentation.ts';
import type {
  PresentedActivity,
  PresentedMessage,
  PresentedUsage,
  TerminalViewModel,
} from './presentation-model.ts';
import { sanitizeTerminalText } from './terminal-text.ts';

const ENTER_ALTERNATE_SCREEN = '\u001B[?1049h';
const LEAVE_ALTERNATE_SCREEN = '\u001B[?1049l';
const CLEAR_AND_HOME = '\u001B[2J\u001B[H';
const HOME = '\u001B[H';
const ERASE_DISPLAY_BELOW = '\u001B[J';
const STREAM_REDRAW_INTERVAL_MS = 50;
const ACTIVITY_FRAME_INTERVAL_MS = 250;
const ACTIVITY_FRAMES = ['⠋', '⠙', '⠹', '⠸'] as const;
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

function tailWindow(
  unsafeText: string,
  maximumCharacters: number,
): { text: string; truncated: boolean } {
  const text = sanitizeTerminalText(unsafeText);
  if (text.length <= maximumCharacters) {
    return { text, truncated: false };
  }

  let start = text.length - maximumCharacters;
  const first = text.charCodeAt(start);
  const previous = text.charCodeAt(start - 1);
  if (
    first >= 0xdc00 &&
    first <= 0xdfff &&
    previous >= 0xd800 &&
    previous <= 0xdbff
  ) {
    start -= 1;
  }
  return { text: text.slice(start), truncated: true };
}

function wrapTextTail(
  unsafeText: string,
  width: number,
  maxLines: number,
  alreadyTruncated = false,
): string[] {
  if (maxLines <= 0 || width <= 0) {
    return [];
  }

  // Bound the wrapping work independently of the provider's response size.
  const window = tailWindow(unsafeText, Math.max(256, width * maxLines * 4));
  const wrapped = wrapText(window.text, width, window.text.length + 1);
  const truncated =
    alreadyTruncated || window.truncated || wrapped.length > maxLines;
  const visible = wrapped.slice(-maxLines);
  if (truncated && visible.length > 0) {
    visible[0] = `…${clipLine(visible[0] ?? '', Math.max(0, width - 1))}`;
  }
  return visible;
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

function liveConversationLines(
  activity: PresentedActivity,
  width: number,
  maxLines: number,
): string[] {
  if (maxLines <= 0) {
    return [];
  }
  const label = `${agentLabel(activity.agent)} [Live]`;
  if (maxLines === 1) {
    const prefix = `${label}: `;
    const contentWidth = Math.max(1, width - printableWidth(prefix));
    const text =
      wrapTextTail(
        activity.liveText,
        contentWidth,
        1,
        activity.liveTextTruncated,
      )[0] ?? '';
    return [clipLine(`${prefix}${text}`, width)];
  }
  return [
    clipLine(label, width),
    ...wrapTextTail(
      activity.liveText,
      width,
      maxLines - 1,
      activity.liveTextTruncated,
    ),
  ];
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
  if (entries.length === 0 && !model.activity?.liveText) {
    return wrapText(
      'Type a message to discuss; files stay unchanged.\n' +
        'Make safe changes: /edit.\n' +
        'Advanced roles: /implement or /collaborate.',
      width,
      maxLines,
    );
  }

  const result = model.activity?.liveText
    ? liveConversationLines(model.activity, width, maxLines)
    : [];
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
  const lines = [
    activity.message ? `Current: ${activity.message}` : 'Preparing a response',
    activity.state === 'retrying'
      ? `Retrying ${activity.retryAttempt ?? '?'} of ${activity.retryLimit ?? '?'}`
      : activity.liveText
        ? 'Streaming response text'
        : 'Waiting for provider output',
  ];
  return wrapText(lines.join('\n'), width, maxLines);
}

function activityIndicator(activity: PresentedActivity): string {
  const elapsed = Math.max(0, activity.observedAt - activity.startedAt);
  const index = Math.floor(elapsed / ACTIVITY_FRAME_INTERVAL_MS);
  return ACTIVITY_FRAMES[index % ACTIVITY_FRAMES.length] ?? ACTIVITY_FRAMES[0];
}

function tokenCount(value: number): string {
  const count = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  if (count < 1_000) {
    return String(count);
  }
  const thousands = count / 1_000;
  return `${thousands >= 10 ? Math.round(thousands) : thousands.toFixed(1)}k`;
}

function usageSummary(usage: PresentedUsage | undefined): string | undefined {
  const parts = [
    usage?.inputTokens === undefined
      ? undefined
      : `in ${tokenCount(usage.inputTokens)}`,
    usage?.cachedInputTokens === undefined
      ? undefined
      : `cached ${tokenCount(usage.cachedInputTokens)}`,
    usage?.outputTokens === undefined
      ? undefined
      : `out ${tokenCount(usage.outputTokens)}`,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' / ') : undefined;
}

function statusLine(model: TerminalViewModel, width: number): string {
  const activity = model.activity;
  const exchange =
    model.exchangeStatus === 'none'
      ? undefined
      : `pair ${describePairedExchangeStatus(model.exchangeStatus)}`;
  const queued =
    model.queuedInputCount > 0 ? `${model.queuedInputCount} queued` : undefined;
  if (!activity) {
    const usage = usageSummary(model.lastUsage);
    return clipLine(
      `Ready · read-only chat${queued ? ` · ${queued}` : ''}${exchange ? ` · ${exchange}` : ''}${usage ? ` · last ${usage}` : ''} · /edit changes · /help commands`,
      width,
    );
  }
  const elapsed = formatDuration(
    Math.max(0, activity.observedAt - activity.startedAt),
  );
  const phase =
    activity.state === 'retrying'
      ? `retrying ${activity.retryAttempt ?? '?'}/${activity.retryLimit ?? '?'}`
      : activity.phase === 'confirmation'
        ? `reciprocal confirmation${activity.message ? ` · ${activity.message}` : ''}`
        : (activity.message ?? 'responding');
  const usage = usageSummary(activity.usage);
  return clipLine(
    `${activityIndicator(activity)} ${agentLabel(activity.agent)} · ${phase} · ${elapsed}` +
      `${usage ? ` · ${usage}` : ''}${queued ? ` · ${queued}` : ''}${exchange ? ` · ${exchange}` : ''} · ${activity.model ?? 'provider default'} · read-only`,
    width,
  );
}

function sessionHeading(model: TerminalViewModel): string {
  const id =
    model.session.id.length > 12
      ? `…${model.session.id.slice(-8)}`
      : model.session.id;
  const state = model.activity
    ? `${agentLabel(model.activity.agent)} ${
        model.activity.phase === 'confirmation' ? 'confirming' : 'responding'
      }`
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
    statusLine(model, width),
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
    statusLine(model, width),
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
    statusLine(model, width),
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

function renderEnhancedUpdate(
  model: TerminalViewModel,
  dimensions: TerminalDimensions,
): string {
  const frame = renderEnhancedFrame(model, dimensions).slice(
    CLEAR_AND_HOME.length,
  );
  return `${HOME}${frame}${ERASE_DISPLAY_BELOW}`;
}

export function createEnhancedTerminalRenderer({
  dimensions = () => ({
    columns: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  }),
  now = Date.now,
  streamRedrawIntervalMs = STREAM_REDRAW_INTERVAL_MS,
}: {
  dimensions?: () => TerminalDimensions;
  now?: () => number;
  streamRedrawIntervalMs?: number;
} = {}): TerminalRenderer {
  let started = false;
  let suspended = false;
  let lastStreamRedrawAt = Number.NEGATIVE_INFINITY;

  return {
    start(model): string {
      if (started) {
        return '';
      }
      started = true;
      suspended = false;
      lastStreamRedrawAt = Number.NEGATIVE_INFINITY;
      return `${ENTER_ALTERNATE_SCREEN}${renderEnhancedFrame(
        model,
        dimensions(),
      )}`;
    },
    render(event, model): string {
      if (!started || suspended) {
        return '';
      }
      if (
        event.type === 'provider-event' &&
        event.event.type === 'text-delta'
      ) {
        const observedAt = now();
        if (observedAt - lastStreamRedrawAt < streamRedrawIntervalMs) {
          return '';
        }
        lastStreamRedrawAt = observedAt;
      }
      return renderEnhancedUpdate(model, dimensions());
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
      lastStreamRedrawAt = Number.NEGATIVE_INFINITY;
      if (suspended) {
        suspended = false;
        return '';
      }
      return LEAVE_ALTERNATE_SCREEN;
    },
  };
}
