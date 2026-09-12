import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, win32 } from 'node:path';

import { hasOnlyKeys, isRecord, isStringArray } from './validation.ts';

export interface VerificationCommand {
  command: string;
  args: string[];
  timeoutMinutes?: number;
}

export interface ProjectConfig {
  $schema?: string;
  version: 1;
  verification: VerificationCommand[];
  protectedPaths: string[];
}

const MAX_VERIFICATION_COMMANDS = 50;
const MAX_COMMAND_ARGUMENTS = 100;
const MAX_PROTECTED_PATHS = 100;

const EMPTY_PROJECT_CONFIG: ProjectConfig = {
  version: 1,
  verification: [],
  protectedPaths: [],
};

export function isSafeProtectedPath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    value.includes('\0') ||
    isAbsolute(value) ||
    win32.isAbsolute(value)
  ) {
    return false;
  }
  const segments = value.replaceAll('\\', '/').split('/');
  return segments.every(
    (segment) => Boolean(segment) && segment !== '.' && segment !== '..',
  );
}

export function isVerificationCommand(
  value: unknown,
): value is VerificationCommand {
  if (!isRecord(value)) {
    return false;
  }
  if (!hasOnlyKeys(value, ['command', 'args', 'timeoutMinutes'])) {
    return false;
  }
  const candidate = value as Partial<VerificationCommand>;
  return (
    typeof candidate.command === 'string' &&
    Boolean(candidate.command.trim()) &&
    candidate.command === candidate.command.trim() &&
    !candidate.command.includes('/') &&
    !candidate.command.includes('\\') &&
    !/\s/u.test(candidate.command) &&
    isStringArray(candidate.args) &&
    candidate.args.length <= MAX_COMMAND_ARGUMENTS &&
    (candidate.timeoutMinutes === undefined ||
      (Number.isInteger(candidate.timeoutMinutes) &&
        candidate.timeoutMinutes >= 1 &&
        candidate.timeoutMinutes <= 180))
  );
}

export function isProjectConfig(value: unknown): value is ProjectConfig {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !hasOnlyKeys(value, [
      '$schema',
      'version',
      'verification',
      'protectedPaths',
    ])
  ) {
    return false;
  }
  const candidate = value as Partial<ProjectConfig>;
  return (
    (candidate.$schema === undefined ||
      (typeof candidate.$schema === 'string' &&
        Boolean(candidate.$schema.trim()))) &&
    candidate.version === 1 &&
    Array.isArray(candidate.verification) &&
    candidate.verification.length <= MAX_VERIFICATION_COMMANDS &&
    candidate.verification.every(isVerificationCommand) &&
    isStringArray(candidate.protectedPaths) &&
    candidate.protectedPaths.length <= MAX_PROTECTED_PATHS &&
    new Set(candidate.protectedPaths).size ===
      candidate.protectedPaths.length &&
    candidate.protectedPaths.every(isSafeProtectedPath)
  );
}

export async function loadProjectConfig({
  projectRoot,
  configPath,
}: {
  projectRoot: string;
  configPath?: string;
}): Promise<{ config: ProjectConfig; path?: string }> {
  const path = configPath
    ? isAbsolute(configPath)
      ? configPath
      : resolve(process.cwd(), configPath)
    : join(projectRoot, '.agent-bridge.json');
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!isProjectConfig(parsed)) {
      throw new Error(`Invalid Agent Bridge project configuration: ${path}`);
    }
    return { config: parsed, path };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!configPath && code === 'ENOENT') {
      return {
        config: {
          ...EMPTY_PROJECT_CONFIG,
          verification: [],
          protectedPaths: [],
        },
      };
    }
    throw error;
  }
}
