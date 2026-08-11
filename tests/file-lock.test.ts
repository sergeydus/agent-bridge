import assert from 'node:assert/strict';
import {
  chmod,
  link,
  lstat,
  mkdir,
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

import {
  acquireFileLock,
  takeOverStaleLock,
  writeWholeRecord,
  type FileLock,
} from '../src/file-lock.ts';

// Removing a file needs write permission on its directory, not on the file. A
// read-only parent is the portable way to make `unlink` fail without racing
// anything — except as root, which ignores the mode.
const canObserveUnlinkFailure =
  process.platform !== 'win32' && process.getuid?.() !== 0;

// Automatic takeover of a stale lock needs an open that refuses to follow a
// link. Windows has no such flag, so takeover is refused there by design and the
// tests that expect it to succeed do not apply. The refusal itself is tested on
// every platform through the injected capability, and again natively below.
const takeoverSupported = process.platform !== 'win32';

// Creating a symbolic link needs a privilege on Windows that CI does not grant,
// and hard-link counts are not reported the same way there.
const canObserveLinks = process.platform !== 'win32';

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

// A lock is a directory holding its owner record, so that a lock can be
// published atomically without ever resolving a link at the name being created.
const OWNER = 'owner.json';
const MARKER = 'takeover';

function ownerPath(lock: string): string {
  return join(lock, OWNER);
}

async function record(lock: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(ownerPath(lock), 'utf8')) as Record<
    string,
    unknown
  >;
}

/** Seeds a lock whose record is exactly the given text. */
async function seedLockText(lock: string, text: string): Promise<void> {
  await mkdir(lock, { recursive: true, mode: 0o700 });
  await writeFile(ownerPath(lock), text, { mode: 0o600 });
}

async function writeRecord(
  lock: string,
  fields: Record<string, unknown>,
): Promise<void> {
  await seedLockText(lock, `${JSON.stringify(fields)}\n`);
}

const STALE = {
  pid: 999_999,
  host: hostname(),
  token: 'departed',
  createdAt: '2026-08-11T00:00:00.000Z',
};

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
    await rm(path, { recursive: true });
    await lock.release();
  });
});

// D6, reproduced deterministically rather than by racing: the owner has claimed
// the lock and has not yet recorded who it is. Against the original
// implementation the second acquirer succeeded and two processes believed they
// held the same lock.
test('a lock claimed but not yet recorded is never taken over', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'r.lock');
    await mkdir(path, { mode: 0o700 });

    await assert.rejects(
      acquireFileLock({ path, activeMessage: ACTIVE }),
      (error: Error) => {
        assert.match(error.message, /names no owner/);
        assert.match(error.message, /interrupted/);
        assert.ok(error.message.includes(path));
        return true;
      },
    );
    // The live owner's lock is still there.
    assert.equal(await exists(path), true);
  });
});

test('an unparseable lock record is never treated as stale', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'r.lock');
    await seedLockText(path, 'not json at all');

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
    await seedLockText(path, '"a string"');

    await assert.rejects(acquireFileLock({ path, activeMessage: ACTIVE }), {
      message: /cannot be read as an Agent Bridge lock/,
    });
    assert.equal(await exists(path), true);
  });
});

// An older build made the lock the file itself, and wrote `pid` and `createdAt`
// and nothing else into it. It carries no host, so its PID cannot be evaluated
// safely, and no token, so it cannot be distinguished from a successor.
test('an older build’s lock is left in place and named as such', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'r.lock');
    await writeFile(
      path,
      `${JSON.stringify({ pid: 999_999, createdAt: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );

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

test(
  'a local record whose process is gone is stale and replaced',
  { skip: !takeoverSupported },
  async () => {
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
  },
);

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

// The takeover happens in place under an exclusive marker, so the lock path is
// never briefly free. Same inode, new owner.
test(
  'taking over a stale lock never leaves the path free',
  { skip: !takeoverSupported },
  async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, 'r.lock');
      await writeRecord(path, {
        pid: 999_999,
        host: hostname(),
        token: 'departed',
        createdAt: new Date().toISOString(),
      });
      const before = (await stat(path)).ino;

      const result = await takeOverStaleLock({
        path,
        judged: { token: 'departed' },
        token: 'mine',
      });

      assert.deepEqual(result, { kind: 'owned' });
      assert.equal((await stat(path)).ino, before);
      assert.equal((await record(path)).token, 'mine');
      assert.equal((await record(path)).pid, process.pid);
      assert.equal(await exists(join(path, MARKER)), false);
    });
  },
);

// The ABA case one step earlier: the lock judged stale was already taken over
// while this contender was deciding. It must report the current owner and touch
// nothing.
test(
  'a takeover of a lock that was already re-taken is lost, not forced',
  { skip: !takeoverSupported },
  async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, 'r.lock');
      await writeRecord(path, {
        pid: 999_999,
        host: hostname(),
        token: 'successor',
        createdAt: new Date().toISOString(),
      });

      const result = await takeOverStaleLock({
        path,
        judged: { token: 'departed' },
        token: 'mine',
      });

      assert.equal(result.kind, 'lost');
      assert.equal((await record(path)).token, 'successor');
    });
  },
);

test(
  'a takeover of a lock that vanished reports that, and claims nothing',
  { skip: !takeoverSupported },
  async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, 'r.lock');

      const result = await takeOverStaleLock({
        path,
        judged: { token: 'departed' },
        token: 'mine',
      });

      assert.deepEqual(result, { kind: 'vanished' });
      assert.equal(await exists(path), false);
    });
  },
);

test(
  'a takeover blocked by another takeover in progress claims nothing',
  { skip: !takeoverSupported },
  async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, 'r.lock');
      await writeRecord(path, {
        pid: 999_999,
        host: hostname(),
        token: 'departed',
        createdAt: new Date().toISOString(),
      });
      const marker = await open(join(path, MARKER), 'wx', 0o600);
      try {
        const result = await takeOverStaleLock({
          path,
          judged: { token: 'departed' },
          token: 'mine',
        });

        assert.deepEqual(result, { kind: 'blocked' });
        // Untouched: the process inside the section is the one entitled to it.
        assert.equal((await record(path)).token, 'departed');
      } finally {
        await marker.close();
      }
    });
  },
);

test(
  'a blocked takeover names the lock file and the takeover marker',
  { skip: !takeoverSupported },
  async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, 'r.lock');
      await writeRecord(path, {
        pid: 999_999,
        host: hostname(),
        token: 'departed',
        createdAt: new Date().toISOString(),
      });
      const marker = await open(join(path, MARKER), 'wx', 0o600);
      try {
        await assert.rejects(
          acquireFileLock({ path, activeMessage: ACTIVE }),
          (error: Error) => {
            assert.ok(error.message.startsWith(ACTIVE));
            assert.ok(error.message.includes(path));
            assert.ok(error.message.includes(join(path, MARKER)));
            assert.match(error.message, /Try again/);
            return true;
          },
        );
      } finally {
        await marker.close();
      }
    });
  },
);

// D6 under concurrency, which is what the first implementation of this slice
// got wrong. Comparing the ownership token and then unlinking let several
// contenders authorize their own removal from the same observation: the first
// unlinked the stale lock and claimed a new one, and the next deleted that new
// lock. Thirty-two contenders produced four to six winners. Exactly one may win.
test(
  'many contenders against one stale lock produce exactly one holder',
  { skip: !takeoverSupported },
  async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, 'r.lock');
      await writeRecord(path, {
        pid: 999_999,
        host: hostname(),
        token: 'departed',
        createdAt: new Date().toISOString(),
      });

      const results = await Promise.allSettled(
        Array.from({ length: 32 }, () =>
          acquireFileLock({ path, activeMessage: ACTIVE }),
        ),
      );

      const winners = results.filter((result) => result.status === 'fulfilled');
      assert.equal(winners.length, 1);
      // The surviving record belongs to the winner, and no marker is left behind.
      assert.equal((await record(path)).pid, process.pid);
      assert.equal(await exists(join(path, MARKER)), false);

      await (winners[0] as PromiseFulfilledResult<FileLock>).value.release();
      assert.equal(await exists(path), false);
    });
  },
);

test('many contenders for a free lock path produce exactly one holder', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'r.lock');

    const results = await Promise.allSettled(
      Array.from({ length: 32 }, () =>
        acquireFileLock({ path, activeMessage: ACTIVE }),
      ),
    );

    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      1,
    );
  });
});

// A lock path that is a symbolic link is not a lock. While the lock was a file,
// creating it resolved the link and wrote whatever it pointed at. Creating a
// directory cannot: the name already exists, so the call fails without
// resolving it.
test(
  'a symlinked lock path is refused and its target is untouched',
  { skip: !canObserveLinks },
  async () => {
    await withDirectory(async (directory) => {
      const target = join(directory, 'victim');
      const path = join(directory, 'r.lock');
      // Contents that would classify as a stale lock if read through the link.
      const original = `${JSON.stringify(STALE)}\n`;
      await writeFile(target, original, { mode: 0o600 });
      await symlink(target, path);

      await assert.rejects(
        acquireFileLock({ path, activeMessage: ACTIVE }),
        (error: Error) => {
          assert.match(error.message, /not a plain directory/);
          assert.ok(error.message.includes(path));
          return true;
        },
      );

      assert.equal(await readFile(target, 'utf8'), original);
      assert.equal((await lstat(path)).isSymbolicLink(), true);
    });
  },
);

// Where a file cannot be opened with "do not follow links", classifying the path
// and then opening it leaves a window in which the path can become a link, and
// the overwrite would land on whatever it points at. Takeover is refused outright
// there. Driven through the injected capability so it is proven on every
// platform, not only the one that lacks the flag.
test('takeover is refused outright where links cannot be refused on open', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'r.lock');
    const original = `${JSON.stringify({
      pid: 999_999,
      host: hostname(),
      token: 'departed',
      createdAt: '2026-08-11T00:00:00.000Z',
    })}\n`;
    await writeFile(path, original, { mode: 0o600 });

    const result = await takeOverStaleLock({
      path,
      judged: { token: 'departed' },
      token: 'mine',
      canRefuseLinkOnOpen: false,
    });

    assert.deepEqual(result, { kind: 'unsupported' });
    // Untouched, and no marker created on the way to the refusal.
    assert.equal(await readFile(path, 'utf8'), original);
    assert.equal(await exists(join(path, MARKER)), false);
  });
});

// The native counterpart, which runs only where the flag is genuinely missing.
// The stale record must survive rather than be overwritten, and the message must
// say what to do instead.
test(
  'a stale lock is preserved rather than taken over on this platform',
  { skip: takeoverSupported },
  async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, 'r.lock');
      const original = `${JSON.stringify(STALE)}\n`;
      await seedLockText(path, original);

      await assert.rejects(
        acquireFileLock({ path, activeMessage: ACTIVE }),
        (error: Error) => {
          assert.ok(error.message.startsWith(ACTIVE));
          assert.match(error.message, /cannot open a file while refusing/);
          assert.ok(error.message.includes(path));
          return true;
        },
      );

      assert.equal(await readFile(ownerPath(path), 'utf8'), original);
      assert.equal(await exists(join(path, MARKER)), false);
    });
  },
);

test(
  'many contenders against a stale lock never overwrite it on this platform',
  { skip: takeoverSupported },
  async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, 'r.lock');
      const original = `${JSON.stringify(STALE)}\n`;
      await seedLockText(path, original);

      const results = await Promise.allSettled(
        Array.from({ length: 32 }, () =>
          acquireFileLock({ path, activeMessage: ACTIVE }),
        ),
      );

      assert.equal(
        results.filter((result) => result.status === 'fulfilled').length,
        0,
      );
      assert.equal(await readFile(ownerPath(path), 'utf8'), original);
    });
  },
);

test(
  'a lock file that cannot be read is never treated as absent',
  { skip: !canObserveUnlinkFailure },
  async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, 'r.lock');
      await writeRecord(path, STALE);
      // A record owned by another user reads as a permission error. Treating
      // that as "no lock" would hand out a lock someone else is holding.
      await chmod(ownerPath(path), 0o000);

      await assert.rejects(acquireFileLock({ path, activeMessage: ACTIVE }), {
        message: /cannot be read as an Agent Bridge lock/,
      });
      assert.equal(await exists(ownerPath(path)), true);
    });
  },
);

test(
  'a hard-linked owner record is refused and neither name is rewritten',
  { skip: !canObserveLinks },
  async () => {
    await withDirectory(async (directory) => {
      const other = join(directory, 'also-here');
      const path = join(directory, 'r.lock');
      const original = `${JSON.stringify(STALE)}\n`;
      await seedLockText(path, original);
      // A second name for the record. Taking the lock over rewrites the record
      // in place, which would rewrite that file too.
      await link(ownerPath(path), other);

      await assert.rejects(acquireFileLock({ path, activeMessage: ACTIVE }), {
        message: /not a plain directory holding a plain record/,
      });

      assert.equal(await readFile(ownerPath(path), 'utf8'), original);
      assert.equal(await readFile(other, 'utf8'), original);
    });
  },
);

test('a record write that reports partial progress still writes every byte', async () => {
  const chunks: Array<{ offset: number; length: number; position: number }> =
    [];
  const collected = Buffer.alloc(64);
  await writeWholeRecord(
    {
      write: (buffer, offset, length, position) => {
        // One byte at a time, which is what a short write looks like.
        chunks.push({ offset, length, position });
        collected[position] = buffer[offset] as number;
        return Promise.resolve({ bytesWritten: 1 });
      },
    },
    'record',
  );

  assert.equal(collected.subarray(0, 6).toString('utf8'), 'record');
  assert.equal(chunks.length, 6);
  assert.deepEqual(chunks[5], { offset: 5, length: 1, position: 5 });
});

test('a record write that never progresses fails instead of claiming success', async () => {
  await assert.rejects(
    writeWholeRecord(
      { write: () => Promise.resolve({ bytesWritten: 0 }) },
      'r',
    ),
    /Wrote no bytes/,
  );
});

test(
  'a takeover that cannot even be attempted surfaces the reason',
  { skip: !canObserveUnlinkFailure },
  async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, 'r.lock');
      await writeRecord(path, STALE);
      // A lock that cannot be written to cannot hold the takeover marker
      // either. That is an environment fault, not contention, and it is
      // reported as itself rather than as a held lock.
      await chmod(path, 0o500);
      try {
        await assert.rejects(acquireFileLock({ path, activeMessage: ACTIVE }), {
          code: 'EACCES',
        });
        assert.equal((await record(path)).token, 'departed');
      } finally {
        await chmod(path, 0o700);
      }
    });
  },
);

test(
  'a failed release can be retried once its cause is fixed',
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
      // Marking the lock released before the unlink succeeded made this second
      // call a no-op, which left the lock file behind for good.
      assert.equal(await exists(path), true);

      await lock.release();
      assert.equal(await exists(path), false);
    });
  },
);

test('release leaves a lock whose record became unreadable', async () => {
  await withDirectory(async (directory) => {
    const path = join(directory, 'r.lock');
    const lock = await acquireFileLock({ path, activeMessage: ACTIVE });
    await writeFile(ownerPath(path), 'corrupted', { mode: 0o600 });

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
    await writeRecord(path, {
      pid: 999_999,
      host: hostname(),
      token: 'x'.repeat(20_000),
      createdAt: new Date().toISOString(),
    });

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

// A dangling symlink occupies the path without resolving to anything. This is
// the case the Windows CI job caught: creating the lock as a file resolved the
// link and created its target, so acquisition succeeded and no rejection came.
// Creating it as a directory fails on the existing name instead.
test(
  'a lock path that is occupied but resolves to nothing is refused, not spun on',
  { skip: !canObserveLinks },
  async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, 'r.lock');
      await symlink(join(directory, 'no-such-target'), path);

      await assert.rejects(
        acquireFileLock({ path, activeMessage: ACTIVE }),
        (error: Error) => {
          assert.ok(error.message.startsWith(ACTIVE));
          assert.match(error.message, /not a plain directory/);
          assert.ok(error.message.includes(path));
          return true;
        },
      );
      assert.equal(await exists(path), false);
      assert.equal((await lstat(path)).isSymbolicLink(), true);
    });
  },
);

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
