import { formatDuration, type AgentDecision, type AgentName } from './core.ts';
import {
  MAX_PRESENTED_LIVE_TEXT_CHARS,
  reducePresentationModel,
  type PresentationModelEvent,
  type TerminalViewModel,
} from './presentation-model.ts';
import type { ProviderEvent } from './provider-events.ts';

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
  noColor: boolean;
}

export interface ProviderEventPresenter {
  render(event: ProviderEvent): string;
  beforeStatus(): string;
  finish(): string;
  reset(): string;
}

export interface TerminalRenderer {
  render(event: PresentationModelEvent, model: TerminalViewModel): string;
}

export class PresentationController {
  #model: TerminalViewModel;
  #renderer: TerminalRenderer;
  #write: (text: string) => void;

  constructor({
    initialModel,
    renderer,
    write,
  }: {
    initialModel: TerminalViewModel;
    renderer: TerminalRenderer;
    write: (text: string) => void;
  }) {
    this.#model = initialModel;
    this.#renderer = renderer;
    this.#write = write;
  }

  get model(): TerminalViewModel {
    return this.#model;
  }

  dispatch(event: PresentationModelEvent): void {
    this.#model = reducePresentationModel(this.#model, event);
    const output = this.#renderer.render(event, this.#model);
    if (output) {
      this.#write(output);
    }
  }
}

function hasNoColor(environment: NodeJS.ProcessEnv): boolean {
  return Object.hasOwn(environment, 'NO_COLOR');
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
  return {
    screenReader,
    color: isTty && !screenReader && !input.noColor && !hasNoColor(environment),
  };
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
    const remaining = MAX_LIVE_TEXT_CHARS - bufferedText.length;
    if (remaining > 0) {
      bufferedText += text.slice(0, remaining);
    }
    if (text.length > remaining) {
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
        return `${prefix}${
          preferences.screenReader
            ? `${agentLabel(agent)} status: ${event.message}.\n`
            : `  ${agentLabel(agent)} · ${event.message}\n`
        }`;
      }
      if (event.type === 'text-completed') {
        const prefix =
          preferences.screenReader || !streamText
            ? completeBufferedText()
            : closeLiveText();
        const text = event.text.slice(0, MAX_LIVE_TEXT_CHARS);
        if (!text) {
          return prefix;
        }
        const truncated = event.text.length > text.length;
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
        const remaining = MAX_LIVE_TEXT_CHARS - liveTextChars;
        const text = remaining > 0 ? event.text.slice(0, remaining) : '';
        liveTextChars += text.length;
        if (text.length < event.text.length) {
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
  return model ? `model ${model}` : 'provider default model';
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
  if (preferences.screenReader) {
    return `\n${agentLabel(agent)} response.${decisionText}\n${text}\n`;
  }
  const title = `${coloredAgentLabel(agent, preferences)}${
    decision ? ` [${decision}]` : ''
  }`;
  return `\n${title}\n${'─'.repeat(agentLabel(agent).length)}\n${text}\n`;
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
  };
}
