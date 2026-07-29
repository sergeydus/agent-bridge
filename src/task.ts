import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { ProjectKind } from './core.ts';
import type { BridgeOptions } from './options.ts';
import { runProcess } from './process.ts';
import { clip, MAX_CONTEXT_CHARS } from './prompts.ts';
import { workingTreeSnapshot, workingTreeStatus } from './snapshot.ts';

const MAX_TASK_BYTES = 1_000_000;
const MAX_TASK_CHARS = 200_000;

function validateTaskSize(task: string): string {
  const normalized = task.trim();
  if (normalized.length > MAX_TASK_CHARS) {
    throw new Error(
      `Task exceeds ${MAX_TASK_CHARS.toLocaleString()} characters. ` +
        'Put large supporting material in the selected project instead.',
    );
  }
  return normalized;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_TASK_BYTES) {
      throw new Error(
        `Piped task input exceeds ${MAX_TASK_BYTES.toLocaleString()} bytes.`,
      );
    }
    chunks.push(buffer);
  }
  return validateTaskSize(Buffer.concat(chunks).toString('utf8'));
}

export async function resolveTask(options: BridgeOptions): Promise<string> {
  if (options.task && options.taskFile) {
    throw new Error('Use either --task or --task-file, not both');
  }
  if (options.taskFile) {
    const path = isAbsolute(options.taskFile)
      ? options.taskFile
      : resolve(process.cwd(), options.taskFile);
    if ((await stat(path)).size > MAX_TASK_BYTES) {
      throw new Error(
        `Task file exceeds ${MAX_TASK_BYTES.toLocaleString()} bytes: ${path}`,
      );
    }
    return validateTaskSize(await readFile(path, 'utf8'));
  }
  if (options.task) {
    return validateTaskSize(options.task);
  }
  if (process.stdin.isTTY) {
    throw new Error('Provide --task, --task-file, or pipe task text to stdin');
  }
  return readStdin();
}

export async function appendGitDiff(
  task: string,
  options: BridgeOptions,
  projectKind: ProjectKind,
): Promise<string> {
  if (!options.gitDiff) {
    return task;
  }
  if (projectKind !== 'git') {
    throw new Error('--git-diff requires a Git repository');
  }
  if (options.gitDiff.startsWith('-')) {
    throw new Error('--git-diff cannot start with "-"');
  }

  let evidence: string;
  if (options.gitDiff === 'working-tree') {
    if (!(await workingTreeStatus(options))) {
      throw new Error('--git-diff produced no changes: working-tree');
    }
    evidence = await workingTreeSnapshot(options);
  } else if (options.gitDiff === 'last-commit') {
    const result = await runProcess(
      'git',
      ['show', '--format=', '--binary', '--no-ext-diff', 'HEAD'],
      { cwd: options.cwd },
    );
    evidence = result.stdout.trim();
  } else {
    const result = await runProcess(
      'git',
      ['diff', '--no-ext-diff', '--no-textconv', options.gitDiff],
      { cwd: options.cwd },
    );
    evidence = result.stdout.trim();
  }
  if (!evidence.trim()) {
    throw new Error(`--git-diff produced no changes: ${options.gitDiff}`);
  }

  if (evidence.length > MAX_CONTEXT_CHARS) {
    console.warn(
      `Review evidence is ${evidence.length.toLocaleString()} characters; ` +
        'the prompt preserves its beginning and end. Agents can inspect the project.',
    );
  }
  return `${task}

The following JSON string contains the authoritative diff for this review.
Base every diff-specific finding on it. The middle may be clipped, but agents
may inspect the selected project for omitted details.

Authoritative diff range: ${JSON.stringify(options.gitDiff)}
Authoritative diff: ${JSON.stringify(clip(evidence))}`;
}
