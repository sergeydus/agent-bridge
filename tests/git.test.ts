import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
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
  currentCommit,
  describeCommitsSinceBase,
  execute,
  countPatchedFiles,
  isCommitAnchored,
  workspaceFingerprint,
  initializeRepository,
  removeIsolatedWorktree,
  repositoryHasHead,
} from '../src/git.ts';

test('initializes a repository without creating a commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-git-init-'));
  try {
    await writeFile(join(root, 'existing.txt'), 'untouched\n');

    assert.equal(await initializeRepository(root), await realpath(root));
    assert.equal(await repositoryHasHead(root), false);
    const status = await execute('git', ['status', '--porcelain=v1'], {
      cwd: root,
    });
    assert.match(status.stdout, /^\?\? existing\.txt/m);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
      revision: await currentCommit(repository),
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

    const patchCreated = await createPatch({
      workspace,
      destination: patchPath,
      baseRevision: await currentCommit(repository),
    });
    const patch = await readFile(patchPath, 'utf8');
    assert.equal(patchCreated, true);
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

async function initializeFixtureRepository(root: string): Promise<string> {
  const repository = join(root, 'repository');
  await execute('git', ['init', repository], { cwd: root });
  for (const [key, value] of [
    ['user.name', 'Agent Bridge Test'],
    ['user.email', 'test@example.com'],
    ['commit.gpgsign', 'false'],
  ] as [string, string][]) {
    await execute('git', ['config', key, value], { cwd: repository });
  }
  await writeFile(join(repository, 'tracked.txt'), 'before\n');
  await execute('git', ['add', 'tracked.txt'], { cwd: repository });
  await execute('git', ['commit', '-m', 'initial'], { cwd: repository });
  return repository;
}

test('a patch is published atomically or not at all', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-atomic-'));
  try {
    const repository = await initializeFixtureRepository(root);
    const workspace = await createIsolatedWorktree({
      repository,
      runsDirectory: join(root, 'runs'),
      runId: 'atomic',
      revision: await currentCommit(repository),
    });
    await writeFile(join(workspace, 'tracked.txt'), 'after\n');
    const destination = join(root, 'atomic.patch');

    // An interrupted capture must leave nothing at the final path, because
    // createPatch reports success by the file being non-empty and a truncated
    // patch is indistinguishable from a complete one.
    await assert.rejects(() =>
      createPatch({
        workspace,
        destination,
        baseRevision: 'not-a-revision',
      }),
    );
    await assert.rejects(() => readFile(destination, 'utf8'), /ENOENT/);

    assert.equal(
      await createPatch({
        workspace,
        destination,
        baseRevision: await currentCommit(repository),
      }),
      true,
    );
    assert.equal((await lstat(destination)).mode & 0o777, 0o600);
    assert.match(await readFile(destination, 'utf8'), /tracked\.txt/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an empty capture removes a stale patch instead of leaving it current', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-atomic-'));
  try {
    const repository = await initializeFixtureRepository(root);
    const workspace = await createIsolatedWorktree({
      repository,
      runsDirectory: join(root, 'runs'),
      runId: 'stale',
      revision: await currentCommit(repository),
    });
    const destination = join(root, 'stale.patch');
    const baseRevision = await currentCommit(repository);

    await writeFile(join(workspace, 'tracked.txt'), 'after\n');
    assert.equal(
      await createPatch({ workspace, destination, baseRevision }),
      true,
    );

    // The edit is reverted, so the earlier patch no longer describes anything.
    await writeFile(join(workspace, 'tracked.txt'), 'before\n');
    assert.equal(
      await createPatch({ workspace, destination, baseRevision }),
      false,
    );
    await assert.rejects(() => readFile(destination, 'utf8'), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a workspace commit is unanchored until a branch or tag contains it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-anchor-'));
  try {
    const repository = await initializeFixtureRepository(root);
    const baseRevision = await currentCommit(repository);
    const workspace = await createIsolatedWorktree({
      repository,
      runsDirectory: join(root, 'runs'),
      runId: 'anchor',
      revision: await currentCommit(repository),
    });
    await writeFile(join(workspace, 'tracked.txt'), 'after\n');
    await execute('git', ['commit', '--all', '-m', 'inside'], {
      cwd: workspace,
    });
    const head = await currentCommit(workspace);

    assert.equal(
      await isCommitAnchored({ workspace, revision: head }),
      false,
      'a detached worktree commit is reachable from no ref',
    );
    assert.deepEqual(
      await describeCommitsSinceBase({ workspace, baseRevision }),
      { head, commits: 1, diverged: false },
    );

    await execute('git', ['branch', 'keep-my-work', head], { cwd: workspace });
    assert.equal(await isCommitAnchored({ workspace, revision: head }), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a workspace that left its base behind is reported as diverged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-diverge-'));
  try {
    const repository = await initializeFixtureRepository(root);
    const baseRevision = await currentCommit(repository);
    const workspace = await createIsolatedWorktree({
      repository,
      runsDirectory: join(root, 'runs'),
      runId: 'diverge',
      revision: await currentCommit(repository),
    });

    // An unrelated root commit: the base is not an ancestor of it.
    await execute('git', ['checkout', '--orphan', 'unrelated'], {
      cwd: workspace,
    });
    await writeFile(join(workspace, 'unrelated.txt'), 'elsewhere\n');
    await execute('git', ['add', '--all'], { cwd: workspace });
    await execute('git', ['commit', '-m', 'unrelated root'], {
      cwd: workspace,
    });

    const described = await describeCommitsSinceBase({
      workspace,
      baseRevision,
    });

    assert.equal(described.diverged, true);
    // No count, because "N commits ahead" would be a lie here.
    assert.equal(described.commits, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a fingerprint against a fixed base survives an agent committing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-fingerprint-'));
  try {
    const repository = await initializeFixtureRepository(root);
    const baseRevision = await currentCommit(repository);
    const workspace = await createIsolatedWorktree({
      repository,
      runsDirectory: join(root, 'runs'),
      runId: 'fingerprint',
      revision: await currentCommit(repository),
    });

    const clean = await workspaceFingerprint({ workspace, baseRevision });
    await writeFile(join(workspace, 'tracked.txt'), 'after\n');
    const edited = await workspaceFingerprint({ workspace, baseRevision });
    assert.notEqual(edited, clean);

    // D8: committing moved HEAD with the fingerprint, so the edit disappeared
    // and the workspace looked identical to its clean state again. Against a
    // fixed base the fingerprint stays at its edited value instead.
    await execute('git', ['commit', '--all', '-m', 'inside'], {
      cwd: workspace,
    });
    const committed = await workspaceFingerprint({ workspace, baseRevision });
    assert.equal(committed, edited);
    assert.notEqual(committed, clean);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a workspace starts at the recorded revision, not at a moved HEAD', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-revision-'));
  try {
    const repository = await initializeFixtureRepository(root);
    const recorded = await currentCommit(repository);

    // The source branch advances between recording the baseline and creating
    // the workspace, which is exactly what symbolic HEAD would have followed.
    await writeFile(join(repository, 'later.txt'), 'moved on\n');
    await execute('git', ['add', '--all'], { cwd: repository });
    await execute('git', ['commit', '-m', 'source moved'], { cwd: repository });
    assert.notEqual(await currentCommit(repository), recorded);

    const workspace = await createIsolatedWorktree({
      repository,
      runsDirectory: join(root, 'runs'),
      runId: 'pinned',
      revision: recorded,
    });

    assert.equal(await currentCommit(workspace), recorded);
    await assert.rejects(
      () => readFile(join(workspace, 'later.txt'), 'utf8'),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a patch reports the number of files it touches without applying it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-numstat-'));
  try {
    const repository = await initializeFixtureRepository(root);
    const baseRevision = await currentCommit(repository);
    const workspace = await createIsolatedWorktree({
      repository,
      runsDirectory: join(root, 'runs'),
      runId: 'numstat',
      revision: baseRevision,
    });
    await writeFile(join(workspace, 'tracked.txt'), 'after\n');
    await writeFile(join(workspace, 'added.txt'), 'new\n');
    const patchPath = join(root, 'numstat.patch');
    await createPatch({ workspace, destination: patchPath, baseRevision });

    assert.equal(await countPatchedFiles({ repository, patchPath }), 2);
    // Counting must not be an apply in disguise.
    assert.equal(
      await readFile(join(repository, 'tracked.txt'), 'utf8'),
      'before\n',
    );
    await assert.rejects(
      () => readFile(join(repository, 'added.txt'), 'utf8'),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
