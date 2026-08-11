import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { acquireFileLock, removeStaleLock } from '../src/file-lock.ts';

// Removing a file needs write permission on its directory, not on the file. A
// read-only parent is the portable way to make `unlink` fail without racing
// anything — except as root, which ignores the mode.
const canObserveUnlinkFailure =
  process.platform !== 'win32' && process.getuid?.() !== 0;

async function withDirectory(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-lock-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function record(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

async function writeRecord(
  path: string,
  fields: Record<string, unknown>,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(fields)}\n`, { mode: 0o600 });
}

const ACTIVE = 'Run r is already active in another Agent Bridge process.';

test('an acquired lock records the host and an ownership token', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'nested', 'r.lock');
    const lock = await acquireFileLock({ path, activeMessage: ACTIVE });

    const written = await record(path);
    assert.equal(written.pid, process.pid);
    assert.equal(written.host, hostname());
    assert.equal(typeof written.token, 'string');
    assert.ok((written.token as string).length > 0);
    assert.equal(typeof written.createdAt, 'string');

    await lock.release();
    assert.equal(await exists(path), false);
  });
});

test('releasing twice is not an error', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'r.lock');
    const lock = await acquireFileLock({ path, activeMessage: ACTIVE });
    await lock.release();
    await lock.release();
    assert.equal(await exists(path), false);
  });
});

test('a release whose lock file already vanished succeeds', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'r.lock');
    const lock = await acquireFileLock({ path, activeMessage: ACTIVE });
    await rm(path);
    await lock.release();
  });
});

// D6, reproduced deterministically rather than by racing: the owner has won
// `open(path, 'wx')` and has not yet written its record, so the file is 0
// bytes. Against the previous implementation the second acquirer succeeded and
// two processes believed they held the same lock.
test('a lock claimed but not yet recorded is never taken over', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'r.lock');
    const owner = await open(path, 'wx', 0o600);
    try {
      await assert.rejects(
        acquireFileLock({ path, activeMessage: ACTIVE }),
        (error: Error) => {
          assert.match(error.message, /lock file is empty/);
          assert.match(error.message, /interrupted/);
          assert.ok(error.message.includes(path));
          return true;
        },
      );
      // The live owner's lock is still there.
      assert.equal(await exists(path), true);
    } finally {
      await owner.close();
    }
  });
});

test('an unparseable lock record is never treated as stale', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'r.lock');
    await writeFile(path, 'not json at all', { mode: 0o600 });

    await assert.rejects(
      acquireFileLock({ path, activeMessage: ACTIVE }),
      (error: Error) => {
        assert.match(error.message, /cannot be read as an Agent Bridge lock/);
        assert.ok(error.message.includes(path));
        return true;
      },
    );
    assert.equal(await exists(path), true);
  });
});

test('valid JSON that is not a lock record is never treated as stale', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'r.lock');
    await writeFile(path, '"a string"', { mode: 0o600 });

    await assert.rejects(acquireFileLock({ path, activeMessage: ACTIVE }), {
      message: /cannot be read as an Agent Bridge lock/,
    });
    assert.equal(await exists(path), true);
  });
});

// An older build wrote `pid` and `createdAt` and nothing else. It carries no
// host, so its PID cannot be evaluated safely, and no token, so it cannot be
// distinguished from a successor.
test('an older build’s lock record is left in place and named as such', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'r.lock');
    await writeRecord(path, {
      pid: 999_999,
      createdAt: new Date().toISOString(),
    });

    await assert.rejects(
      acquireFileLock({ path, activeMessage: ACTIVE }),
      (error: Error) => {
        assert.match(error.message, /older Agent Bridge version/);
        assert.ok(error.message.includes(path));
        return true;
      },
    );
    assert.equal(await exists(path), true);
  });
});

test('a record from another host is never removed, even with a dead PID', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'r.lock');
    await writeRecord(path, {
      pid: 999_999,
      host: `not-${hostname()}`,
      token: 'elsewhere',
      createdAt: new Date().toISOString(),
    });

    await assert.rejects(
      acquireFileLock({ path, activeMessage: ACTIVE }),
      (error: Error) => {
        assert.match(error.message, /not this machine/);
        assert.ok(error.message.includes(`not-${hostname()}`));
        assert.ok(error.message.includes(path));
        return true;
      },
    );
    // Still held: the owning machine's process table is not reachable here.
    assert.equal((await record(path)).token, 'elsewhere');
  });
});

test('a live local process keeps its lock', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'r.lock');
    const first = await acquireFileLock({ path, activeMessage: ACTIVE });

    await assert.rejects(
      acquireFileLock({ path, activeMessage: ACTIVE }),
      (error: Error) => {
        assert.ok(error.message.startsWith(ACTIVE));
        assert.match(error.message, /held by process \d+ on this machine/);
        assert.ok(error.message.includes(path));
        return true;
      },
    );

    await first.release();
  });
});

test('a local record whose process is gone is stale and replaced', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'r.lock');
    await writeRecord(path, {
      pid: 999_999,
      host: hostname(),
      token: 'departed',
      createdAt: new Date().toISOString(),
    });

    const lock = await acquireFileLock({ path, activeMessage: ACTIVE });

    const written = await record(path);
    assert.equal(written.pid, process.pid);
    assert.notEqual(written.token, 'departed');
    await lock.release();
  });
});

// Codex's ABA case. The first holder's lock is removed as stale and the path is
// taken by another process; the first holder must not unlink the successor.
test('release does not unlink a successor’s lock', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'r.lock');
    const first = await acquireFileLock({ path, activeMessage: ACTIVE });

    // A successor claims the same path.
    await writeRecord(path, {
      pid: process.pid,
      host: hostname(),
      token: 'successor',
      createdAt: new Date().toISOString(),
    });

    await first.release();

    assert.equal(await exists(path), true);
    assert.equal((await record(path)).token, 'successor');
  });
});

// The same ABA case one step earlier: a lock judged stale is re-taken between
// the judgement and the removal. `acquireFileLock` cannot be interleaved from a
// single process, so the re-check is driven directly.
test('stale removal refuses a lock that was re-taken in the meantime', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'r.lock');
    await writeRecord(path, {
      pid: 999_999,
      host: hostname(),
      token: 'successor',
      createdAt: new Date().toISOString(),
    });

    assert.equal(await removeStaleLock(path, { token: 'departed' }), false);
    assert.equal((await record(path)).token, 'successor');
  });
});

test('stale removal refuses a lock whose record no longer parses', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'r.lock');
    await writeFile(path, 'corrupted', { mode: 0o600 });

    assert.equal(await removeStaleLock(path, { token: 'departed' }), false);
    assert.equal(await exists(path), true);
  });
});

test('stale removal treats an already-gone lock as removed', async () => {
  await withDirectory(async (directory) => {
    assert.equal(
      await removeStaleLock(join(directory, 'gone.lock'), { token: 'x' }),
      true,
    );
  });
});

test(
  'an unremovable stale lock is reported as still held',
  { skip: !canObserveUnlinkFailure },
  async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, 'r.lock');
      await writeRecord(path, {
        pid: 999_999,
        host: hostname(),
        token: 'departed',
        createdAt: new Date().toISOString(),
      });
      await chmod(directory, 0o500);
      try {
        // Judged stale but not removable: reporting success here would let the
        // caller retry the claim forever against a lock that is still there.
        assert.equal(await removeStaleLock(path, { token: 'departed' }), false);
        await assert.rejects(acquireFileLock({ path, activeMessage: ACTIVE }));
      } finally {
        await chmod(directory, 0o700);
      }
    });
  },
);

test(
  'a release that cannot unlink reports the failure rather than hiding it',
  { skip: !canObserveUnlinkFailure },
  async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, 'r.lock');
      const lock = await acquireFileLock({ path, activeMessage: ACTIVE });
      await chmod(directory, 0o500);
      try {
        await assert.rejects(lock.release(), { code: 'EACCES' });
      } finally {
        await chmod(directory, 0o700);
      }
    });
  },
);

test('release leaves a lock whose record became unreadable', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'r.lock');
    const lock = await acquireFileLock({ path, activeMessage: ACTIVE });
    await writeFile(path, 'corrupted', { mode: 0o600 });

    await lock.release();

    // Not this holder's to remove: the content proves it is no longer the
    // record that was written here.
    assert.equal(await exists(path), true);
  });
});

test('a lock file larger than the read bound is unidentified, not stale', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'r.lock');
    // A valid record padded past the bounded read: the truncated prefix cannot
    // parse, so the lock is left alone rather than assumed dead.
    await writeFile(
      path,
      `${JSON.stringify({
        pid: 999_999,
        host: hostname(),
        token: 'x'.repeat(20_000),
        createdAt: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );

    await assert.rejects(acquireFileLock({ path, activeMessage: ACTIVE }), {
      message: /cannot be read as an Agent Bridge lock/,
    });
    assert.equal(await exists(path), true);
  });
});

test('a host string long enough to be corruption is not identity', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'r.lock');
    await writeRecord(path, {
      pid: 999_999,
      host: 'h'.repeat(300),
      token: 'padded',
      createdAt: new Date().toISOString(),
    });

    await assert.rejects(acquireFileLock({ path, activeMessage: ACTIVE }), {
      message: /cannot be read as an Agent Bridge lock/,
    });
    assert.equal(await exists(path), true);
  });
});

test('terminal escapes in a foreign host record cannot reach the message', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'r.lock');
    await writeRecord(path, {
      pid: 999_999,
      host: '\u001B[2Jevil\u0007',
      token: 'elsewhere',
      createdAt: new Date().toISOString(),
    });

    await assert.rejects(
      acquireFileLock({ path, activeMessage: ACTIVE }),
      (error: Error) => {
        assert.ok(!error.message.includes('\u001B'));
        assert.ok(!error.message.includes('\u0007'));
        assert.match(error.message, /evil/);
        return true;
      },
    );
  });
});

// A dangling symlink at the lock path is the one deterministic way to reach the
// "occupied but reads as absent" state: `open(path, 'wx')` on it fails with
// EEXIST while reading it fails with ENOENT. It must not be mistaken for a free
// path, and the retry must not spin.
test('a lock path that is occupied but reads as absent is refused, not spun on', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'r.lock');
    await symlink(join(directory, 'no-such-target'), path);

    await assert.rejects(
      acquireFileLock({ path, activeMessage: ACTIVE }),
      (error: Error) => {
        assert.ok(error.message.startsWith(ACTIVE));
        assert.ok(error.message.includes(path));
        return true;
      },
    );
    assert.equal(await exists(path), false);
    assert.equal((await lstat(path)).isSymbolicLink(), true);
  });
});

test('a record carrying the new fields but an invalid pid is corruption, not an old record', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'r.lock');
    await writeRecord(path, {
      pid: 0,
      host: hostname(),
      token: 'zero',
      createdAt: new Date().toISOString(),
    });

    await assert.rejects(acquireFileLock({ path, activeMessage: ACTIVE }), {
      message: /cannot be read as an Agent Bridge lock/,
    });
    assert.equal(await exists(path), true);
  });
});
