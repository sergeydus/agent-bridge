import {
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
