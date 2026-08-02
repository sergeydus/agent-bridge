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
        '--max-auto-rounds',
        '4',
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
    assert.equal(options.maxAutoRounds, 4);
    assert.equal(options.timeoutMinutes, 45);
    assert.equal(options.ui, 'auto');
    assert.equal(options.uiExplicit, false);
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

test('parses accessible presentation and validates model names', () => {
  const temporaryDirectory = tmpdir();
  const options = parseArgs(
    [
      'chat',
      '--screen-reader',
      '--codex-model',
      'codex-test',
      '--claude-model',
      'claude-test',
    ],
    {
      initialCwd: temporaryDirectory,
      defaultOutput: join(temporaryDirectory, 'runs'),
    },
  );
  assert.equal(options.screenReader, true);
  assert.equal(options.screenReaderExplicit, true);
  assert.equal(options.noColor, true);
  assert.equal(options.codexModel, 'codex-test');
  assert.equal(options.claudeModel, 'claude-test');

  assert.throws(
    () =>
      parseArgs(['--codex-model', 'invalid model'], {
        initialCwd: temporaryDirectory,
        defaultOutput: join(temporaryDirectory, 'runs'),
      }),
    /without spaces/,
  );

  const enhanced = parseArgs(['chat', '--ui', 'enhanced'], {
    initialCwd: temporaryDirectory,
    defaultOutput: join(temporaryDirectory, 'runs'),
  });
  assert.equal(enhanced.ui, 'enhanced');
  assert.equal(enhanced.uiExplicit, true);
  const wizardAuto = parseArgs(['--wizard', '--ui', 'auto'], {
    initialCwd: temporaryDirectory,
    defaultOutput: join(temporaryDirectory, 'runs'),
  });
  assert.equal(wizardAuto.wizard, true);
  assert.equal(wizardAuto.ui, 'auto');
  assert.equal(wizardAuto.uiExplicit, true);
  const explicitPlain = parseArgs(['--ui', 'plain'], {
    initialCwd: temporaryDirectory,
    defaultOutput: join(temporaryDirectory, 'runs'),
  });
  assert.equal(explicitPlain.ui, 'plain');
  assert.equal(explicitPlain.uiExplicit, true);
  assert.throws(
    () =>
      parseArgs(['chat', '--ui', 'unknown'], {
        initialCwd: temporaryDirectory,
        defaultOutput: join(temporaryDirectory, 'runs'),
      }),
    /plain, enhanced, or auto/,
  );
  assert.throws(
    () =>
      parseArgs(['--ui', 'enhanced'], {
        initialCwd: temporaryDirectory,
        defaultOutput: join(temporaryDirectory, 'runs'),
      }),
    /require chat mode/,
  );
});
