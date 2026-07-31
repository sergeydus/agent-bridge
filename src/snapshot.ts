import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { runProcess } from './process.ts';

const MAX_SNAPSHOT_SECTION_CHARS = 80_000;

export interface WorkingTreeStatusEntry {
  indexStatus: string;
  workingStatus: string;
  paths: string[];
}

export function parseNullTerminatedStatus(
  status: string,
): WorkingTreeStatusEntry[] {
  const records = status.split('\0');
  const entries: WorkingTreeStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) {
      continue;
    }
    const indexStatus = record[0] ?? ' ';
    const workingStatus = record[1] ?? ' ';
    const path = record.slice(3);
    const paths = path ? [path] : [];
    if (
      ['R', 'C'].includes(indexStatus) ||
      ['R', 'C'].includes(workingStatus)
    ) {
      const previousPath = records[index + 1];
      if (previousPath) {
        paths.push(previousPath);
        index += 1;
      }
    }
    entries.push({ indexStatus, workingStatus, paths });
  }
  return entries;
}

export async function workingTreePaths({
  cwd,
}: {
  cwd: string;
}): Promise<string[]> {
  const { stdout } = await runProcess(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd, maxOutputChars: 5_000_000 },
  );
  return [
    ...new Set(
      parseNullTerminatedStatus(stdout).flatMap((entry) => entry.paths),
    ),
  ];
}

export async function workingTreeStatus({
  cwd,
}: {
  cwd: string;
}): Promise<string> {
  const { stdout } = await runProcess(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd, truncateOutputChars: MAX_SNAPSHOT_SECTION_CHARS },
  );
  // Porcelain records begin with a two-character status field whose first
  // character is a space for unstaged-only changes. Trimming the start would
  // shift every field of the first record, reporting it as a staged change to
  // a path missing its first character.
  return stdout.trimEnd();
}

export async function workingTreeSnapshot({
  cwd,
}: {
  cwd: string;
}): Promise<string> {
  const [status, unstaged, staged, untrackedResult] = await Promise.all([
    workingTreeStatus({ cwd }),
    runProcess('git', ['diff', '--no-ext-diff', '--no-textconv'], {
      cwd,
      truncateOutputChars: MAX_SNAPSHOT_SECTION_CHARS,
    }).then((result) => result.stdout.trim()),
    runProcess('git', ['diff', '--cached', '--no-ext-diff', '--no-textconv'], {
      cwd,
      truncateOutputChars: MAX_SNAPSHOT_SECTION_CHARS,
    }).then((result) => result.stdout.trim()),
    runProcess('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd,
      maxOutputChars: 1_000_000,
    }),
  ]);

  const untrackedSections: string[] = [];
  const untrackedPaths = untrackedResult.stdout.split('\0').filter(Boolean);
  let untrackedCharacterCount = 0;

  for (const path of untrackedPaths) {
    const absolutePath = resolve(cwd, path);
    const isInsideWorkspace =
      absolutePath === cwd || absolutePath.startsWith(`${cwd}${sep}`);
    if (!isInsideWorkspace) {
      continue;
    }

    try {
      const details = await lstat(absolutePath);
      if (details.isSymbolicLink()) {
        untrackedSections.push(
          `--- untracked: ${path}\n[contents omitted: symbolic link]`,
        );
        continue;
      }
      if (details.size > 20_000) {
        untrackedSections.push(
          `--- untracked: ${path}\n[contents omitted: binary or too large]`,
        );
        continue;
      }

      const contents = await readFile(absolutePath);
      if (
        contents.length > 20_000 ||
        contents.includes(0) ||
        untrackedCharacterCount + contents.length > 40_000
      ) {
        untrackedSections.push(
          `--- untracked: ${path}\n[contents omitted: binary or too large]`,
        );
        continue;
      }

      const textContents = contents.toString('utf8');
      untrackedCharacterCount += textContents.length;
      untrackedSections.push(`--- untracked: ${path}\n${textContents}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      untrackedSections.push(
        `--- untracked: ${path}\n[unable to read: ${message}]`,
      );
    }
  }

  return [
    'STATUS',
    status || '[clean]',
    '',
    'UNSTAGED DIFF',
    unstaged || '[none]',
    '',
    'STAGED DIFF',
    staged || '[none]',
    '',
    'UNTRACKED FILES',
    untrackedSections.join('\n\n') || '[none]',
  ].join('\n');
}

export async function pathFingerprint({
  cwd,
  path,
}: {
  cwd: string;
  path: string;
}): Promise<string> {
  const absolutePath = resolve(cwd, path);
  if (
    absolutePath !== resolve(cwd) &&
    !absolutePath.startsWith(`${resolve(cwd)}${sep}`)
  ) {
    throw new Error(`Protected path escapes the project: ${path}`);
  }
  const hash = createHash('sha256');

  const visit = async (
    current: string,
    relativePath: string,
  ): Promise<void> => {
    let details;
    try {
      details = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        hash.update(`missing:${relativePath}\0`);
        return;
      }
      throw error;
    }
    hash.update(`${relativePath}\0${details.mode & 0o777}\0${details.size}\0`);
    if (details.isSymbolicLink()) {
      throw new Error(
        `Protected paths cannot contain symbolic links: ${relativePath}`,
      );
    }
    if (details.isDirectory()) {
      const names = (await readdir(current)).sort();
      for (const name of names) {
        await visit(join(current, name), join(relativePath, name));
      }
      return;
    }
    for await (const chunk of createReadStream(current)) {
      hash.update(chunk as Buffer);
    }
  };

  await visit(absolutePath, path);
  return hash.digest('hex');
}
