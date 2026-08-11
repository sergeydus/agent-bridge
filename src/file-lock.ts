import { randomUUID } from 'node:crypto';
import { mkdir, open, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

import { readTextFilePrefix } from './filesystem.ts';
import { sanitizeTerminalText } from './terminal-text.ts';

/**
 * What a lock file says about its owner. `host` and `token` are additive: a
 * record written by an older build carries neither, which makes it unidentified
 * rather than stale. `token` is what distinguishes this holder from a successor
 * that took the same path, so release cannot unlink a lock it no longer owns.
 */
interface LockRecord {
  pid: number;
  host: string;
  token: string;
  createdAt: string;
}

/** Larger than any record this writes, and small enough to read eagerly. */
const MAX_LOCK_RECORD_CHARS = 4_096;

/** A hostname long enough to be suspect is not identity; it is corruption. */
const MAX_LOCK_HOST_CHARS = 256;

/**
 * How a lock file was read.
 *
 * `stale` is the only removable state, and it is deliberately narrow: the record
 * parsed, it names this host, and its process is gone. Everything else — an
 * empty file, an older build's record, unparseable content, a record from
 * another machine, a live process — is a lock that is left alone. The empty case
 * is the whole of D6: the owner wins `open(path, 'wx')` before it writes its
 * record, so a reader inside that window sees a live lock as a 0-byte file.
 */
type LockState =
  | { kind: 'absent' }
  | { kind: 'stale'; record: LockRecord }
  | { kind: 'held'; record: LockRecord; foreignHost: boolean }
  | { kind: 'unidentified'; reason: 'empty' | 'legacy' | 'unreadable' };

function isLockRecord(value: unknown): value is LockRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<LockRecord>;
  return (
    Number.isInteger(candidate.pid) &&
    (candidate.pid ?? 0) > 0 &&
    typeof candidate.host === 'string' &&
    candidate.host.length > 0 &&
    candidate.host.length <= MAX_LOCK_HOST_CHARS &&
    typeof candidate.token === 'string' &&
    candidate.token.length > 0 &&
    typeof candidate.createdAt === 'string'
  );
}

async function readLockRecord(
  path: string,
): Promise<
  | { kind: 'absent' }
  | { kind: 'record'; record: LockRecord }
  | { kind: 'unidentified'; reason: 'empty' | 'legacy' | 'unreadable' }
> {
  let text: string;
  try {
    text = await readTextFilePrefix({
      path,
      maxCharacters: MAX_LOCK_RECORD_CHARS,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'absent' };
    }
    // An unreadable lock file is not an absent one. Treating a permission error
    // as "no lock" would hand out a lock another user is holding.
    return { kind: 'unidentified', reason: 'unreadable' };
  }
  if (text.trim() === '') {
    return { kind: 'unidentified', reason: 'empty' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'unidentified', reason: 'unreadable' };
  }
  if (isLockRecord(parsed)) {
    return { kind: 'record', record: parsed };
  }
  // A record with a plausible pid but no host and no token is an older build's.
  // Naming that separately is worth one branch: the recovery differs from
  // corruption, because the lock may well be genuinely held. Anything that has
  // the new fields but fails validation is corruption, not an old record.
  const fields = parsed as { pid?: unknown; host?: unknown; token?: unknown };
  const legacy =
    parsed !== null &&
    typeof parsed === 'object' &&
    Number.isInteger(fields.pid) &&
    fields.host === undefined &&
    fields.token === undefined;
  return {
    kind: 'unidentified',
    reason: legacy ? 'legacy' : 'unreadable',
  };
}

/** Whether a PID is running. `EPERM` means running under another user. */
function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function inspectLock(path: string): Promise<LockState> {
  const read = await readLockRecord(path);
  if (read.kind !== 'record') {
    return read.kind === 'absent'
      ? { kind: 'absent' }
      : { kind: 'unidentified', reason: read.reason };
  }
  const { record } = read;
  // A PID is only meaningful on the machine that wrote it. Data directories can
  // be synced or shared, and evaluating a foreign PID against the local process
  // table can clear a lock that is genuinely held elsewhere.
  if (record.host !== hostname()) {
    return { kind: 'held', record, foreignHost: true };
  }
  if (processIsRunning(record.pid)) {
    return { kind: 'held', record, foreignHost: false };
  }
  return { kind: 'stale', record };
}

/**
 * Removes a lock only if it is still the same lock that was judged stale. The
 * token is re-read because another process may have taken the path in between,
 * and unlinking then would hand the same lock to two holders.
 *
 * Exported so that re-check can be tested against a record that no longer
 * matches. The window it guards is between two syscalls, so a single-process
 * test cannot interleave a successor into `acquireFileLock` itself.
 */
export async function removeStaleLock(
  path: string,
  record: { token: string },
): Promise<boolean> {
  const current = await readLockRecord(path);
  if (current.kind === 'absent') {
    return true;
  }
  if (current.kind !== 'record' || current.record.token !== record.token) {
    return false;
  }
  try {
    await unlink(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function describeOwner(state: LockState, path: string): string {
  const where = `The lock file is ${path}.`;
  const remove = 'delete that file and try again.';
  if (state.kind === 'held') {
    // Untrusted: the host string comes from a file this process did not write.
    const host = sanitizeTerminalText(state.record.host).slice(
      0,
      MAX_LOCK_HOST_CHARS,
    );
    if (state.foreignHost) {
      return (
        `It is held by process ${state.record.pid} on ${host}, which is not ` +
        `this machine (${hostname()}), so whether that process is still ` +
        `running cannot be checked from here and the lock is left in place. ` +
        `${where} Wait for that machine to finish, or if you are certain ` +
        `nothing is using it, ${remove}`
      );
    }
    return (
      `It is held by process ${state.record.pid} on this machine. ${where} ` +
      `Let that process finish, or if it is no longer running, ${remove}`
    );
  }
  if (state.kind === 'unidentified' && state.reason === 'empty') {
    return (
      `The lock file is empty, which happens when its owner was interrupted ` +
      `between claiming the lock and recording who it is. A live owner looks ` +
      `the same from here, so the lock is never removed automatically. ` +
      `${where} If no other Agent Bridge process is running, ${remove}`
    );
  }
  if (state.kind === 'unidentified' && state.reason === 'legacy') {
    return (
      `The lock file was written by an older Agent Bridge version and does ` +
      `not record enough to identify its owner, so it is left in place. ` +
      `${where} If no other Agent Bridge process is running, ${remove}`
    );
  }
  return (
    `The lock file cannot be read as an Agent Bridge lock record, so its ` +
    `owner is unknown and it is left in place. ${where} If no other Agent ` +
    `Bridge process is running, ${remove}`
  );
}

export class FileLock {
  #path: string;
  #token: string;
  #released = false;

  constructor(path: string, token: string) {
    this.#path = path;
    this.#token = token;
  }

  /**
   * Releases only this holder's lock. The record is re-read and the ownership
   * token compared first: a lock that was removed as stale and re-taken by
   * another process must not be unlinked here, which would leave that process
   * believing it still holds a lock that no longer exists.
   */
  async release(): Promise<void> {
    if (this.#released) {
      return;
    }
    this.#released = true;
    const current = await readLockRecord(this.#path);
    if (current.kind !== 'record' || current.record.token !== this.#token) {
      return;
    }
    await unlink(this.#path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
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
  // Two attempts: one to claim the path, and one more after clearing a lock
  // proven stale or found already gone. Every iteration either returns or
  // throws, and only the first may retry, so this cannot spin.
  for (let attempt = 0; ; attempt += 1) {
    const token = randomUUID();
    try {
      // Winning this call is what confers ownership; the record that follows
      // only says who won.
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify({
            pid: process.pid,
            host: hostname(),
            token,
            createdAt: new Date().toISOString(),
          })}\n`,
        );
        await handle.close();
      } catch (error) {
        await handle.close().catch(() => {});
        await unlink(path).catch(() => {});
        throw error;
      }
      return new FileLock(path, token);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      const state = await inspectLock(path);
      if (attempt === 0) {
        if (state.kind === 'absent') {
          continue;
        }
        if (
          state.kind === 'stale' &&
          (await removeStaleLock(path, state.record))
        ) {
          continue;
        }
      }
      throw new Error(`${activeMessage} ${describeOwner(state, path)}`, {
        cause: error,
      });
    }
  }
}
