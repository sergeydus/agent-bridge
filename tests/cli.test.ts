import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { getAppPaths } from '../src/paths.ts';
import { RunStateStore, type SavedRun } from '../src/state.ts';

const bridgeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function initializeCommittedRepository(repository: string): void {
  const commands = [
    ['init'],
    ['config', 'user.name', 'Agent Bridge Test'],
    ['config', 'user.email', 'test@example.com'],
  ];
  for (const args of commands) {
    const result = spawnSync('git', args, {
      cwd: repository,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  }
  writeFileSync(resolve(repository, 'initial.txt'), 'initial\n');
  for (const args of [
    ['add', 'initial.txt'],
    ['commit', '-m', 'initial'],
  ]) {
    const result = spawnSync('git', args, {
      cwd: repository,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  }
}

test('collaborative dry run plans read-only and alternates write access', () => {
  const repository = mkdtempSync(`${tmpdir()}/agent-bridge-cli-`);
  const bridgeHome = mkdtempSync(`${tmpdir()}/agent-bridge-home-`);
  try {
    initializeCommittedRepository(repository);

    const result = spawnSync(
      process.execPath,
      [
        'bin/agent-bridge.mjs',
        '--task',
        'Implement a harmless test change',
        '--cwd',
        repository,
        '--collaborative',
        'claude',
        '--max-rounds',
        '2',
        '--dry-run',
        '--verbose',
      ],
      {
        cwd: bridgeRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          AGENT_BRIDGE_HOME: bridgeHome,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Planning round 1\/2/);
    assert.match(result.stdout, /--sandbox read-only/);
    assert.match(result.stdout, /--sandbox workspace-write/);
    assert.match(result.stdout, /Claude is editing/);
    assert.match(result.stdout, /Codex is editing/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
    rmSync(bridgeHome, { recursive: true, force: true });
  }
});

test('scripted isolated editing requires explicit acknowledgement of dirty HEAD', () => {
  const repository = mkdtempSync(`${tmpdir()}/agent-bridge-cli-dirty-`);
  const bridgeHome = mkdtempSync(`${tmpdir()}/agent-bridge-home-`);
  try {
    initializeCommittedRepository(repository);
    const dirtyPath = resolve(repository, 'uncommitted.txt');
    spawnSync(
      process.execPath,
      [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(dirtyPath)}, 'dirty')`,
      ],
      { encoding: 'utf8' },
    );
    const baseArguments = [
      'bin/agent-bridge.mjs',
      '--task',
      'Implement safely',
      '--cwd',
      repository,
      '--implementer',
      'codex',
      '--max-rounds',
      '2',
      '--dry-run',
    ];
    const rejected = spawnSync(process.execPath, baseArguments, {
      cwd: bridgeRoot,
      encoding: 'utf8',
      env: { ...process.env, AGENT_BRIDGE_HOME: bridgeHome },
    });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /--from-head/);

    const accepted = spawnSync(
      process.execPath,
      [...baseArguments, '--from-head'],
      {
        cwd: bridgeRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          AGENT_BRIDGE_HOME: bridgeHome,
        },
      },
    );
    assert.equal(accepted.status, 0, accepted.stderr);
  } finally {
    rmSync(repository, { recursive: true, force: true });
    rmSync(bridgeHome, { recursive: true, force: true });
  }
});

test('review-only dry run supports an ordinary non-Git directory', () => {
  const directory = mkdtempSync(`${tmpdir()}/agent-bridge-cli-directory-`);
  try {
    const result = spawnSync(
      process.execPath,
      [
        'bin/agent-bridge.mjs',
        '--task',
        'Review this folder',
        '--cwd',
        directory,
        '--rounds',
        '1',
        '--dry-run',
        '--verbose',
      ],
      {
        cwd: bridgeRoot,
        encoding: 'utf8',
        env: { ...process.env, AGENT_BRIDGE_HOME: `${directory}/.bridge-data` },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--skip-git-repo-check/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('review-only dry run supports a Git repository without commits', () => {
  const repository = mkdtempSync(`${tmpdir()}/agent-bridge-cli-unborn-review-`);
  try {
    assert.equal(
      spawnSync('git', ['init'], {
        cwd: repository,
        encoding: 'utf8',
      }).status,
      0,
    );
    const result = spawnSync(
      process.execPath,
      [
        'bin/agent-bridge.mjs',
        '--task',
        'Review this new project',
        '--cwd',
        repository,
        '--rounds',
        '1',
        '--dry-run',
      ],
      {
        cwd: bridgeRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          AGENT_BRIDGE_HOME: `${repository}/.bridge-data`,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('editing explains that a Git repository needs an initial commit', () => {
  const repository = mkdtempSync(`${tmpdir()}/agent-bridge-cli-unborn-edit-`);
  try {
    assert.equal(
      spawnSync('git', ['init'], {
        cwd: repository,
        encoding: 'utf8',
      }).status,
      0,
    );
    const result = spawnSync(
      process.execPath,
      [
        'bin/agent-bridge.mjs',
        '--task',
        'Implement safely',
        '--cwd',
        repository,
        '--implementer',
        'codex',
        '--dry-run',
      ],
      { cwd: bridgeRoot, encoding: 'utf8' },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires an initial commit/);
    assert.match(result.stderr, /will not stage or commit/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('editing refuses to place run artifacts inside the target project', () => {
  const repository = mkdtempSync(`${tmpdir()}/agent-bridge-cli-output-`);
  try {
    initializeCommittedRepository(repository);
    const result = spawnSync(
      process.execPath,
      [
        'bin/agent-bridge.mjs',
        '--task',
        'Implement safely',
        '--cwd',
        repository,
        '--implementer',
        'codex',
        '--output',
        resolve(repository, 'bridge-output'),
        '--dry-run',
      ],
      { cwd: bridgeRoot, encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--output must be outside/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('compiled CLI exposes chat management without calling providers', () => {
  const bridgeHome = mkdtempSync(`${tmpdir()}/agent-bridge-home-`);
  try {
    const result = spawnSync(
      process.execPath,
      ['bin/agent-bridge.mjs', 'chat', '--list-chats'],
      {
        cwd: bridgeRoot,
        encoding: 'utf8',
        env: { ...process.env, AGENT_BRIDGE_HOME: bridgeHome },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No saved Agent Bridge chats/);
  } finally {
    rmSync(bridgeHome, { recursive: true, force: true });
  }
});

test('redirected chat input pauses cleanly at end of input', () => {
  const directory = mkdtempSync(`${tmpdir()}/agent-bridge-chat-script-`);
  const bridgeHome = mkdtempSync(`${tmpdir()}/agent-bridge-home-`);
  try {
    const result = spawnSync(
      process.execPath,
      [
        'bin/agent-bridge.mjs',
        'chat',
        '--cwd',
        directory,
        '--ui',
        'plain',
        '--no-color',
      ],
      {
        cwd: bridgeRoot,
        encoding: 'utf8',
        input: '',
        env: { ...process.env, AGENT_BRIDGE_HOME: bridgeHome },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Chat saved\. Resume with:/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(bridgeHome, { recursive: true, force: true });
  }
});

test('a failed run-lock acquisition does not overwrite the active owner state', async () => {
  const directory = mkdtempSync(`${tmpdir()}/agent-bridge-lock-project-`);
  const bridgeHome = mkdtempSync(`${tmpdir()}/agent-bridge-home-`);
  const paths = getAppPaths({ env: { AGENT_BRIDGE_HOME: bridgeHome } });
  const store = new RunStateStore(paths.stateDirectory);
  const now = new Date().toISOString();
  const savedRun: SavedRun = {
    version: 2,
    id: 'run-20260730-active123',
    createdAt: now,
    updatedAt: now,
    status: 'reviewing',
    task: 'Review without overwriting the owner.',
    originalCwd: directory,
    agentCwd: directory,
    projectKind: 'directory',
    outputDirectory: paths.runsDirectory,
    workflow: { kind: 'review', maxRounds: 1 },
    judge: 'codex',
    retries: 0,
    timeoutMinutes: 1,
    untilAgreement: false,
    requireAgreement: false,
    noTranscript: false,
    verification: [],
    protectedPaths: [],
    protectedPathFingerprints: {},
    completedCycles: 0,
    codexPrevious: '',
    claudePrevious: '',
    handoff: '',
    converged: false,
    rounds: [],
  };
  let lock: Awaited<ReturnType<RunStateStore['acquireLock']>> | undefined;
  try {
    await store.save(savedRun);
    const persistedBeforeResume = await store.load(savedRun.id);
    lock = await store.acquireLock(savedRun.id);
    const result = spawnSync(
      process.execPath,
      ['bin/agent-bridge.mjs', '--resume', savedRun.id],
      {
        cwd: bridgeRoot,
        encoding: 'utf8',
        env: { ...process.env, AGENT_BRIDGE_HOME: bridgeHome },
      },
    );

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /already active in another Agent Bridge process/,
    );
    assert.deepEqual(await store.load(savedRun.id), persistedBeforeResume);

    const deletion = spawnSync(
      process.execPath,
      ['bin/agent-bridge.mjs', '--delete-run', savedRun.id],
      {
        cwd: bridgeRoot,
        encoding: 'utf8',
        env: { ...process.env, AGENT_BRIDGE_HOME: bridgeHome },
      },
    );
    assert.equal(deletion.status, 1);
    assert.match(
      deletion.stderr,
      /already active in another Agent Bridge process/,
    );
    assert.deepEqual(await store.load(savedRun.id), persistedBeforeResume);
  } finally {
    await lock?.release();
    rmSync(directory, { recursive: true, force: true });
    rmSync(bridgeHome, { recursive: true, force: true });
  }
});
