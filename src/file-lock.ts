import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
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
 * `stale` is the only state eligible for takeover, and it is deliberately narrow:
 * the path is a plain file, the record parsed, it names this host, and its
 * process is gone. Everything else — an empty file, an older build's record,
 * unparseable content, a record from another machine, a live process, anything
 * that is not a regular file — is a lock that is left alone. The empty case is
 * the whole of D6: the owner wins `open(path, 'wx')` before it writes its record,
 * so a reader inside that window sees a live lock as a 0-byte file.
 */
type LockState =
  | { kind: 'absent' }
  | { kind: 'stale'; record: LockRecord }
  | { kind: 'held'; record: LockRecord; foreignHost: boolean }
  | { kind: 'unidentified'; reason: LockUnidentifiedReason };

type LockUnidentifiedReason = 'empty' | 'legacy' | 'unreadable' | 'irregular';

/**
 * `O_NOFOLLOW` makes opening fail rather than traverse a symbolic link at the
 * final path component. It does not exist on Windows, where the flag resolves to
 * zero: there the `lstat` classification is the only protection, so the window
 * between classifying a path and opening it stays open on that platform.
 */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** The part of a `FileHandle` a record write needs, so tests can supply one. */
export interface LockRecordWriter {
  write(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesWritten: number }>;
}

/**
 * Writes a record and accounts for every byte. `write` may report a short write,
 * and ignoring `bytesWritten` would leave a truncated record at a path this
 * process then claims to own — an unreadable lock reported as a held one.
 */
export async function writeWholeRecord(
  handle: LockRecordWriter,
  text: string,
): Promise<void> {
  const buffer = Buffer.from(text, 'utf8');
  let written = 0;
  while (written < buffer.length) {
    const result = await handle.write(
      buffer,
      written,
      buffer.length - written,
      written,
    );
    if (result.bytesWritten === 0) {
      throw new Error(`Wrote no bytes of a ${buffer.length}-byte lock record.`);
    }
    written += result.bytesWritten;
  }
}

function lockRecordText(token: string): string {
  return `${JSON.stringify({
    pid: process.pid,
    host: hostname(),
    token,
    createdAt: new Date().toISOString(),
  })}\n`;
}

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

type LockRead =
  | { kind: 'absent' }
  | { kind: 'record'; record: LockRecord }
  | { kind: 'unidentified'; reason: LockUnidentifiedReason };

/** Classifies the bytes of a lock file, wherever they were read from. */
function classifyLockText(text: string): LockRead {
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

/**
 * Reads the record from an already-open handle, so the bytes classified belong
 * to the object that handle refers to and not to whatever the path resolves to
 * at some later moment.
 */
async function readLockRecordFrom(handle: FileHandle): Promise<LockRead> {
  const buffer = Buffer.alloc(MAX_LOCK_RECORD_CHARS);
  let filled = 0;
  while (filled < buffer.length) {
    const result = await handle.read(
      buffer,
      filled,
      buffer.length - filled,
      filled,
    );
    if (result.bytesRead === 0) {
      break;
    }
    filled += result.bytesRead;
  }
  return classifyLockText(buffer.subarray(0, filled).toString('utf8'));
}

async function readLockRecord(path: string): Promise<LockRead> {
  // `lstat` describes the path itself, so a symbolic link is seen as a link
  // rather than as whatever it points at. A lock path that is not a plain file
  // with exactly one name cannot be attributed to an owner, and reading through
  // it would report someone else's file as a lock record.
  try {
    const link = await lstat(path);
    if (!link.isFile() || link.nlink !== 1) {
      return { kind: 'unidentified', reason: 'irregular' };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'absent' };
    }
    return { kind: 'unidentified', reason: 'unreadable' };
  }
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
  return classifyLockText(text);
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

/** Where the exclusive right to take over a stale lock is claimed. */
function takeoverPathFor(path: string): string {
  return `${path}.takeover`;
}

/**
 * What happened when a lock judged stale was taken over.
 *
 * `blocked` means another process is inside the takeover, or a previous one was
 * killed inside it. That marker is never removed automatically either, so the
 * worst case degrades to the same manual recovery as any unattributable lock
 * rather than to a shared lock.
 */
type TakeoverResult =
  | { kind: 'owned' }
  | { kind: 'vanished' }
  | { kind: 'lost'; state: LockState }
  | { kind: 'blocked' }
  | { kind: 'irregular' };

/**
 * Takes over a lock judged stale, without ever unlinking it.
 *
 * Comparing the ownership token and then unlinking is not enough, and this is
 * the correction to the first implementation of this slice: two contenders can
 * both read the same stale token, the first unlinks it and claims a new lock,
 * and the second then performs its already-authorized unlink and deletes the new
 * holder's lock. Thirty-two concurrent acquirers against one stale record
 * produced four to six winners that way. Narrowing the window is not a fix,
 * because the window is between two syscalls that cannot be fused.
 *
 * Two changes close it. Takeover happens under an exclusively created marker, so
 * at most one process is ever inside it, and the stale record is overwritten in
 * place rather than removed and recreated, so the lock path is never briefly
 * free for a fourth process to claim. No foreign lock file is ever unlinked.
 */
export async function takeOverStaleLock({
  path,
  judged,
  token,
}: {
  path: string;
  judged: { token: string };
  token: string;
}): Promise<TakeoverResult> {
  const takeoverPath = takeoverPathFor(path);
  let marker;
  try {
    marker = await open(takeoverPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return { kind: 'blocked' };
    }
    throw error;
  }
  try {
    await writeWholeRecord(marker, lockRecordText(token));
    // Re-judged inside the exclusive section: a previous takeover may have
    // already handed this lock to a live process.
    const state = await inspectLock(path);
    if (state.kind === 'absent') {
      return { kind: 'vanished' };
    }
    if (state.kind !== 'stale' || state.record.token !== judged.token) {
      return { kind: 'lost', state };
    }
    // `O_NOFOLLOW` refuses to traverse a symbolic link at the final component.
    // Without it, a lock path pointing at any file whose contents happen to
    // parse as a stale record made takeover overwrite that file instead.
    const handle = await open(path, constants.O_RDWR | NOFOLLOW);
    try {
      // Verified through the handle, so the object checked is exactly the object
      // about to be written: a path check alone could describe a different file
      // by the time the write lands. A plain file with one name, holding the
      // same record judged stale — read from this handle, not from the path.
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1) {
        return { kind: 'irregular' };
      }
      const confirmed = await readLockRecordFrom(handle);
      if (
        confirmed.kind !== 'record' ||
        confirmed.record.token !== judged.token
      ) {
        return { kind: 'lost', state: await inspectLock(path) };
      }
      await handle.truncate(0);
      await writeWholeRecord(handle, lockRecordText(token));
    } finally {
      await handle.close();
    }
    return { kind: 'owned' };
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ELOOP' ||
      (error as NodeJS.ErrnoException).code === 'EMLINK' ||
      (error as NodeJS.ErrnoException).code === 'EFTYPE'
    ) {
      // What `O_NOFOLLOW` reports for a symbolic link, spelled differently by
      // platform.
      return { kind: 'irregular' };
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // The stale lock disappeared between the re-judgement and the overwrite.
      return { kind: 'vanished' };
    }
    throw error;
  } finally {
    await marker.close().catch(() => {});
    // Safe to unlink by path: nothing else can have replaced this marker while
    // this process held it, because creating it requires an exclusive create
    // that fails for as long as it exists.
    await unlink(takeoverPath).catch(() => {});
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
  if (state.kind === 'unidentified' && state.reason === 'irregular') {
    return (
      `The lock path is not a plain file — a symbolic link or another special ` +
      `file is in its place — so it cannot be attributed to an owner and is ` +
      `left untouched. Writing through it would modify whatever it points at. ` +
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
   * token compared first: a lock that was taken over as stale by another
   * process must not be unlinked here, which would leave that process believing
   * it still holds a lock that no longer exists.
   *
   * The released flag is set only once the lock is actually gone or provably not
   * this holder's any more. Setting it up front made a failed release
   * unretryable: a release that hit `EACCES` returned, and the next call
   * returned immediately without removing anything.
   */
  async release(): Promise<void> {
    if (this.#released) {
      return;
    }
    const current = await readLockRecord(this.#path);
    if (current.kind !== 'record' || current.record.token !== this.#token) {
      // Absent, or no longer this holder's: there is nothing left to release,
      // and nothing a retry could achieve.
      this.#released = true;
      return;
    }
    await unlink(this.#path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        // Left unreleased on purpose, so a caller that can fix the cause — a
        // read-only parent directory, say — can call release again.
        throw error;
      }
    });
    this.#released = true;
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
      // `wx` is `O_CREAT | O_EXCL`, which POSIX requires to fail on a symbolic
      // link at the final component, so creation cannot be redirected either.
      const handle = await open(path, 'wx', 0o600);
      try {
        await writeWholeRecord(handle, lockRecordText(token));
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
      let state = await inspectLock(path);
      if (attempt === 0) {
        if (state.kind === 'absent') {
          continue;
        }
        if (state.kind === 'stale') {
          const takeover = await takeOverStaleLock({
            path,
            judged: state.record,
            token,
          });
          if (takeover.kind === 'owned') {
            // Taken over in place: this process's record is now the one at the
            // path, so it holds the lock without the path ever being free.
            return new FileLock(path, token);
          }
          if (takeover.kind === 'vanished') {
            continue;
          }
          if (takeover.kind === 'blocked') {
            throw new Error(
              `${activeMessage} A lock left behind by a process that is no ` +
                `longer running is being taken over by another Agent Bridge ` +
                `process, or by one that was interrupted while doing so. The ` +
                `lock file is ${path} and the takeover marker is ` +
                `${takeoverPathFor(path)}. Try again, and if this persists ` +
                `with no Agent Bridge process running, delete both files.`,
              { cause: error },
            );
          }
          // Either the path turned out not to be a plain file, or another
          // process owns the lock now. Both report the state found rather than
          // the record this attempt judged stale.
          state =
            takeover.kind === 'irregular'
              ? { kind: 'unidentified', reason: 'irregular' }
              : takeover.state;
        }
      }
      throw new Error(`${activeMessage} ${describeOwner(state, path)}`, {
        cause: error,
      });
    }
  }
}
