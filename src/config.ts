import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const MAX_RECENT_PROJECTS = 8;

export interface UserConfig {
  version: 1;
  recentProjects: string[];
}

const EMPTY_CONFIG: UserConfig = {
  version: 1,
  recentProjects: [],
};

function emptyConfig(): UserConfig {
  return { version: EMPTY_CONFIG.version, recentProjects: [] };
}

function isUserConfig(value: unknown): value is UserConfig {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<UserConfig>;
  return (
    !Array.isArray(value) &&
    Object.keys(value).every((key) =>
      ['version', 'recentProjects'].includes(key),
    ) &&
    candidate.version === 1 &&
    Array.isArray(candidate.recentProjects) &&
    candidate.recentProjects.length <= MAX_RECENT_PROJECTS &&
    new Set(candidate.recentProjects).size ===
      candidate.recentProjects.length &&
    candidate.recentProjects.every(
      (project) => typeof project === 'string' && Boolean(project.trim()),
    )
  );
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
      return isUserConfig(parsed) ? parsed : emptyConfig();
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
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.#path);
  }

  async rememberProject(project: string): Promise<UserConfig> {
    const canonical = resolve(project);
    const current = await this.load();
    const recentProjects = [
      canonical,
      ...current.recentProjects.filter((item) => resolve(item) !== canonical),
    ].slice(0, MAX_RECENT_PROJECTS);
    const updated: UserConfig = { version: 1, recentProjects };
    await this.save(updated);
    return updated;
  }
}
