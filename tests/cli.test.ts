import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bridgeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('collaborative dry run plans read-only and alternates write access', () => {
  const repository = mkdtempSync(`${tmpdir()}/agent-bridge-cli-`);
  const bridgeHome = mkdtempSync(`${tmpdir()}/agent-bridge-home-`);
  try {
    const git = spawnSync('git', ['init', repository], { encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);

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
    assert.equal(
      spawnSync('git', ['init', repository], { encoding: 'utf8' }).status,
      0,
    );
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

test('editing refuses to place run artifacts inside the target project', () => {
  const repository = mkdtempSync(`${tmpdir()}/agent-bridge-cli-output-`);
  try {
    assert.equal(
      spawnSync('git', ['init', repository], { encoding: 'utf8' }).status,
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
