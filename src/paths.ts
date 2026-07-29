import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AppPaths {
  root: string;
  configFile: string;
  runsDirectory: string;
  stateDirectory: string;
  chatsDirectory: string;
}

interface PathEnvironment {
  [key: string]: string | undefined;
  AGENT_BRIDGE_HOME?: string;
  LOCALAPPDATA?: string;
  XDG_STATE_HOME?: string;
}

export function applicationDataRoot({
  env = process.env,
  platform = process.platform,
  home = homedir(),
}: {
  env?: PathEnvironment;
  platform?: NodeJS.Platform;
  home?: string;
} = {}): string {
  if (env.AGENT_BRIDGE_HOME) {
    return env.AGENT_BRIDGE_HOME;
  }

  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'Agent Bridge');
  }

  if (platform === 'win32') {
    return join(
      env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'),
      'Agent Bridge',
    );
  }

  return join(
    env.XDG_STATE_HOME ?? join(home, '.local', 'state'),
    'agent-bridge',
  );
}

export function getAppPaths(
  options: Parameters<typeof applicationDataRoot>[0] = {},
): AppPaths {
  const root = applicationDataRoot(options);
  const runsDirectory = join(root, 'runs');
  return {
    root,
    configFile: join(root, 'config.json'),
    runsDirectory,
    stateDirectory: join(runsDirectory, 'state'),
    chatsDirectory: join(root, 'chats'),
  };
}
