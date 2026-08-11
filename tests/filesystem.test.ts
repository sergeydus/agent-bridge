import assert from 'node:assert/strict';
import {
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  producePrivateFileAtomic,
  writePrivateFileAtomic,
} from '../src/filesystem.ts';

async function withDirectory(
  body: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-filesystem-'));
  try {
    await body(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('an interrupted production leaves nothing at the destination', async () => {
  await withDirectory(async (directory) => {
    const destination = join(directory, 'artifact.patch');

    await assert.rejects(() =>
      producePrivateFileAtomic({
        destination,
        produce: async (temporaryPath) => {
          // A partial write, exactly as an interrupted subprocess leaves it.
          await writeFile(temporaryPath, 'diff --git a/half');
          throw new Error('interrupted');
        },
      }),
    );

    await assert.rejects(() => readFile(destination, 'utf8'), /ENOENT/);
    assert.deepEqual(await readdir(directory), []);
  });
});

test('a produced file is owner-only and complete when it appears', async () => {
  await withDirectory(async (directory) => {
    const destination = join(directory, 'artifact.patch');

    const published = await producePrivateFileAtomic({
      destination,
      produce: (temporaryPath) => writeFile(temporaryPath, 'complete\n'),
    });

    assert.equal(published, true);
    assert.equal(await readFile(destination, 'utf8'), 'complete\n');
    assert.equal((await lstat(destination)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ['artifact.patch']);
  });
});

test('a rejected result removes a stale file rather than leaving it current', async () => {
  await withDirectory(async (directory) => {
    const destination = join(directory, 'artifact.patch');
    await writePrivateFileAtomic(destination, 'from an earlier run\n');

    const published = await producePrivateFileAtomic({
      destination,
      produce: (temporaryPath) => writeFile(temporaryPath, ''),
      keep: () => Promise.resolve(false),
    });

    assert.equal(published, false);
    await assert.rejects(() => readFile(destination, 'utf8'), /ENOENT/);
    assert.deepEqual(await readdir(directory), []);
  });
});

test('an interrupted string write leaves an existing file untouched', async () => {
  await withDirectory(async (directory) => {
    const destination = join(directory, 'transcript.md');
    await writePrivateFileAtomic(destination, 'first\n');

    await writePrivateFileAtomic(destination, 'second\n');

    assert.equal(await readFile(destination, 'utf8'), 'second\n');
    assert.equal((await lstat(destination)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ['transcript.md']);
  });
});
