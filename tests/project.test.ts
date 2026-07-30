import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import test from 'node:test';

import { execute } from '../src/git.ts';
import {
  cleanProjectPathInput,
  isPathInside,
  relativePathStaysInsideParent,
  resolveProject,
} from '../src/project.ts';

test('normalizes pasted and dragged project paths', () => {
  assert.equal(cleanProjectPathInput('  "/tmp/a project"  '), '/tmp/a project');
  assert.equal(cleanProjectPathInput('/tmp/a\\ project '), '/tmp/a project');
});

test('does not treat a path on another Windows drive as a child path', () => {
  const relativePath = win32.relative(
    'D:\\projects\\random',
    'C:\\Users\\person\\AppData\\Local\\Agent Bridge\\runs',
  );

  assert.equal(win32.isAbsolute(relativePath), true);
  assert.equal(
    relativePathStaysInsideParent(relativePath, {
      isAbsolute: win32.isAbsolute,
      separator: win32.sep,
    }),
    false,
  );
});

test('accepts an ordinary directory for review-only workflows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-directory-'));
  try {
    assert.deepEqual(await resolveProject(directory), {
      root: directory,
      kind: 'directory',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('resolves nested folders to an independent Git repository root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-project-'));
  const repository = join(root, 'project with spaces');
  const nested = join(repository, 'src', 'feature');
  try {
    await execute('git', ['init', repository], { cwd: root });
    await mkdir(nested, { recursive: true });
    assert.deepEqual(await resolveProject(`"${nested}"`), {
      root: await realpath(repository),
      kind: 'git',
    });
    assert.deepEqual(await resolveProject(root), {
      root,
      kind: 'directory',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'detects output paths that enter a project through a symlink',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-bridge-project-path-'));
    const project = join(root, 'project');
    const link = join(root, 'output-link');
    try {
      await mkdir(join(project, 'private-output'), { recursive: true });
      await symlink(join(project, 'private-output'), link);
      assert.equal(await isPathInside(project, join(link, 'runs')), true);
      assert.equal(
        await isPathInside(project, join(root, 'outside', 'runs')),
        false,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
