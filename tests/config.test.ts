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
    assert.match(await readFile(configPath, 'utf8'), /"version": 3/);
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
    assert.deepEqual(await store.load(), { version: 3, recentProjects: [] });
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
      version: 3,
      recentProjects: [],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('persists presentation preferences without losing recent projects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-config-ui-'));
  const configPath = join(directory, 'config.json');
  try {
    const store = new UserConfigStore(configPath);
    await store.rememberProject(join(directory, 'project'));
    const config = await store.rememberPresentation({
      screenReader: true,
      color: false,
      ui: 'plain',
    });
    assert.equal(config.recentProjects.length, 1);
    assert.deepEqual(config.presentation, {
      screenReader: true,
      color: false,
      ui: 'plain',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('migrates a stored noColor preference without inventing a color choice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-config-v2-'));
  try {
    const load = async (
      noColor: boolean,
    ): Promise<boolean | undefined | 'absent'> => {
      const configPath = join(directory, `config-${String(noColor)}.json`);
      await writeFile(
        configPath,
        JSON.stringify({
          version: 2,
          recentProjects: ['/project'],
          presentation: { screenReader: false, noColor, ui: 'plain' },
        }),
      );
      const config = await new UserConfigStore(configPath).load();
      assert.equal(config.version, 3);
      return 'color' in (config.presentation ?? {})
        ? config.presentation?.color
        : 'absent';
    };

    // `noColor: true` could only come from an intentional choice, so it
    // survives as an explicit "no color".
    assert.equal(await load(true), false);
    // `noColor: false` only ever meant "nothing was chosen": the CLI that wrote
    // it had no `--color`, and NO_COLOR still applied. Reading it as an
    // explicit color-on would silently promote it to outranking NO_COLOR.
    assert.equal(await load(false), 'absent');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('migrates version 1 configuration when it is loaded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-config-v1-'));
  const configPath = join(directory, 'config.json');
  try {
    await writeFile(
      configPath,
      JSON.stringify({ version: 1, recentProjects: ['/project'] }),
    );
    assert.deepEqual(await new UserConfigStore(configPath).load(), {
      version: 3,
      recentProjects: ['/project'],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
