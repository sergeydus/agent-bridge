import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { execute } from '../src/git.ts';
import {
  parseNullTerminatedStatus,
  pathFingerprint,
  workingTreePaths,
  workingTreeSnapshot,
} from '../src/snapshot.ts';

test(
  'captures ordinary untracked files without following untracked symlinks',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-bridge-snapshot-'));
    const repository = join(root, 'repository');
    const secret = join(root, 'outside-secret.txt');
    try {
      await execute('git', ['init', repository], { cwd: root });
      await writeFile(join(repository, 'ordinary.txt'), 'ordinary contents\n');
      await writeFile(secret, 'must-not-leak\n');
      await symlink(secret, join(repository, 'external-link.txt'));

      const snapshot = await workingTreeSnapshot({ cwd: repository });
      assert.match(snapshot, /ordinary contents/);
      assert.match(
        snapshot,
        /external-link\.txt\n\[contents omitted: symbolic link\]/,
      );
      assert.doesNotMatch(snapshot, /must-not-leak/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('parses machine-readable status paths including both sides of a rename', () => {
  assert.deepEqual(
    parseNullTerminatedStatus(
      'R  new file.txt\0old file.txt\0?? another file.txt\0',
    ),
    [
      {
        indexStatus: 'R',
        workingStatus: ' ',
        paths: ['new file.txt', 'old file.txt'],
      },
      {
        indexStatus: '?',
        workingStatus: '?',
        paths: ['another file.txt'],
      },
    ],
  );
});

test('returns literal dirty paths without porcelain quoting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-status-paths-'));
  try {
    await execute('git', ['init'], { cwd: root });
    await execute('git', ['config', 'user.name', 'Agent Bridge Tests'], {
      cwd: root,
    });
    await execute('git', ['config', 'user.email', 'tests@example.invalid'], {
      cwd: root,
    });
    await writeFile(join(root, 'old file.txt'), 'tracked');
    await execute('git', ['add', 'old file.txt'], { cwd: root });
    await execute('git', ['commit', '-m', 'initial'], { cwd: root });
    await execute('git', ['mv', 'old file.txt', 'new file.txt'], { cwd: root });
    await writeFile(join(root, 'another file.txt'), 'untracked');

    assert.deepEqual(
      new Set(await workingTreePaths({ cwd: root })),
      new Set(['new file.txt', 'old file.txt', 'another file.txt']),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'fingerprints protected files and rejects escapes through symlinks',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-bridge-fingerprint-'));
    try {
      await writeFile(join(root, 'protected.txt'), 'before');
      const before = await pathFingerprint({
        cwd: root,
        path: 'protected.txt',
      });
      await writeFile(join(root, 'protected.txt'), 'after');
      const after = await pathFingerprint({
        cwd: root,
        path: 'protected.txt',
      });
      assert.notEqual(before, after);
      await assert.rejects(
        () => pathFingerprint({ cwd: root, path: '../escape' }),
        /escapes the project/,
      );
      await symlink('../outside', join(root, 'protected-link'));
      await assert.rejects(
        () => pathFingerprint({ cwd: root, path: 'protected-link' }),
        /cannot contain symbolic links/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
