import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { repositoryRoot } from './git.ts';
import type { ProjectKind } from './core.ts';

export interface SelectedProject {
  root: string;
  kind: ProjectKind;
}

export function cleanProjectPathInput(input: string): string {
  let value = input.trim();
  const matchingQuotes =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  if (matchingQuotes) {
    value = value.slice(1, -1);
  }

  // Terminal drag-and-drop commonly escapes spaces without adding quotes.
  return value.replaceAll('\\ ', ' ');
}

async function canonicalizePotentialPath(path: string): Promise<string> {
  let existing = resolve(path);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return join(await realpath(existing), ...missingSegments);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      const parent = dirname(existing);
      if (parent === existing) {
        throw error;
      }
      missingSegments.unshift(basename(existing));
      existing = parent;
    }
  }
}

export async function isPathInside(
  parent: string,
  child: string,
): Promise<boolean> {
  const [canonicalParent, canonicalChild] = await Promise.all([
    canonicalizePotentialPath(parent),
    canonicalizePotentialPath(child),
  ]);
  const path = relative(canonicalParent, canonicalChild);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..');
}

export async function resolveProject(input: string): Promise<SelectedProject> {
  const cleaned = cleanProjectPathInput(input);
  if (!cleaned) {
    throw new Error('Project folder cannot be empty.');
  }

  const directory = resolve(cleaned);
  let details;
  try {
    details = await stat(directory);
  } catch {
    throw new Error(`Project folder does not exist: ${directory}`);
  }

  if (!details.isDirectory()) {
    throw new Error(`Project path is not a directory: ${directory}`);
  }

  try {
    return {
      root: await repositoryRoot(directory),
      kind: 'git',
    };
  } catch {
    return {
      root: directory,
      kind: 'directory',
    };
  }
}
