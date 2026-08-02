import type { AgentDecision, AgentName } from './core.ts';
import type { ProviderEvent } from './provider-events.ts';

export const MAX_PRESENTED_MESSAGES = 500;
export const MAX_PRESENTED_LIVE_TEXT_CHARS = 50_000;

export type PresentedRole = 'user' | 'codex' | 'claude' | 'system';
export type PresentedSessionStatus = 'active' | 'paused' | 'completed';

export interface PresentedMessage {
  readonly sequence: number;
  readonly createdAt: string;
  readonly role: PresentedRole;
  readonly text: string;
  readonly decision?: AgentDecision;
}

export interface PresentedSession {
  readonly id: string;
  readonly projectLabel: string;
  readonly status: PresentedSessionStatus;
}

export interface PresentedUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
}

export interface PresentedActivity {
  readonly agent: AgentName;
  readonly model?: string;
  readonly startedAt: number;
  readonly observedAt: number;
  readonly state: 'working' | 'retrying';
  readonly message?: string;
  readonly liveText: string;
  readonly liveTextComplete: boolean;
  readonly liveTextTruncated: boolean;
  readonly retryAttempt?: number;
  readonly retryLimit?: number;
  readonly usage?: PresentedUsage;
}

export interface TerminalViewModel {
  readonly session: PresentedSession;
  readonly messages: readonly PresentedMessage[];
  readonly activity?: PresentedActivity;
  readonly lastUsage?: PresentedUsage;
}

export type PresentationModelEvent =
  | {
      type: 'session-status';
      status: PresentedSessionStatus;
    }
  | {
      type: 'message-added';
      message: PresentedMessage;
    }
  | {
      type: 'agent-started';
      agent: AgentName;
      model?: string;
      startedAt: number;
    }
  | {
      type: 'provider-event';
      agent: AgentName;
      event: ProviderEvent;
    }
  | {
      type: 'agent-heartbeat';
      agent: AgentName;
      now: number;
    }
  | {
      type: 'agent-tick';
      agent: AgentName;
      now: number;
    }
  | {
      type: 'agent-retry';
      agent: AgentName;
      attempt: number;
      retryLimit: number;
    }
  | {
      type: 'agent-stream-finished';
      agent: AgentName;
    }
  | {
      type: 'agent-failed';
      agent: AgentName;
    }
  | {
      type: 'agent-response';
      agent: AgentName;
      message: PresentedMessage;
    };

function boundedMessages(
  messages: readonly PresentedMessage[],
): readonly PresentedMessage[] {
  return messages.slice(-MAX_PRESENTED_MESSAGES);
}

function addMessage(
  messages: readonly PresentedMessage[],
  message: PresentedMessage,
): readonly PresentedMessage[] {
  const existing = messages.findIndex(
    (candidate) => candidate.sequence === message.sequence,
  );
  if (existing < 0) {
    return boundedMessages([...messages, message]);
  }
  const next = [...messages];
  next[existing] = message;
  return boundedMessages(next);
}

function boundedLiveText(
  text: string,
): Pick<PresentedActivity, 'liveText' | 'liveTextTruncated'> {
  const truncated = text.length > MAX_PRESENTED_LIVE_TEXT_CHARS;
  return {
    liveText: truncated ? text.slice(-MAX_PRESENTED_LIVE_TEXT_CHARS) : text,
    liveTextTruncated: truncated,
  };
}

function updateActivity(
  model: TerminalViewModel,
  agent: AgentName,
  update: (activity: PresentedActivity) => PresentedActivity,
): TerminalViewModel {
  if (!model.activity || model.activity.agent !== agent) {
    return model;
  }
  return { ...model, activity: update(model.activity) };
}

export function createTerminalViewModel({
  session,
  messages,
}: {
  session: PresentedSession;
  messages: readonly PresentedMessage[];
}): TerminalViewModel {
  return {
    session: { ...session },
    messages: boundedMessages(messages),
  };
}

export function reducePresentationModel(
  model: TerminalViewModel,
  event: PresentationModelEvent,
): TerminalViewModel {
  if (event.type === 'session-status') {
    return {
      ...model,
      session: { ...model.session, status: event.status },
    };
  }
  if (event.type === 'message-added') {
    return {
      ...model,
      messages: addMessage(model.messages, event.message),
    };
  }
  if (event.type === 'agent-started') {
    return {
      ...model,
      activity: {
        agent: event.agent,
        model: event.model,
        startedAt: event.startedAt,
        observedAt: event.startedAt,
        state: 'working',
        liveText: '',
        liveTextComplete: false,
        liveTextTruncated: false,
      },
    };
  }
  if (event.type === 'provider-event') {
    return updateActivity(model, event.agent, (activity) => {
      const providerEvent = event.event;
      const working = { ...activity, state: 'working' as const };
      if (providerEvent.type === 'activity') {
        return { ...working, message: providerEvent.message };
      }
      if (providerEvent.type === 'text-delta') {
        const live = boundedLiveText(activity.liveText + providerEvent.text);
        return {
          ...working,
          ...live,
          liveTextTruncated:
            activity.liveTextTruncated || live.liveTextTruncated,
          liveTextComplete: false,
        };
      }
      if (providerEvent.type === 'text-completed') {
        return {
          ...working,
          ...boundedLiveText(providerEvent.text),
          liveTextComplete: true,
        };
      }
      if (providerEvent.type === 'text-end') {
        return { ...working, liveTextComplete: true };
      }
      if (providerEvent.type === 'usage') {
        return {
          ...working,
          usage: {
            inputTokens: providerEvent.inputTokens,
            cachedInputTokens: providerEvent.cachedInputTokens,
            outputTokens: providerEvent.outputTokens,
          },
        };
      }
      providerEvent satisfies never;
      return working;
    });
  }
  if (event.type === 'agent-heartbeat' || event.type === 'agent-tick') {
    return updateActivity(model, event.agent, (activity) => ({
      ...activity,
      // A renderer derives elapsed time from these two values. Keeping the
      // observation in the model also makes deterministic rendering possible.
      observedAt: Math.max(activity.startedAt, event.now),
    }));
  }
  if (event.type === 'agent-retry') {
    return updateActivity(model, event.agent, (activity) => ({
      ...activity,
      state: 'retrying',
      message: undefined,
      liveText: '',
      liveTextComplete: false,
      liveTextTruncated: false,
      retryAttempt: event.attempt,
      retryLimit: event.retryLimit,
    }));
  }
  if (event.type === 'agent-stream-finished') {
    return updateActivity(model, event.agent, (activity) => ({
      ...activity,
      state: 'working',
      liveTextComplete: true,
    }));
  }
  if (event.type === 'agent-failed') {
    return model.activity?.agent === event.agent
      ? { ...model, activity: undefined }
      : model;
  }
  if (event.type === 'agent-response') {
    const completedActivity =
      model.activity?.agent === event.agent ? model.activity : undefined;
    return {
      ...model,
      messages: addMessage(model.messages, event.message),
      activity: completedActivity ? undefined : model.activity,
      lastUsage: completedActivity?.usage ?? model.lastUsage,
    };
  }
  event satisfies never;
  return model;
}
