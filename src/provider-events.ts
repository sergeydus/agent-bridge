import type { ResponseKind } from './response.ts';
import { parseProviderResponse, type AgentResponse } from './response.ts';

const MAX_JSONL_LINE_CHARS = 2_000_000;

export type ProviderEvent =
  | { type: 'activity'; message: string }
  | { type: 'text-delta'; text: string }
  | { type: 'text-end' }
  | { type: 'text-completed'; text: string }
  | {
      type: 'usage';
      inputTokens?: number;
      cachedInputTokens?: number;
      outputTokens?: number;
    };

export type ProviderEventSink = (event: ProviderEvent) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonLine(line: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error('Provider emitted malformed JSONL output.');
  }
  if (!isRecord(value)) {
    throw new Error('Provider emitted a non-object JSONL event.');
  }
  return value;
}

class JsonLineDecoder {
  #buffer = '';
  #error: Error | undefined;
  readonly #onLine: (line: string) => void;

  constructor(onLine: (line: string) => void) {
    this.#onLine = onLine;
  }

  push(chunk: string): void {
    if (this.#error) {
      throw this.#error;
    }
    this.#buffer += chunk;
    while (true) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) {
        this.#enforceLineLimit(this.#buffer.length);
        return;
      }
      this.#enforceLineLimit(newline);
      const line = this.#buffer.slice(0, newline).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#dispatch(line);
      if (this.#error) {
        throw this.#error;
      }
    }
  }

  finish(): void {
    if (this.#buffer.trim()) {
      this.#enforceLineLimit(this.#buffer.length);
      this.#dispatch(this.#buffer.replace(/\r$/, ''));
    }
    this.#buffer = '';
    if (this.#error) {
      throw this.#error;
    }
  }

  #dispatch(line: string): void {
    if (!line.trim() || this.#error) {
      return;
    }
    try {
      this.#onLine(line);
    } catch (error) {
      this.#error = error instanceof Error ? error : new Error(String(error));
    }
  }

  #enforceLineLimit(length: number): void {
    if (length <= MAX_JSONL_LINE_CHARS) {
      return;
    }
    this.#error = new Error(
      `Provider JSONL event exceeded ${MAX_JSONL_LINE_CHARS} characters.`,
    );
    throw this.#error;
  }
}

function numberField(
  value: Record<string, unknown>,
  key: string,
): number | undefined {
  return typeof value[key] === 'number' ? value[key] : undefined;
}

function usageEvent(value: unknown): ProviderEvent | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    type: 'usage',
    inputTokens: numberField(value, 'input_tokens'),
    cachedInputTokens:
      numberField(value, 'cached_input_tokens') ??
      numberField(value, 'cache_read_input_tokens'),
    outputTokens: numberField(value, 'output_tokens'),
  };
}

function progressText(raw: string, kind: ResponseKind): string {
  try {
    return parseProviderResponse(raw, kind).text;
  } catch {
    return raw.trim();
  }
}

function codexActivity(
  eventType: string,
  itemType: string,
  item: Record<string, unknown>,
): string | undefined {
  const starting = eventType === 'item.started';
  if (itemType === 'command_execution') {
    if (starting) {
      return 'running a project command';
    }
    if (eventType === 'item.completed') {
      return item.status === 'failed'
        ? 'finished a project command with an error'
        : 'finished a project command';
    }
    return undefined;
  }
  if (itemType === 'file_change' && eventType === 'item.completed') {
    return item.status === 'failed'
      ? 'could not apply a project file update'
      : 'updated project files';
  }
  if (itemType === 'mcp_tool_call' || itemType === 'collab_tool_call') {
    if (starting) {
      return 'using an external tool';
    }
    return eventType === 'item.completed'
      ? 'finished using an external tool'
      : undefined;
  }
  if (itemType === 'web_search') {
    if (starting) {
      return 'searching the web';
    }
    return eventType === 'item.completed'
      ? 'finished searching the web'
      : undefined;
  }
  if (itemType === 'todo_list') {
    return starting ? 'updating its plan' : undefined;
  }
  if (itemType === 'error' && eventType === 'item.completed') {
    return 'reported a non-fatal provider warning';
  }
  return undefined;
}

export class CodexEventStream {
  readonly #decoder: JsonLineDecoder;
  readonly #kind: ResponseKind;
  readonly #sink: ProviderEventSink;
  #pendingAgentMessage: string | undefined;
  #fatalError: string | undefined;

  constructor(kind: ResponseKind, sink: ProviderEventSink = () => {}) {
    this.#kind = kind;
    this.#sink = sink;
    this.#decoder = new JsonLineDecoder((line) =>
      this.#handle(parseJsonLine(line)),
    );
  }

  push(chunk: string): void {
    this.#decoder.push(chunk);
  }

  finish(): void {
    this.#decoder.finish();
    if (this.#fatalError) {
      throw new Error(`Codex stream failed: ${this.#fatalError}`);
    }
    // The last agent message is the schema-constrained final response. The
    // output-last-message file remains authoritative and is parsed separately.
    this.#pendingAgentMessage = undefined;
  }

  #handle(event: Record<string, unknown>): void {
    const eventType = typeof event.type === 'string' ? event.type : '';
    if (eventType === 'error') {
      this.#fatalError =
        typeof event.message === 'string'
          ? event.message
          : 'unrecoverable provider error';
      return;
    }
    if (eventType === 'turn.failed') {
      const error = isRecord(event.error) ? event.error : undefined;
      this.#fatalError =
        error && typeof error.message === 'string'
          ? error.message
          : 'turn failed';
      return;
    }
    if (eventType === 'turn.completed') {
      const usage = usageEvent(event.usage);
      if (usage) {
        this.#sink(usage);
      }
      return;
    }
    if (
      eventType !== 'item.started' &&
      eventType !== 'item.updated' &&
      eventType !== 'item.completed'
    ) {
      return;
    }
    const item = isRecord(event.item) ? event.item : undefined;
    const itemType = item && typeof item.type === 'string' ? item.type : '';
    if (!item || !itemType || itemType === 'reasoning') {
      return;
    }
    if (
      eventType === 'item.completed' &&
      itemType === 'agent_message' &&
      typeof item.text === 'string'
    ) {
      if (this.#pendingAgentMessage) {
        this.#sink({
          type: 'text-completed',
          text: progressText(this.#pendingAgentMessage, this.#kind),
        });
      }
      this.#pendingAgentMessage = item.text;
      return;
    }
    const message = codexActivity(eventType, itemType, item);
    if (message) {
      this.#sink({ type: 'activity', message });
    }
  }
}

function claudeToolActivity(name: string): string | undefined {
  const normalized = name.toLowerCase();
  if (normalized === 'structuredoutput') {
    return undefined;
  }
  if (normalized === 'read') {
    return 'reading project files';
  }
  if (normalized === 'glob' || normalized === 'grep') {
    return 'searching the project';
  }
  if (normalized === 'edit' || normalized === 'write') {
    return 'updating project files';
  }
  return 'using a project tool';
}

function textFromClaudeMessage(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    return '';
  }
  return value.content
    .filter(
      (block): block is Record<string, unknown> =>
        isRecord(block) &&
        block.type === 'text' &&
        typeof block.text === 'string',
    )
    .map((block) => String(block.text))
    .join('');
}

export class ClaudeEventStream {
  readonly #decoder: JsonLineDecoder;
  readonly #kind: ResponseKind;
  readonly #sink: ProviderEventSink;
  #fatalError: string | undefined;
  #result: string | undefined;
  #currentMessageHasTextDeltas = false;
  #streamedMessageAwaitingAssistant = false;
  #pendingAssistantText: string | undefined;

  constructor(kind: ResponseKind, sink: ProviderEventSink = () => {}) {
    this.#kind = kind;
    this.#sink = sink;
    this.#decoder = new JsonLineDecoder((line) =>
      this.#handle(parseJsonLine(line)),
    );
  }

  push(chunk: string): void {
    this.#decoder.push(chunk);
  }

  finish(): AgentResponse {
    this.#decoder.finish();
    if (this.#fatalError) {
      throw new Error(`Claude stream failed: ${this.#fatalError}`);
    }
    if (!this.#result) {
      throw new Error('Claude stream ended without a final result event.');
    }
    return parseProviderResponse(this.#result, this.#kind);
  }

  #handle(event: Record<string, unknown>): void {
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'stream_event') {
      this.#handleStreamEvent(isRecord(event.event) ? event.event : undefined);
      return;
    }
    if (type === 'assistant') {
      if (this.#streamedMessageAwaitingAssistant) {
        this.#streamedMessageAwaitingAssistant = false;
        return;
      }
      // With partial messages enabled, Claude can emit a complete assistant
      // snapshot before message_stop. Its text is already represented by the
      // preceding deltas and must not be repeated as a completed update.
      if (this.#currentMessageHasTextDeltas) {
        return;
      }
      const text = textFromClaudeMessage(event.message);
      if (text) {
        this.#flushPendingAssistantText();
        this.#pendingAssistantText = text;
      }
      return;
    }
    if (type === 'result') {
      if (event.subtype !== 'success') {
        this.#fatalError =
          typeof event.subtype === 'string'
            ? event.subtype
            : 'result reported failure';
        return;
      }
      const usage = usageEvent(event.usage);
      if (usage) {
        this.#sink(usage);
      }
      // A trailing assistant message can contain the same answer represented
      // by structured_output. Keep the validated result as the sole final
      // response instead of printing that text twice.
      this.#pendingAssistantText = undefined;
      this.#result = JSON.stringify(event);
    }
  }

  #handleStreamEvent(event: Record<string, unknown> | undefined): void {
    if (!event || typeof event.type !== 'string') {
      return;
    }
    if (event.type === 'message_start') {
      this.#flushPendingAssistantText();
      this.#currentMessageHasTextDeltas = false;
      return;
    }
    if (event.type === 'content_block_start') {
      this.#flushPendingAssistantText();
      const block = isRecord(event.content_block)
        ? event.content_block
        : undefined;
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        const message = claudeToolActivity(block.name);
        if (message) {
          this.#sink({ type: 'activity', message });
        }
      }
      return;
    }
    if (event.type === 'content_block_delta') {
      this.#flushPendingAssistantText();
      const delta = isRecord(event.delta) ? event.delta : undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        this.#currentMessageHasTextDeltas = true;
        this.#sink({ type: 'text-delta', text: delta.text });
      }
      return;
    }
    if (event.type === 'message_stop' && this.#currentMessageHasTextDeltas) {
      this.#sink({ type: 'text-end' });
      this.#currentMessageHasTextDeltas = false;
      this.#streamedMessageAwaitingAssistant = true;
    }
  }

  #flushPendingAssistantText(): void {
    if (!this.#pendingAssistantText) {
      return;
    }
    this.#sink({
      type: 'text-completed',
      text: this.#pendingAssistantText,
    });
    this.#pendingAssistantText = undefined;
  }
}
