import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseArgs } from '../src/options.ts';
import { appendGitDiff, resolveTask } from '../src/task.ts';

test('loads task text and rejects conflicting or oversized input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-task-'));
  try {
    const taskFile = join(directory, 'task.md');
    await writeFile(taskFile, '  Review this carefully.  ');
    const defaults = {
      initialCwd: directory,
      defaultOutput: join(directory, 'runs'),
    };

    assert.equal(
      await resolveTask(parseArgs(['--task-file', taskFile], defaults)),
      'Review this carefully.',
    );
    await assert.rejects(
      () =>
        resolveTask(
          parseArgs(['--task', 'inline', '--task-file', taskFile], defaults),
        ),
      /either --task or --task-file/,
    );
    await assert.rejects(
      () => resolveTask(parseArgs(['--task', 'x'.repeat(200_001)], defaults)),
      /exceeds 200,000 characters/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects Git diff evidence for an ordinary directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-task-'));
  try {
    const options = parseArgs(['--git-diff', 'working-tree'], {
      initialCwd: directory,
      defaultOutput: join(directory, 'runs'),
    });
    await assert.rejects(
      () => appendGitDiff('Review', options, 'directory'),
      /requires a Git repository/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
