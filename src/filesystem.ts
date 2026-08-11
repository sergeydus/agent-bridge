import {
  chmod,
  mkdir,
  open,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function writePrivateFileAtomic(
  destination: string,
  contents: string,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600 });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Atomic publication for content a subprocess writes, where the bytes never
 * pass through this process. `produce` fills a private temporary file; the
 * destination only ever appears complete, or not at all.
 *
 * `keep` decides after production whether the result is worth publishing. A
 * rejected result removes any stale file at the destination rather than leaving
 * an older artifact that would be read as current.
 */
export async function producePrivateFileAtomic({
  destination,
  produce,
  keep = () => Promise.resolve(true),
}: {
  destination: string;
  produce: (temporaryPath: string) => Promise<void>;
  keep?: (temporaryPath: string) => Promise<boolean>;
}): Promise<boolean> {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    // Created here so the content is owner-only from the first byte, whatever
    // umask the producing subprocess runs under.
    await writeFile(temporary, '', { mode: 0o600 });
    await produce(temporary);
    if (!(await keep(temporary))) {
      await rm(temporary, { force: true });
      await rm(destination, { force: true });
      return false;
    }
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
    return true;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function readPrefix(
  handle: FileHandle,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  while (bytesRead < maxBytes) {
    const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes - bytesRead));
    const result = await handle.read(buffer, 0, buffer.length, bytesRead);
    if (result.bytesRead === 0) {
      break;
    }
    chunks.push(buffer.subarray(0, result.bytesRead));
    bytesRead += result.bytesRead;
  }
  return Buffer.concat(chunks, bytesRead);
}

export async function readFilePrefixBytes({
  path,
  maxBytes,
}: {
  path: string;
  maxBytes: number;
}): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    return await readPrefix(handle, maxBytes);
  } finally {
    await handle.close();
  }
}

export async function readTextFilePrefix({
  path,
  maxCharacters,
}: {
  path: string;
  maxCharacters: number;
}): Promise<string> {
  const bytes = await readFilePrefixBytes({
    path,
    maxBytes: maxCharacters * 4,
  });
  return bytes.toString('utf8').slice(0, maxCharacters);
}
