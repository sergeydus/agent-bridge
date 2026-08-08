import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ProcessAbortError } from '../src/process.ts';

import {
  assertProvidersAvailable,
  CLAUDE_MINIMUM_VERSION,
  CLAUDE_OPTIONAL_FLAGS,
  CLAUDE_REQUIRED_FLAGS,
  CLAUDE_REQUIRED_HIDDEN_FLAGS,
  ClaudeProvider,
  claudeArguments,
  CODEX_REQUIRED_FLAGS,
  codexArguments,
  CodexProvider,
  meetsMinimumVersion,
  parseAdvertisedFlags,
  probeSupportedFlags,
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

const ALL_CLAUDE_FLAGS = new Set<string>(['--safe-mode', '--ax-screen-reader']);

/** Tests must never depend on a real provider CLI being installed. */
function claudeProvider(
  flags: ReadonlySet<string> = ALL_CLAUDE_FLAGS,
): ClaudeProvider {
  return new ClaudeProvider(async () => flags);
}

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
  const claude = await claudeProvider().run('task', dryRunOptions);
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
  const claude = await claudeProvider().run('task', dryRunOptions);
  assert.match(codex.text, /--sandbox workspace-write/);
  assert.match(claude.text, /--permission-mode acceptEdits/);

  const readOnly = { ...dryRunOptions, writeAccess: false };
  const codexReadOnly = await new CodexProvider().run('task', readOnly);
  const claudeReadOnly = await claudeProvider().run('task', readOnly);
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
    for (const provider of [new CodexProvider(), claudeProvider()]) {
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

test('Claude uses optional flags exactly when its CLI advertises them', () => {
  const requested = { ...dryRunOptions, screenReader: true };
  const withFlags = claudeArguments(requested, ALL_CLAUDE_FLAGS);
  assert.ok(withFlags.includes('--safe-mode'));
  assert.ok(withFlags.includes('--ax-screen-reader'));

  // An older CLI rejects unknown flags outright, aborting the whole call.
  const withoutFlags = claudeArguments(requested, new Set(['--print']));
  assert.ok(!withoutFlags.includes('--safe-mode'));
  assert.ok(!withoutFlags.includes('--ax-screen-reader'));
  assert.ok(withoutFlags.includes('acceptEdits'));
});

/** Flags emitted only when the project or the user asks for them. */
const CODEX_CONDITIONAL_FLAGS = [
  '--skip-git-repo-check',
  '--config',
  '--model',
];
const CLAUDE_CONDITIONAL_FLAGS = ['--model', '--effort'];

function emittedFlags(args: readonly string[]): Set<string> {
  return new Set(args.filter((value) => value.startsWith('--')));
}

test('the Claude flags doctor requires match the flags the adapter emits', () => {
  // Forward: everything declared must really be emitted.
  const emitted = emittedFlags(
    claudeArguments(dryRunOptions, ALL_CLAUDE_FLAGS),
  );
  for (const flag of [
    ...CLAUDE_REQUIRED_FLAGS,
    ...CLAUDE_REQUIRED_HIDDEN_FLAGS,
  ]) {
    assert.ok(emitted.has(flag), `${flag} is declared but never emitted`);
  }

  // Reverse: a newly emitted flag must be declared somewhere, or doctor would
  // silently stop covering a dependency the adapter now relies on.
  const accountedFor = new Set<string>([
    ...CLAUDE_REQUIRED_FLAGS,
    ...CLAUDE_REQUIRED_HIDDEN_FLAGS,
    ...Object.values(CLAUDE_OPTIONAL_FLAGS),
    ...CLAUDE_CONDITIONAL_FLAGS,
  ]);
  const everyClaudeFlag = emittedFlags(
    claudeArguments(
      { ...dryRunOptions, model: 'test-model', effort: 'high' },
      ALL_CLAUDE_FLAGS,
    ),
  );
  for (const flag of everyClaudeFlag) {
    assert.ok(accountedFor.has(flag), `${flag} is emitted but undeclared`);
  }

  // A required flag must not also be optional; that would gate a dependency.
  for (const optional of Object.values(CLAUDE_OPTIONAL_FLAGS)) {
    assert.ok(
      !accountedForAsRequired(optional),
      `${optional} cannot be both required and capability-gated`,
    );
  }
});

function accountedForAsRequired(flag: string): boolean {
  return (
    (CLAUDE_REQUIRED_FLAGS as readonly string[]).includes(flag) ||
    (CLAUDE_REQUIRED_HIDDEN_FLAGS as readonly string[]).includes(flag)
  );
}

test('the Codex flags doctor requires match the flags the adapter emits', () => {
  const paths = { outputPath: '/tmp/out.txt', schemaPath: '/tmp/schema.json' };
  const emitted = emittedFlags(
    codexArguments(
      { ...dryRunOptions, platform: 'linux', isGitRepository: true },
      paths,
    ),
  );
  for (const flag of CODEX_REQUIRED_FLAGS) {
    assert.ok(emitted.has(flag), `${flag} is declared but never emitted`);
  }

  const accountedFor = new Set<string>([
    ...CODEX_REQUIRED_FLAGS,
    ...CODEX_CONDITIONAL_FLAGS,
  ]);
  // Every conditional path at once, so a new flag cannot hide behind a branch.
  const everyCodexFlag = emittedFlags(
    codexArguments(
      {
        ...dryRunOptions,
        platform: 'win32',
        isGitRepository: false,
        model: 'test-model',
        effort: 'high',
      },
      paths,
    ),
  );
  for (const flag of everyCodexFlag) {
    assert.ok(accountedFor.has(flag), `${flag} is emitted but undeclared`);
  }
});

test('advertised flags come from declarations, matched as whole tokens', () => {
  const help = [
    'Options:',
    '  -p, --print                 Print mode',
    '  --json-schema <schema>      Use a schema',
    '  --tools <tools...>          Available tools',
    '  --permission-mode <mode>    Replaces the removed --old-permissions flag',
  ].join('\n');
  const advertised = parseAdvertisedFlags(help);
  assert.ok(advertised.has('--print'));
  assert.ok(advertised.has('--json-schema'));
  assert.ok(advertised.has('--tools'));
  assert.ok(advertised.has('--permission-mode'));

  // Substring matching would wrongly accept these.
  assert.ok(!advertised.has('--json'));
  assert.ok(!advertised.has('--tool'));
  // A flag named inside another option's description is a mention, not an
  // offer: a removed option must not look supported because prose cites it.
  assert.ok(!advertised.has('--old-permissions'));
});

test('the tested Claude version floor stands in for hidden flag detection', () => {
  assert.equal(
    meetsMinimumVersion('2.1.74 (Claude Code)', CLAUDE_MINIMUM_VERSION),
    true,
  );
  assert.equal(meetsMinimumVersion('2.0.0', CLAUDE_MINIMUM_VERSION), true);
  assert.equal(meetsMinimumVersion('1.9.99', CLAUDE_MINIMUM_VERSION), false);
  assert.equal(meetsMinimumVersion('10.0.0', CLAUDE_MINIMUM_VERSION), true);
  // An unreadable version is reported as unknown, never as a silent pass.
  assert.equal(
    meetsMinimumVersion('unknown build', CLAUDE_MINIMUM_VERSION),
    undefined,
  );
});

test('hidden required flags are never capability-gated', () => {
  // Claude Code implements --max-turns but omits it from --help, so a help
  // probe can never confirm it. Gating on the probe would drop the turn bound.
  const withoutAnyAdvertisedFlags = claudeArguments(
    dryRunOptions,
    new Set<string>(),
  );
  for (const flag of CLAUDE_REQUIRED_HIDDEN_FLAGS) {
    assert.ok(withoutAnyAdvertisedFlags.includes(flag));
  }
});

test('Claude separates tool availability from tool permission', () => {
  // --tools selects which built-in tools exist; --allowedTools is the
  // allow-without-prompting list. Both are needed, and neither may allow Bash.
  const args = claudeArguments(dryRunOptions, ALL_CLAUDE_FLAGS);
  const valueAfter = (flag: string): string | undefined =>
    args[args.indexOf(flag) + 1];
  assert.ok(args.includes('--tools'));
  assert.ok(args.includes('--allowedTools'));
  assert.equal(valueAfter('--tools'), 'Read,Glob,Grep,Edit,Write');
  assert.equal(valueAfter('--allowedTools'), 'Read,Glob,Grep,Edit,Write');

  const readOnly = claudeArguments(
    { ...dryRunOptions, writeAccess: false },
    ALL_CLAUDE_FLAGS,
  );
  const readOnlyValueAfter = (flag: string): string | undefined =>
    readOnly[readOnly.indexOf(flag) + 1];
  assert.equal(readOnlyValueAfter('--tools'), 'Read,Glob,Grep');
  assert.equal(readOnlyValueAfter('--allowedTools'), 'Read,Glob,Grep');
});

test('Claude asks for the native accessible renderer only when requested', () => {
  const quiet = claudeArguments(
    { ...dryRunOptions, screenReader: false },
    ALL_CLAUDE_FLAGS,
  );
  assert.ok(!quiet.includes('--ax-screen-reader'));
  assert.ok(quiet.includes('--safe-mode'));
});

test('Claude probes its CLI once and reuses the result', async () => {
  let probes = 0;
  const provider = new ClaudeProvider(async () => {
    probes += 1;
    return new Set(['--safe-mode']);
  });
  assert.deepEqual(await provider.supportedFlags(), new Set(['--safe-mode']));
  assert.deepEqual(await provider.supportedFlags(), new Set(['--safe-mode']));
  assert.equal(probes, 1);
});

test('a dry run never launches the provider CLI', async () => {
  let probes = 0;
  const provider = new ClaudeProvider(async () => {
    probes += 1;
    return ALL_CLAUDE_FLAGS;
  });
  const command = await provider.run('task', dryRunOptions);

  assert.equal(probes, 0);
  assert.match(command.text, /--permission-mode acceptEdits/);
  assert.doesNotMatch(command.text, /--safe-mode/);
});

test('an unreadable provider CLI omits optional flags instead of failing', async () => {
  assert.deepEqual(
    await probeSupportedFlags('agent-bridge-missing-command-probe'),
    new Set(),
  );
});

test('reads advertised flags from a CLI help listing', async () => {
  const flags = await probeSupportedFlags(process.execPath, [
    '-e',
    'console.error("  --safe-mode  Start with all customizations disabled")',
  ]);
  assert.ok(flags.has('--safe-mode'));
  assert.ok(!flags.has('--ax-screen-reader'));
});

test('Codex removes its per-call scratch files however the call ends', async () => {
  const outcomes = ['success', 'failure', 'cancellation'] as const;
  for (const outcome of outcomes) {
    const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-codex-'));
    try {
      const provider = new CodexProvider(async (_command, args) => {
        // Codex writes its last message to the path it was given.
        const outputPath = args[args.indexOf('--output-last-message') + 1];
        assert.ok(outputPath);
        await writeFile(
          outputPath,
          JSON.stringify({ decision: 'done', text: 'finished' }),
        );
        if (outcome === 'failure') {
          throw new Error('codex exited with 1');
        }
        if (outcome === 'cancellation') {
          throw new ProcessAbortError();
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      });
      const run = provider.run('task', {
        ...dryRunOptions,
        dryRun: false,
        tempDirectory: directory,
      });

      if (outcome === 'success') {
        // Cleanup must not run before the response has been read.
        assert.deepEqual(await run, { text: 'finished', decision: 'done' });
      } else {
        await assert.rejects(run);
      }
      assert.deepEqual(
        await readdir(directory),
        [],
        `${outcome} left scratch files behind`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('a Codex dry run creates no scratch files at all', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-codex-dry-'));
  try {
    await new CodexProvider().run('task', {
      ...dryRunOptions,
      tempDirectory: directory,
    });
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
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
