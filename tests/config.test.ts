import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { UserConfigStore } from '../src/config.ts';

test('persists recent projects privately, uniquely, and most-recent first', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-config-'));
  const privateDirectory = join(directory, 'private');
  const configPath = join(privateDirectory, 'config.json');
  try {
    const store = new UserConfigStore(configPath);
    await store.rememberProject(join(directory, 'first'));
    await store.rememberProject(join(directory, 'second'));
    const config = await store.rememberProject(join(directory, 'first'));

    assert.deepEqual(config.recentProjects, [
      resolve(directory, 'first'),
      resolve(directory, 'second'),
    ]);
    assert.deepEqual(await store.load(), config);
    assert.match(await readFile(configPath, 'utf8'), /"version": 1/);
    if (process.platform !== 'win32') {
      assert.equal((await stat(privateDirectory)).mode & 0o777, 0o700);
      assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('recovers safely from invalid configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-config-'));
  const configPath = join(directory, 'config.json');
  try {
    const store = new UserConfigStore(configPath);
    assert.deepEqual(await store.load(), { version: 1, recentProjects: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('ignores configuration with unexpected properties', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-config-'));
  try {
    const path = join(directory, 'config.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        recentProjects: ['/project'],
        unexpected: true,
      }),
    );
    assert.deepEqual(await new UserConfigStore(path).load(), {
      version: 1,
      recentProjects: [],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
