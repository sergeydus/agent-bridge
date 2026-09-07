import type { AgentDecision } from './core.ts';
import { hasOnlyKeys, isRecord } from './validation.ts';

export type ResponseKind = 'turn' | 'synthesis';

export interface AgentResponse {
  text: string;
  decision?: AgentDecision;
}

export const TURN_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    decision: {
      type: 'string',
      enum: ['done', 'continue'],
      description:
        'done only when no actionable work or unresolved disagreement remains',
    },
    text: {
      type: 'string',
      minLength: 1,
      description:
        'The complete human-readable analysis or implementation report',
    },
  },
  required: ['decision', 'text'],
} as const;

export const SYNTHESIS_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: {
      type: 'string',
      minLength: 1,
      description: 'The complete final result for the user in Markdown',
    },
  },
  required: ['text'],
} as const;

export function schemaFor(kind: ResponseKind): object {
  return kind === 'turn' ? TURN_RESPONSE_SCHEMA : SYNTHESIS_RESPONSE_SCHEMA;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function unwrapProviderOutput(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  if (isRecord(value.structured_output)) {
    return value.structured_output;
  }
  if (typeof value.result === 'string') {
    return parseJson(value.result) ?? value.result;
  }
  return value;
}

export function parseProviderResponse(
  raw: string,
  kind: ResponseKind,
): AgentResponse {
  const parsed = unwrapProviderOutput(parseJson(raw) ?? raw);
  if (
    isRecord(parsed) &&
    typeof parsed.text === 'string' &&
    parsed.text.trim()
  ) {
    if (kind === 'synthesis' && hasOnlyKeys(parsed, ['text'])) {
      return { text: parsed.text.trim() };
    }
    if (
      hasOnlyKeys(parsed, ['decision', 'text']) &&
      (parsed.decision === 'done' || parsed.decision === 'continue')
    ) {
      return {
        text: parsed.text.trim(),
        decision: parsed.decision,
      };
    }
  }

  throw new Error(
    `Agent returned an invalid ${kind} response. ` +
      'Run agent-bridge --doctor to verify structured-output support.',
  );
}
