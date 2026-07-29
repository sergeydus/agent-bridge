import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyPatch,
  canApplyPatch,
  createIsolatedWorktree,
  createPatch,
  execute,
  removeIsolatedWorktree,
} from '../src/git.ts';

test('isolates edits and exports tracked and untracked files as a patch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-git-'));
  const repository = join(root, 'repository');
  const runsDirectory = join(repository, '.agent-runs');
  const patchPath = join(root, 'result.patch');

  try {
    await execute('git', ['init', repository], { cwd: root });
    await execute('git', ['config', 'user.name', 'Agent Bridge Test'], {
      cwd: repository,
    });
    await execute('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repository,
    });
    await execute('git', ['config', 'core.autocrlf', 'false'], {
      cwd: repository,
    });
    await writeFile(join(repository, 'tracked.txt'), 'before\n');
    await writeFile(join(repository, 'deleted.txt'), 'delete me\n');
    await execute('git', ['add', 'tracked.txt', 'deleted.txt'], {
      cwd: repository,
    });
    await execute('git', ['commit', '-m', 'initial'], { cwd: repository });

    const workspace = await createIsolatedWorktree({
      repository,
      runsDirectory,
      runId: 'test-run',
    });
    await writeFile(join(workspace, 'tracked.txt'), 'after\n');
    await writeFile(join(workspace, 'new.txt'), 'new file\n');
    await writeFile(
      join(workspace, 'new binary file.bin'),
      Buffer.from([0, 1, 2, 255]),
    );
    await unlink(join(workspace, 'deleted.txt'));
    if (process.platform !== 'win32') {
      await writeFile(join(workspace, 'executable.sh'), '#!/bin/sh\nexit 0\n');
      await chmod(join(workspace, 'executable.sh'), 0o755);
      await symlink('tracked.txt', join(workspace, 'tracked-link'));
    }

    const patch = await createPatch({
      workspace,
      destination: patchPath,
    });
    assert.match(patch, /tracked\.txt/);
    assert.match(patch, /new\.txt/);
    assert.match(patch, /new binary file\.bin/);
    assert.match(patch, /deleted\.txt/);
    assert.equal(await canApplyPatch({ repository, patchPath }), true);

    await applyPatch({ repository, patchPath });
    assert.equal(
      await readFile(join(repository, 'tracked.txt'), 'utf8'),
      'after\n',
    );
    assert.equal(
      await readFile(join(repository, 'new.txt'), 'utf8'),
      'new file\n',
    );
    assert.deepEqual(
      await readFile(join(repository, 'new binary file.bin')),
      Buffer.from([0, 1, 2, 255]),
    );
    await assert.rejects(
      () => readFile(join(repository, 'deleted.txt')),
      /ENOENT/,
    );
    if (process.platform !== 'win32') {
      assert.equal(
        (await lstat(join(repository, 'executable.sh'))).mode & 0o111,
        0o111,
      );
      assert.equal(
        (await lstat(join(repository, 'tracked-link'))).isSymbolicLink(),
        true,
      );
    }

    await removeIsolatedWorktree({ repository, workspace });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
