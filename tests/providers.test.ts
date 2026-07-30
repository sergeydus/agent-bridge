import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertProvidersAvailable,
  ClaudeProvider,
  CodexProvider,
  ProviderAvailabilityError,
  runProviderWithRetry,
  type AgentProvider,
  type ProviderMap,
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
  screenReader: false,
};

function fakeProvider(
  name: 'codex' | 'claude',
  version: AgentProvider['version'],
): AgentProvider {
  return {
    name,
    label: name === 'codex' ? 'Codex' : 'Claude',
    version,
    authStatus: async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }),
    run: async () => ({ text: 'done', decision: 'done' }),
  };
}

test('provider preflight succeeds when both CLIs can start', async () => {
  const providers: ProviderMap = {
    codex: fakeProvider('codex', async () => ({
      stdout: 'codex 1',
      stderr: '',
      exitCode: 0,
    })),
    claude: fakeProvider('claude', async () => ({
      stdout: 'claude 1',
      stderr: '',
      exitCode: 0,
    })),
  };

  await assertProvidersAvailable(providers);
});

test('provider preflight gives actionable diagnostics before agent work', async () => {
  const providers: ProviderMap = {
    codex: fakeProvider('codex', async () => ({
      stdout: 'codex 1',
      stderr: '',
      exitCode: 0,
    })),
    claude: fakeProvider('claude', async () => {
      throw new Error('spawn claude ENOENT');
    }),
  };

  await assert.rejects(
    () => assertProvidersAvailable(providers),
    (error: unknown) => {
      assert.ok(error instanceof ProviderAvailabilityError);
      assert.match(error.message, /Claude: spawn claude ENOENT/);
      assert.match(error.message, /claude --version/);
      assert.match(error.message, /agent-bridge --doctor/);
      return true;
    },
  );
});

test('provider commands require structured output and keep Claude shell-free', async () => {
  const codex = await new CodexProvider().run('task', dryRunOptions);
  const claude = await new ClaudeProvider().run('task', dryRunOptions);
  assert.match(codex.text, /--output-schema/);
  assert.match(codex.text, /--json/);
  assert.match(codex.text, /--skip-git-repo-check/);
  assert.match(claude.text, /--json-schema/);
  assert.match(claude.text, /--output-format stream-json/);
  assert.match(claude.text, /--include-partial-messages/);
  assert.match(claude.text, /--verbose/);
  assert.doesNotMatch(claude.text, /Bash/);
  assert.equal(codex.decision, 'continue');
  assert.equal(claude.decision, 'continue');
});

test('write turns request write permission from both providers', async () => {
  const codex = await new CodexProvider().run('task', dryRunOptions);
  const claude = await new ClaudeProvider().run('task', dryRunOptions);
  assert.match(codex.text, /--sandbox workspace-write/);
  assert.match(claude.text, /--permission-mode acceptEdits/);

  const readOnly = { ...dryRunOptions, writeAccess: false };
  const codexReadOnly = await new CodexProvider().run('task', readOnly);
  const claudeReadOnly = await new ClaudeProvider().run('task', readOnly);
  assert.match(codexReadOnly.text, /--sandbox read-only/);
  assert.match(claudeReadOnly.text, /--permission-mode plan/);
});

test('Codex enables its Windows sandbox despite ignoring user config', async () => {
  const windows = await new CodexProvider().run('task', {
    ...dryRunOptions,
    platform: 'win32',
  });
  assert.match(windows.text, /--ignore-user-config/);
  assert.match(windows.text, /--config windows\.sandbox="unelevated"/);

  const linux = await new CodexProvider().run('task', {
    ...dryRunOptions,
    platform: 'linux',
  });
  assert.doesNotMatch(linux.text, /windows\.sandbox/);
});

test('provider arguments survive Windows command shims', async () => {
  for (const writeAccess of [true, false]) {
    for (const provider of [new CodexProvider(), new ClaudeProvider()]) {
      const command = await provider.run('task', {
        ...dryRunOptions,
        writeAccess,
        platform: 'win32',
        model: 'test-model',
        effort: 'high',
      });
      const args = command.text.replace(/^\[dry-run] \w+ /, '');
      assert.doesNotMatch(
        args,
        /[\r\n]/,
        `${provider.name} passes a multi-line argument, which Windows truncates`,
      );
    }
  }
});

test('Claude is launched only with flags its CLI accepts', async () => {
  const claude = await new ClaudeProvider().run('task', dryRunOptions);
  assert.doesNotMatch(claude.text, /--safe-mode/);
});

test('accessible presentation stays a coordinator concern', async () => {
  // Neither CLI has an accessibility flag; inventing one aborts every call.
  for (const provider of [new CodexProvider(), new ClaudeProvider()]) {
    const command = await provider.run('task', {
      ...dryRunOptions,
      screenReader: true,
    });
    assert.doesNotMatch(command.text, /screen-reader/);
  }
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
      screenReader: false,
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
        screenReader: false,
      },
      retries: 3,
    }),
  );
  assert.equal(calls, 1);
});
