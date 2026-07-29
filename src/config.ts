import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { writePrivateFileAtomic } from './filesystem.ts';
import type { UiMode } from './terminal-capabilities.ts';

const MAX_RECENT_PROJECTS = 8;

export interface PresentationPreferences {
  screenReader: boolean;
  noColor: boolean;
  ui: UiMode;
}

export interface UserConfig {
  version: 2;
  recentProjects: string[];
  presentation?: PresentationPreferences;
}

const EMPTY_CONFIG: UserConfig = {
  version: 2,
  recentProjects: [],
};

function emptyConfig(): UserConfig {
  return { version: EMPTY_CONFIG.version, recentProjects: [] };
}

function isPresentationPreferences(
  value: unknown,
): value is PresentationPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<PresentationPreferences>;
  return (
    Object.keys(value).every((key) =>
      ['screenReader', 'noColor', 'ui'].includes(key),
    ) &&
    typeof candidate.screenReader === 'boolean' &&
    typeof candidate.noColor === 'boolean' &&
    ['plain', 'enhanced', 'auto'].includes(String(candidate.ui))
  );
}

function isRecentProjects(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_RECENT_PROJECTS &&
    new Set(value).size === value.length &&
    value.every(
      (project) => typeof project === 'string' && Boolean(project.trim()),
    )
  );
}

function parseUserConfig(value: unknown): UserConfig | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const candidate = value as {
    version?: unknown;
    recentProjects?: unknown;
    presentation?: unknown;
  };
  if (Array.isArray(value) || !isRecentProjects(candidate.recentProjects)) {
    return undefined;
  }
  if (
    candidate.version === 1 &&
    Object.keys(value).every((key) =>
      ['version', 'recentProjects'].includes(key),
    )
  ) {
    return { version: 2, recentProjects: candidate.recentProjects };
  }
  if (
    candidate.version !== 2 ||
    !Object.keys(value).every((key) =>
      ['version', 'recentProjects', 'presentation'].includes(key),
    ) ||
    (candidate.presentation !== undefined &&
      !isPresentationPreferences(candidate.presentation))
  ) {
    return undefined;
  }
  return {
    version: 2,
    recentProjects: candidate.recentProjects,
    ...(candidate.presentation ? { presentation: candidate.presentation } : {}),
  };
}

export class UserConfigStore {
  #path: string;
  #onWarning: (message: string) => void;

  constructor(path: string, onWarning: (message: string) => void = () => {}) {
    this.#path = path;
    this.#onWarning = onWarning;
  }

  async load(): Promise<UserConfig> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, 'utf8'));
      return parseUserConfig(parsed) ?? emptyConfig();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.#onWarning(
          `Ignoring invalid user configuration at ${this.#path}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return emptyConfig();
    }
  }

  async save(config: UserConfig): Promise<void> {
    await writePrivateFileAtomic(
      this.#path,
      `${JSON.stringify(config, null, 2)}\n`,
    );
  }

  async rememberProject(project: string): Promise<UserConfig> {
    const canonical = resolve(project);
    const current = await this.load();
    const recentProjects = [
      canonical,
      ...current.recentProjects.filter((item) => resolve(item) !== canonical),
    ].slice(0, MAX_RECENT_PROJECTS);
    const updated: UserConfig = {
      ...current,
      version: 2,
      recentProjects,
    };
    await this.save(updated);
    return updated;
  }

  async rememberPresentation(
    presentation: PresentationPreferences,
  ): Promise<UserConfig> {
    const current = await this.load();
    const updated: UserConfig = {
      ...current,
      version: 2,
      presentation,
    };
    await this.save(updated);
    return updated;
  }
}
