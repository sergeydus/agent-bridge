import { formatDuration, type AgentDecision, type AgentName } from './core.ts';
import {
  MAX_PRESENTED_LIVE_TEXT_CHARS,
  reducePresentationModel,
  type PresentationModelEvent,
  type TerminalViewModel,
} from './presentation-model.ts';
import type { ProviderEvent } from './provider-events.ts';
import { sanitizeTerminalText } from './terminal-text.ts';

const ANSI_RESET = '\u001B[0m';
const ANSI_BOLD = '\u001B[1m';
const ANSI_CYAN = '\u001B[36m';
const ANSI_MAGENTA = '\u001B[35m';
const MAX_LIVE_TEXT_CHARS = MAX_PRESENTED_LIVE_TEXT_CHARS;

export interface PresentationPreferences {
  screenReader: boolean;
  color: boolean;
}

export interface PresentationInput {
  screenReader: boolean;
  /** Resolved color choice, or `undefined` to defer to terminal detection. */
  color?: boolean;
}

export interface ProviderEventPresenter {
  render(event: ProviderEvent): string;
  beforeStatus(): string;
  finish(): string;
  reset(): string;
}

export interface TerminalRenderer {
  start(model: TerminalViewModel): string;
  render(event: PresentationModelEvent, model: TerminalViewModel): string;
  redraw(model: TerminalViewModel): string;
  suspend(): string;
  resume(model: TerminalViewModel): string;
  stop(): string;
}

export interface RendererFallback {
  renderer: TerminalRenderer;
  notice: string;
}

export class PresentationController {
  #model: TerminalViewModel;
  #renderer: TerminalRenderer;
  #fallback: RendererFallback | undefined;
  #usingFallback = false;
  #write: (text: string) => void;

  constructor({
    initialModel,
    renderer,
    fallback,
    write,
  }: {
    initialModel: TerminalViewModel;
    renderer: TerminalRenderer;
    fallback?: RendererFallback;
    write: (text: string) => void;
  }) {
    this.#model = initialModel;
    this.#renderer = renderer;
    this.#fallback = fallback;
    this.#write = write;
  }

  get model(): TerminalViewModel {
    return this.#model;
  }

  get usingFallback(): boolean {
    return this.#usingFallback;
  }

  start(): void {
    this.#renderWithFallback(
      (renderer) => renderer.start(this.#model),
      () => '',
    );
  }

  dispatch(event: PresentationModelEvent): void {
    this.#model = reducePresentationModel(this.#model, event);
    this.#renderWithFallback(
      (renderer) => renderer.render(event, this.#model),
      (renderer) => renderer.render(event, this.#model),
    );
  }

  redraw(): void {
    this.#renderWithFallback(
      (renderer) => renderer.redraw(this.#model),
      (renderer) => renderer.redraw(this.#model),
    );
  }

  suspend(): void {
    this.#renderWithFallback(
      (renderer) => renderer.suspend(),
      (renderer) => renderer.suspend(),
    );
  }

  resume(): void {
    this.#renderWithFallback(
      (renderer) => renderer.resume(this.#model),
      (renderer) => renderer.resume(this.#model),
    );
  }

  stop(): void {
    this.#emit(this.#renderer.stop());
  }

  #emit(output: string): void {
    if (output) {
      this.#write(output);
    }
  }

  #renderWithFallback(
    render: (renderer: TerminalRenderer) => string,
    renderAfterFallback: (renderer: TerminalRenderer) => string,
  ): void {
    let output: string;
    try {
      output = render(this.#renderer);
    } catch (error) {
      this.#activateFallback(error, renderAfterFallback);
      return;
    }
    this.#emit(output);
  }

  #activateFallback(
    renderError: unknown,
    renderAfterFallback: (renderer: TerminalRenderer) => string,
  ): void {
    const fallback = this.#fallback;
    if (!fallback) {
      throw renderError;
    }

    let restoration: string;
    try {
      restoration = this.#renderer.stop();
    } catch (restorationError) {
      throw new AggregateError(
        [renderError, restorationError],
        'Enhanced terminal rendering failed and normal terminal state could not be restored',
        { cause: restorationError },
      );
    }

    this.#renderer = fallback.renderer;
    this.#fallback = undefined;
    this.#usingFallback = true;

    // Writes are deliberately outside the renderer try/catch. A broken output
    // stream cannot be repaired by changing renderers and must stay fatal.
    this.#emit(restoration);
    this.#emit(fallback.notice);
    this.#emit(this.#renderer.start(this.#model));
    this.#emit(renderAfterFallback(this.#renderer));
  }
}

function hasNoColor(environment: NodeJS.ProcessEnv): boolean {
  return Object.hasOwn(environment, 'NO_COLOR');
}

/**
 * Applies the color precedence chain, most specific first:
 *
 * 1. an explicit `--color` or `--no-color` on this command line;
 * 2. the presentation saved with the chat being resumed;
 * 3. the global preference stored by the wizard;
 * 4. automatic detection, when no layer above expressed a choice.
 *
 * Each argument is "is color wanted", so `undefined` means that layer is
 * silent. Returning `undefined` hands the decision to automatic detection.
 */
export function resolveColorChoice({
  explicit,
  savedSession,
  savedGlobal,
}: {
  explicit?: boolean;
  savedSession?: boolean;
  savedGlobal?: boolean;
}): boolean | undefined {
  return explicit ?? savedSession ?? savedGlobal;
}

export function resolvePresentation(
  input: PresentationInput,
  {
    environment = process.env,
    isTty = Boolean(process.stdout.isTTY),
  }: {
    environment?: NodeJS.ProcessEnv;
    isTty?: boolean;
  } = {},
): PresentationPreferences {
  const screenReader = input.screenReader;
  if (screenReader) {
    return { screenReader, color: false };
  }
  // A stated choice outranks NO_COLOR, which is itself automatic detection.
  // Nothing outranks the terminal check: escape sequences written into a pipe
  // corrupt output that something else is meant to read.
  if (input.color !== undefined) {
    return { screenReader, color: input.color && isTty };
  }
  return { screenReader, color: isTty && !hasNoColor(environment) };
}

export function agentLabel(agent: AgentName): string {
  return agent === 'codex' ? 'Codex' : 'Claude';
}

function coloredAgentLabel(
  agent: AgentName,
  preferences: PresentationPreferences,
): string {
  const label = agentLabel(agent);
  if (!preferences.color) {
    return label;
  }
  const color = agent === 'codex' ? ANSI_CYAN : ANSI_MAGENTA;
  return `${ANSI_BOLD}${color}${label}${ANSI_RESET}`;
}

function progressHeading(
  agent: AgentName,
  preferences: PresentationPreferences,
): string {
  return preferences.screenReader
    ? `${agentLabel(agent)} progress update.\n`
    : `${coloredAgentLabel(agent, preferences)} · live update\n`;
}

export function createProviderEventPresenter({
  agent,
  preferences,
  streamText,
}: {
  agent: AgentName;
  preferences: PresentationPreferences;
  streamText: boolean;
}): ProviderEventPresenter {
  let bufferedText = '';
  let liveTextOpen = false;
  let liveTextChars = 0;
  let liveTextTruncated = false;

  const appendBuffered = (text: string): void => {
    const safeText = sanitizeTerminalText(text);
    const remaining = MAX_LIVE_TEXT_CHARS - bufferedText.length;
    if (remaining > 0) {
      bufferedText += safeText.slice(0, remaining);
    }
    if (safeText.length > remaining) {
      liveTextTruncated = true;
    }
  };
  const truncationNotice = (): string =>
    liveTextTruncated
      ? preferences.screenReader
        ? 'Live update truncated.\n'
        : '  …live update truncated\n'
      : '';
  const completeBufferedText = (): string => {
    if (!bufferedText && !liveTextTruncated) {
      return '';
    }
    const text = bufferedText;
    bufferedText = '';
    const notice = truncationNotice();
    liveTextTruncated = false;
    return `\n${progressHeading(agent, preferences)}${text}${
      text.endsWith('\n') ? '' : '\n'
    }${notice}`;
  };
  const closeLiveText = (): string => {
    if (!liveTextOpen) {
      return '';
    }
    liveTextOpen = false;
    const notice = truncationNotice();
    liveTextChars = 0;
    liveTextTruncated = false;
    return `\n${notice}`;
  };

  return {
    render(event): string {
      if (event.type === 'usage') {
        return '';
      }
      if (event.type === 'activity') {
        const prefix = closeLiveText();
        const message = sanitizeTerminalText(event.message);
        return `${prefix}${
          preferences.screenReader
            ? `${agentLabel(agent)} status: ${message}.\n`
            : `  ${agentLabel(agent)} · ${message}\n`
        }`;
      }
      if (event.type === 'text-completed') {
        const prefix =
          preferences.screenReader || !streamText
            ? completeBufferedText()
            : closeLiveText();
        const safeEventText = sanitizeTerminalText(event.text);
        const text = safeEventText.slice(0, MAX_LIVE_TEXT_CHARS);
        if (!text) {
          return prefix;
        }
        const truncated = safeEventText.length > text.length;
        return `${prefix}\n${progressHeading(agent, preferences)}${text}${
          text.endsWith('\n') ? '' : '\n'
        }${
          truncated
            ? preferences.screenReader
              ? 'Live update truncated.\n'
              : '  …live update truncated\n'
            : ''
        }`;
      }
      if (event.type === 'text-delta') {
        if (preferences.screenReader || !streamText) {
          appendBuffered(event.text);
          return '';
        }
        const safeEventText = sanitizeTerminalText(event.text);
        const remaining = MAX_LIVE_TEXT_CHARS - liveTextChars;
        const text = remaining > 0 ? safeEventText.slice(0, remaining) : '';
        liveTextChars += text.length;
        if (text.length < safeEventText.length) {
          liveTextTruncated = true;
        }
        if (!liveTextOpen) {
          liveTextOpen = true;
          return `\n${progressHeading(agent, preferences)}${text}`;
        }
        return text;
      }
      if (preferences.screenReader || !streamText) {
        return completeBufferedText();
      }
      return closeLiveText();
    },
    beforeStatus(): string {
      return preferences.screenReader || !streamText ? '' : closeLiveText();
    },
    finish(): string {
      return preferences.screenReader || !streamText
        ? completeBufferedText()
        : closeLiveText();
    },
    reset(): string {
      bufferedText = '';
      liveTextTruncated = false;
      liveTextChars = 0;
      if (!liveTextOpen) {
        return '';
      }
      liveTextOpen = false;
      return '\n';
    },
  };
}

function modelLabel(model?: string): string {
  return model
    ? `model ${sanitizeTerminalText(model)}`
    : 'provider default model';
}

export function formatAgentStarted({
  agent,
  model,
  preferences,
}: {
  agent: AgentName;
  model?: string;
  preferences: PresentationPreferences;
}): string {
  if (preferences.screenReader) {
    return `\n${agentLabel(agent)} started a read-only response using the ${modelLabel(
      model,
    )}.\n`;
  }
  return `\n${coloredAgentLabel(agent, preferences)} · ${modelLabel(
    model,
  )} · thinking…\n`;
}

export function formatAgentHeartbeat({
  agent,
  startedAt,
  now = Date.now(),
  preferences,
}: {
  agent: AgentName;
  startedAt: number;
  now?: number;
  preferences: PresentationPreferences;
}): string {
  const elapsed = formatDuration(Math.max(0, now - startedAt));
  return preferences.screenReader
    ? `${agentLabel(agent)} is still working. Elapsed time: ${elapsed}.\n`
    : `  ${agentLabel(agent)} is still working · ${elapsed}\n`;
}

export function formatAgentResponse({
  agent,
  decision,
  text,
  preferences,
}: {
  agent: AgentName;
  decision?: AgentDecision;
  text: string;
  preferences: PresentationPreferences;
}): string {
  const decisionText = decision ? ` Decision: ${decision}.` : '';
  const safeText = sanitizeTerminalText(text);
  if (preferences.screenReader) {
    return `\n${agentLabel(agent)} response.${decisionText}\n${safeText}\n`;
  }
  const title = `${coloredAgentLabel(agent, preferences)}${
    decision ? ` [${decision}]` : ''
  }`;
  return `\n${title}\n${'─'.repeat(agentLabel(agent).length)}\n${safeText}\n`;
}

export function createPlainTerminalRenderer(
  preferences: PresentationPreferences,
): TerminalRenderer {
  let active:
    | {
        agent: AgentName;
        presenter: ProviderEventPresenter;
      }
    | undefined;

  const presenterFor = (
    agent: AgentName,
  ): ProviderEventPresenter | undefined =>
    active?.agent === agent ? active.presenter : undefined;

  return {
    start(model): string {
      active = model.activity
        ? {
            agent: model.activity.agent,
            presenter: createProviderEventPresenter({
              agent: model.activity.agent,
              preferences,
              streamText: !preferences.screenReader,
            }),
          }
        : undefined;
      return '';
    },
    render(event, model): string {
      if (event.type === 'agent-started') {
        active = {
          agent: event.agent,
          presenter: createProviderEventPresenter({
            agent: event.agent,
            preferences,
            streamText: !preferences.screenReader,
          }),
        };
        return formatAgentStarted({
          agent: event.agent,
          model: event.model,
          preferences,
        });
      }
      if (event.type === 'provider-event') {
        return presenterFor(event.agent)?.render(event.event) ?? '';
      }
      if (event.type === 'agent-heartbeat') {
        const prefix = presenterFor(event.agent)?.beforeStatus() ?? '';
        return `${prefix}${formatAgentHeartbeat({
          agent: event.agent,
          startedAt: model.activity?.startedAt ?? event.now,
          now: event.now,
          preferences,
        })}`;
      }
      if (event.type === 'agent-tick') {
        return '';
      }
      if (event.type === 'agent-retry') {
        const prefix = presenterFor(event.agent)?.reset() ?? '';
        return `${prefix}  Temporary ${agentLabel(
          event.agent,
        )} failure; retrying (${event.attempt}/${event.retryLimit})…\n`;
      }
      if (event.type === 'agent-stream-finished') {
        return presenterFor(event.agent)?.finish() ?? '';
      }
      if (event.type === 'agent-failed') {
        const output = presenterFor(event.agent)?.reset() ?? '';
        if (active?.agent === event.agent) {
          active = undefined;
        }
        return output;
      }
      if (event.type === 'agent-response') {
        if (active?.agent === event.agent) {
          active = undefined;
        }
        return formatAgentResponse({
          agent: event.agent,
          decision: event.message.decision,
          text: event.message.text,
          preferences,
        });
      }
      return '';
    },
    redraw(): string {
      return '';
    },
    suspend(): string {
      return '';
    },
    resume(): string {
      return '';
    },
    stop(): string {
      return '';
    },
  };
}
