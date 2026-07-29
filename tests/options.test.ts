import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { parseArgs } from '../src/options.ts';

test('parses portable project and workflow options', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-options-'));
  try {
    const options = parseArgs(
      [
        '--cwd',
        directory,
        '--collaborative',
        'claude',
        '--max-rounds',
        '8',
        '--timeout-minutes',
        '45',
      ],
      { initialCwd: '/', defaultOutput: join(directory, 'runs') },
    );

    assert.equal(options.cwd, resolve(directory));
    assert.equal(options.cwdExplicit, true);
    assert.equal(options.collaborative, 'claude');
    assert.equal(options.untilAgreement, true);
    assert.equal(options.maxRounds, 8);
    assert.equal(options.timeoutMinutes, 45);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects conflicting roles, unknown options, and unsafe limits', () => {
  assert.throws(
    () =>
      parseArgs(['--implementer', 'codex', '--collaborative', 'claude'], {
        initialCwd: '/',
        defaultOutput: '/tmp/runs',
      }),
    /either --implementer or --collaborative/,
  );
  assert.throws(
    () =>
      parseArgs(['--unknown'], {
        initialCwd: '/',
        defaultOutput: '/tmp/runs',
      }),
    /Unknown argument/,
  );
  assert.throws(
    () =>
      parseArgs(['--timeout-minutes', '0'], {
        initialCwd: '/',
        defaultOutput: '/tmp/runs',
      }),
    /integer from 1 to 180/,
  );
});

test('parses chat mode and keeps editing roles inside the interactive session', () => {
  const options = parseArgs(['chat', '--resume', 'latest', '--list-chats'], {
    initialCwd: '/',
    defaultOutput: '/tmp/runs',
  });
  assert.equal(options.chat, true);
  assert.equal(options.resume, 'latest');
  assert.equal(options.listChats, true);

  assert.throws(
    () =>
      parseArgs(['chat', '--implementer', 'codex'], {
        initialCwd: '/',
        defaultOutput: '/tmp/runs',
      }),
    /inside chat/,
  );
  assert.throws(
    () =>
      parseArgs(['chat', '--no-isolation'], {
        initialCwd: '/',
        defaultOutput: '/tmp/runs',
      }),
    /always uses the isolated workflow/,
  );
});
