import { formatDuration, type AgentDecision, type AgentName } from './core.ts';

const ANSI_RESET = '\u001B[0m';
const ANSI_BOLD = '\u001B[1m';
const ANSI_CYAN = '\u001B[36m';
const ANSI_MAGENTA = '\u001B[35m';

export interface PresentationPreferences {
  screenReader: boolean;
  color: boolean;
}

export interface PresentationInput {
  screenReader: boolean;
  noColor: boolean;
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
