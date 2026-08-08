import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { writePrivateFileAtomic } from './filesystem.ts';
import type { UiMode } from './terminal-capabilities.ts';

const MAX_RECENT_PROJECTS = 8;

export interface PresentationPreferences {
  screenReader: boolean;
  /**
   * `true` chose color, `false` chose no color, `undefined` made no choice and
   * defers to automatic detection.
   */
  color?: boolean;
  ui: UiMode;
}

export interface UserConfig {
  version: 3;
  recentProjects: string[];
  presentation?: PresentationPreferences;
}

const EMPTY_CONFIG: UserConfig = {
  version: 3,
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
      ['screenReader', 'color', 'ui'].includes(key),
    ) &&
    typeof candidate.screenReader === 'boolean' &&
    (candidate.color === undefined || typeof candidate.color === 'boolean') &&
    ['plain', 'enhanced', 'auto'].includes(String(candidate.ui))
  );
}

/**
 * The CLI that stored `noColor` had no positive `--color`, so a stored `false`
 * only meant nothing was chosen and must not become an explicit color-on that
 * would then outrank `NO_COLOR`. See `migratedColorChoice` in `chat-state.ts`.
 */
function migratePresentation(
  value: unknown,
): PresentationPreferences | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as {
    screenReader?: unknown;
    noColor?: unknown;
    ui?: unknown;
  };
  if (
    !Object.keys(value).every((key) =>
      ['screenReader', 'noColor', 'ui'].includes(key),
    ) ||
    typeof candidate.screenReader !== 'boolean' ||
    typeof candidate.noColor !== 'boolean' ||
    !['plain', 'enhanced', 'auto'].includes(String(candidate.ui))
  ) {
    return undefined;
  }
  return {
    screenReader: candidate.screenReader,
    ...(candidate.noColor === true ? { color: false } : {}),
    ui: candidate.ui as UiMode,
  };
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
    return { version: 3, recentProjects: candidate.recentProjects };
  }
  if (
    !Object.keys(value).every((key) =>
      ['version', 'recentProjects', 'presentation'].includes(key),
    )
  ) {
    return undefined;
  }
  if (candidate.version === 2) {
    const presentation =
      candidate.presentation === undefined
        ? undefined
        : migratePresentation(candidate.presentation);
    if (candidate.presentation !== undefined && !presentation) {
      return undefined;
    }
    return {
      version: 3,
      recentProjects: candidate.recentProjects,
      ...(presentation ? { presentation } : {}),
    };
  }
  if (
    candidate.version !== 3 ||
    (candidate.presentation !== undefined &&
      !isPresentationPreferences(candidate.presentation))
  ) {
    return undefined;
  }
  return {
    version: 3,
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
      version: 3,
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
      version: 3,
      presentation,
    };
    await this.save(updated);
    return updated;
  }
}
