import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export class FileLock {
  #path: string;
  #released = false;

  constructor(path: string) {
    this.#path = path;
  }

  async release(): Promise<void> {
    if (this.#released) {
      return;
    }
    await unlink(this.#path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
    this.#released = true;
  }
}

async function removeStaleLock(path: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    const pid =
      parsed &&
      typeof parsed === 'object' &&
      Number.isInteger((parsed as { pid?: unknown }).pid)
        ? Number((parsed as { pid: number }).pid)
        : undefined;
    if (!pid || pid <= 0) {
      await unlink(path);
      return true;
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        await unlink(path);
        return true;
      }
      return false;
    }
  } catch {
    await unlink(path).catch(() => {});
    return true;
  }
}

export async function acquireFileLock({
  path,
  activeMessage,
}: {
  path: string;
  activeMessage: string;
}): Promise<FileLock> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify({
            pid: process.pid,
            createdAt: new Date().toISOString(),
          })}\n`,
        );
        await handle.close();
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(path).catch(() => {});
        throw error;
      }
      return new FileLock(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      if (attempt === 0 && (await removeStaleLock(path))) {
        continue;
      }
      throw new Error(activeMessage, { cause: error });
    }
  }
  throw new Error(`Unable to acquire file lock: ${path}`);
}
