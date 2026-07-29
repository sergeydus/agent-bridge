import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ClaudeProvider,
  CodexProvider,
  runProviderWithRetry,
  type AgentProvider,
  type ProviderRunOptions,
} from '../src/providers.ts';

const dryRunOptions: ProviderRunOptions = {
  cwd: '/tmp',
  tempDirectory: '/tmp',
  writeAccess: true,
  verbose: false,
  dryRun: true,
  timeoutMs: 1_000,
  responseKind: 'turn',
  isGitRepository: false,
};

test('provider commands require structured output and keep Claude shell-free', async () => {
  const codex = await new CodexProvider().run('task', dryRunOptions);
  const claude = await new ClaudeProvider().run('task', dryRunOptions);
  assert.match(codex.text, /--output-schema/);
  assert.match(codex.text, /--skip-git-repo-check/);
  assert.match(claude.text, /--json-schema/);
  assert.doesNotMatch(claude.text, /Bash/);
  assert.equal(codex.decision, 'continue');
  assert.equal(claude.decision, 'continue');
});

test('retries transient read-only provider failures through the provider interface', async () => {
  let calls = 0;
  const provider: AgentProvider = {
    name: 'codex',
    label: 'Fake Codex',
    version: async () => ({ stdout: 'fake', stderr: '', exitCode: 0 }),
    authStatus: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    run: async (_prompt: string, _options: ProviderRunOptions) => {
      calls += 1;
      if (calls === 1) {
        throw new Error('503 temporarily unavailable');
      }
      return { text: 'done', decision: 'done' };
    },
  };
  const delays: number[] = [];

  const result = await runProviderWithRetry({
    provider,
    prompt: 'test',
    options: {
      cwd: '/tmp',
      tempDirectory: '/tmp',
      writeAccess: false,
      verbose: false,
      dryRun: false,
      timeoutMs: 1_000,
      responseKind: 'turn',
      isGitRepository: true,
    },
    retries: 1,
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });

  assert.deepEqual(result, { text: 'done', decision: 'done' });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [1_000]);
});

test('never retries a write provider after a possibly partial edit', async () => {
  let calls = 0;
  const provider: AgentProvider = {
    name: 'claude',
    label: 'Fake Claude',
    version: async () => ({ stdout: 'fake', stderr: '', exitCode: 0 }),
    authStatus: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    run: async () => {
      calls += 1;
      throw new Error('503 temporarily unavailable');
    },
  };

  await assert.rejects(() =>
    runProviderWithRetry({
      provider,
      prompt: 'test',
      options: {
        cwd: '/tmp',
        tempDirectory: '/tmp',
        writeAccess: true,
        verbose: false,
        dryRun: false,
        timeoutMs: 1_000,
        responseKind: 'turn',
        isGitRepository: true,
      },
      retries: 3,
    }),
  );
  assert.equal(calls, 1);
});
