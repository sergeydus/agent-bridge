import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { isProjectConfig, loadProjectConfig } from '../src/project-config.ts';

test('loads explicit argument-array verification without a shell', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-project-config-'));
  try {
    const path = join(root, '.agent-bridge.json');
    const config = {
      $schema: './schemas/project-config.schema.json',
      version: 1,
      verification: [{ command: 'npm', args: ['test'], timeoutMinutes: 10 }],
      protectedPaths: ['secrets'],
    };
    await writeFile(path, JSON.stringify(config));
    assert.deepEqual(
      (await loadProjectConfig({ projectRoot: root })).config,
      config,
    );
    assert.equal(isProjectConfig(config), true);
    assert.equal(
      isProjectConfig({
        ...config,
        verification: [{ command: './unsafe-script', args: [] }],
      }),
      false,
    );
    for (const invalid of [
      { ...config, unexpected: true },
      { ...config, protectedPaths: [''] },
      { ...config, protectedPaths: ['secrets', 'secrets'] },
      { ...config, protectedPaths: ['../outside'] },
      {
        ...config,
        verification: [{ command: 'npm test', args: [] }],
      },
      {
        ...config,
        verification: [{ command: 'npm', args: [], extra: true }],
      },
    ]) {
      assert.equal(isProjectConfig(invalid), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('uses an empty configuration when the default file is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-project-config-'));
  try {
    assert.deepEqual((await loadProjectConfig({ projectRoot: root })).config, {
      version: 1,
      verification: [],
      protectedPaths: [],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
