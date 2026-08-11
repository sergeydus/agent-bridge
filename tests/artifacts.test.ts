import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  createReadlineCompletionPrompt,
  createTerminalCompletionPrompt,
  finishIsolatedRun,
  patchApplicationRefusalReason,
  planWorkspaceRemoval,
  recordRunCompletion,
  type CompletionPrompt,
  type CompletionResult,
} from '../src/artifacts.ts';
import { createIsolatedWorktree, currentCommit, execute } from '../src/git.ts';
import { RunStateStore, type SavedRun } from '../src/state.ts';
import { ProgressReporter } from '../src/ui.ts';

/**
 * Records every question and replays scripted answers. `undefined` in the
 * script means the user declined to answer, which is what the real prompt
 * reports for end of input.
 */
function scriptedPrompt(answers: (string | undefined)[]): CompletionPrompt & {
  questions: string[];
  closed: number;
} {
  const questions: string[] = [];
  const prompt = {
    questions,
    closed: 0,
    ask(question: string): Promise<string | undefined> {
      questions.push(question);
      if (answers.length === 0) {
        throw new Error(`Unexpected completion question: ${question}`);
      }
      return Promise.resolve(answers.shift());
    },
    close(): void {
      prompt.closed += 1;
    },
  };
  return prompt;
}

interface Fixture {
  root: string;
  repository: string;
  workspace: string;
  patchPath: string;
  baseRevision: string;
  reporter: ProgressReporter;
}

async function withFixture(
  body: (fixture: Fixture) => Promise<void>,
  { edit = true }: { edit?: boolean } = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-artifacts-'));
  const repository = join(root, 'repository');
  try {
    await execute('git', ['init', repository], { cwd: root });
    const configuration: [string, string][] = [
      ['user.name', 'Agent Bridge Test'],
      ['user.email', 'test@example.com'],
      ['commit.gpgsign', 'false'],
    ];
    for (const [key, value] of configuration) {
      await execute('git', ['config', key, value], { cwd: repository });
    }
    await writeFile(join(repository, 'tracked.txt'), 'before\n');
    await execute('git', ['add', 'tracked.txt'], { cwd: repository });
    await execute('git', ['commit', '-m', 'initial'], { cwd: repository });

    const baseRevision = await currentCommit(repository);
    const workspace = await createIsolatedWorktree({
      repository,
      runsDirectory: join(root, 'runs'),
      runId: 'run',
      revision: baseRevision,
    });
    if (edit) {
      await writeFile(join(workspace, 'tracked.txt'), 'after\n');
    }
    await body({
      root,
      repository,
      workspace,
      patchPath: join(root, 'run.patch'),
      baseRevision,
      reporter: new ProgressReporter({ silent: true }),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
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

test('refuses to auto-apply legacy patches without a recorded base revision', async () => {
  assert.match(
    (await patchApplicationRefusalReason({
      repository: '/path/that/must/not/be-read',
      patchPath: '/path/that/must/not/be-read.patch',
    })) ?? '',
    /predates base-revision tracking/,
  );
});

test('keeps the workspace and asks nothing when the agents changed no files', async () => {
  await withFixture(
    async ({ repository, workspace, patchPath, baseRevision, reporter }) => {
      const prompt = scriptedPrompt([]);
      const result = await finishIsolatedRun({
        repository,
        workspace,
        patchPath,
        baseRevision,
        reporter,
        createPrompt: () => prompt,
      });

      assert.deepEqual(result, { outcome: 'no-changes', workspace });
      assert.deepEqual(prompt.questions, []);
      assert.equal(await exists(patchPath), false);
    },
    { edit: false },
  );
});

test('keeps the workspace without prompting when no prompt is available', async () => {
  await withFixture(
    async ({ repository, workspace, patchPath, baseRevision, reporter }) => {
      const result = await finishIsolatedRun({
        repository,
        workspace,
        patchPath,
        baseRevision,
        reporter,
        createPrompt: () => undefined,
      });

      assert.deepEqual(result, { outcome: 'kept', patchPath, workspace });
      assert.equal(await exists(patchPath), true);
      assert.equal(
        await readFile(join(repository, 'tracked.txt'), 'utf8'),
        'before\n',
      );
    },
  );
});

test('keeps both the patch and the workspace on the default choice', async () => {
  await withFixture(
    async ({ repository, workspace, patchPath, baseRevision, reporter }) => {
      const prompt = scriptedPrompt(['']);
      const result = await finishIsolatedRun({
        repository,
        workspace,
        patchPath,
        baseRevision,
        reporter,
        createPrompt: () => prompt,
      });

      assert.deepEqual(result, { outcome: 'kept', patchPath, workspace });
      assert.equal(prompt.questions.length, 1);
      assert.match(prompt.questions[0] ?? '', /Choose 1, 2, or 3 \[1\]: $/);
      assert.equal(prompt.closed, 1);
      assert.equal(
        await readFile(join(repository, 'tracked.txt'), 'utf8'),
        'before\n',
      );
    },
  );
});

test('a correction repeats only the choice line, never the whole menu', async () => {
  await withFixture(
    async ({ repository, workspace, patchPath, baseRevision, reporter }) => {
      const prompt = scriptedPrompt(['4', 'maybe', '1']);
      const result = await finishIsolatedRun({
        repository,
        workspace,
        patchPath,
        baseRevision,
        reporter,
        createPrompt: () => prompt,
      });

      assert.deepEqual(result, { outcome: 'kept', patchPath, workspace });
      assert.equal(prompt.questions.length, 3);
      assert.match(prompt.questions[0] ?? '', /^\nWhat should happen/);
      for (const question of prompt.questions.slice(1)) {
        assert.equal(
          question,
          'Please enter 1, 2, 3.\nChoose 1, 2, or 3 [1]: ',
        );
      }
    },
  );
});

test('applies the patch to the original checkout when asked', async () => {
  await withFixture(
    async ({ repository, workspace, patchPath, baseRevision, reporter }) => {
      const prompt = scriptedPrompt(['2']);
      const result = await finishIsolatedRun({
        repository,
        workspace,
        patchPath,
        baseRevision,
        reporter,
        createPrompt: () => prompt,
      });

      assert.deepEqual(result, {
        outcome: 'applied',
        patchPath,
        workspace,
        applied: true,
      });
      assert.equal(
        await readFile(join(repository, 'tracked.txt'), 'utf8'),
        'after\n',
      );
      assert.equal(await exists(workspace), true);
    },
  );
});

test('refuses to apply a patch for a run that recorded no base revision', async () => {
  await withFixture(
    async ({ repository, workspace, patchPath, baseRevision, reporter }) => {
      const prompt = scriptedPrompt(['2']);
      const result = await finishIsolatedRun({
        repository,
        workspace,
        patchPath,
        // A resumed legacy run: a patch can still be captured against a
        // derived baseline, but nothing may be applied on its authority.
        baseRevision: undefined,
        derivedBaseRevision: baseRevision,
        reporter,
        createPrompt: () => prompt,
      });

      assert.equal(result.outcome, 'apply-refused');
      assert.match(result.reason ?? '', /predates base-revision tracking/);
      assert.deepEqual(
        { patchPath: result.patchPath, workspace: result.workspace },
        { patchPath, workspace },
      );
      assert.equal(await exists(patchPath), true);
      assert.equal(
        await readFile(join(repository, 'tracked.txt'), 'utf8'),
        'before\n',
      );
    },
  );
});

test('refuses to apply when the original checkout moved to another commit', async () => {
  await withFixture(
    async ({ repository, workspace, patchPath, baseRevision, reporter }) => {
      await writeFile(join(repository, 'unrelated.txt'), 'moved on\n');
      await execute('git', ['add', 'unrelated.txt'], { cwd: repository });
      await execute('git', ['commit', '-m', 'second'], { cwd: repository });
      assert.notEqual(await currentCommit(repository), baseRevision);

      const prompt = scriptedPrompt(['2']);
      const result = await finishIsolatedRun({
        repository,
        workspace,
        patchPath,
        baseRevision,
        reporter,
        createPrompt: () => prompt,
      });

      assert.equal(result.outcome, 'apply-refused');
      assert.match(result.reason ?? '', /moved to a different commit/);
      assert.equal(
        await readFile(join(repository, 'tracked.txt'), 'utf8'),
        'before\n',
      );
    },
  );
});

test('refuses to apply a patch that conflicts with the original checkout', async () => {
  await withFixture(
    async ({ repository, workspace, patchPath, baseRevision, reporter }) => {
      await writeFile(join(repository, 'tracked.txt'), 'conflicting\n');

      const prompt = scriptedPrompt(['2']);
      const result = await finishIsolatedRun({
        repository,
        workspace,
        patchPath,
        baseRevision,
        reporter,
        createPrompt: () => prompt,
      });

      assert.equal(result.outcome, 'apply-refused');
      assert.match(result.reason ?? '', /conflicts with the original checkout/);
      assert.equal(
        await readFile(join(repository, 'tracked.txt'), 'utf8'),
        'conflicting\n',
      );
    },
  );
});

test('a rejected discard answer repeats the same short confirmation', async () => {
  await withFixture(
    async ({ repository, workspace, patchPath, baseRevision, reporter }) => {
      const prompt = scriptedPrompt(['3', 'maybe', 'n']);
      await finishIsolatedRun({
        repository,
        workspace,
        patchPath,
        baseRevision,
        reporter,
        createPrompt: () => prompt,
      });

      assert.equal(
        prompt.questions[2],
        'Please enter y, yes, n, no.\nDiscard this isolated workspace permanently? [y/N]: ',
      );
      assert.equal(await exists(workspace), true);
    },
  );
});

test('discards the workspace only after an explicit confirmation', async () => {
  await withFixture(
    async ({ repository, workspace, patchPath, baseRevision, reporter }) => {
      const prompt = scriptedPrompt(['3', 'y']);
      const result = await finishIsolatedRun({
        repository,
        workspace,
        patchPath,
        baseRevision,
        reporter,
        createPrompt: () => prompt,
      });

      assert.deepEqual(result, { outcome: 'discarded', patchPath });
      assert.equal(await exists(workspace), false);
      assert.equal(await exists(patchPath), true);
      assert.match(prompt.questions[1] ?? '', /permanently\? \[y\/N\]: $/);
    },
  );
});

test('keeps the workspace when the discard confirmation is declined', async () => {
  await withFixture(
    async ({ repository, workspace, patchPath, baseRevision, reporter }) => {
      const prompt = scriptedPrompt(['3', '']);
      const result = await finishIsolatedRun({
        repository,
        workspace,
        patchPath,
        baseRevision,
        reporter,
        createPrompt: () => prompt,
      });

      assert.deepEqual(result, { outcome: 'kept', patchPath, workspace });
      assert.equal(await exists(workspace), true);
    },
  );
});

test('keeps the workspace when the menu goes unanswered', async () => {
  await withFixture(
    async ({ repository, workspace, patchPath, baseRevision, reporter }) => {
      const prompt = scriptedPrompt([undefined]);
      const result = await finishIsolatedRun({
        repository,
        workspace,
        patchPath,
        baseRevision,
        reporter,
        createPrompt: () => prompt,
      });

      assert.deepEqual(result, { outcome: 'declined', patchPath, workspace });
      assert.equal(await exists(workspace), true);
      assert.equal(prompt.closed, 1);
    },
  );
});

test('keeps the workspace when the discard confirmation goes unanswered', async () => {
  await withFixture(
    async ({ repository, workspace, patchPath, baseRevision, reporter }) => {
      const prompt = scriptedPrompt(['3', undefined]);
      const result = await finishIsolatedRun({
        repository,
        workspace,
        patchPath,
        baseRevision,
        reporter,
        createPrompt: () => prompt,
      });

      assert.deepEqual(result, { outcome: 'declined', patchPath, workspace });
      assert.equal(await exists(workspace), true);
    },
  );
});

test('an unreadable checkout fails the apply instead of escaping the run', async () => {
  await withFixture(
    async ({ root, workspace, patchPath, baseRevision, reporter }) => {
      const prompt = scriptedPrompt(['2']);
      const result = await finishIsolatedRun({
        // The gates themselves cannot run against this path.
        repository: join(root, 'not-a-repository'),
        workspace,
        patchPath,
        baseRevision,
        reporter,
        createPrompt: () => prompt,
      });

      assert.equal(result.outcome, 'apply-failed');
      assert.match(result.reason ?? '', /could not be checked/);
      assert.equal(result.workspace, workspace);
      assert.equal(result.patchPath, patchPath);
      assert.equal(prompt.closed, 1);
    },
  );
});

test('no completion prompt is offered unless both streams are terminals', () => {
  const terminalInput = Object.assign(new PassThrough(), { isTTY: true });
  const terminalOutput = Object.assign(new PassThrough(), { isTTY: true });

  assert.equal(
    createTerminalCompletionPrompt({
      input: new PassThrough(),
      output: terminalOutput,
    }),
    undefined,
  );
  assert.equal(
    createTerminalCompletionPrompt({
      input: terminalInput,
      output: new PassThrough(),
    }),
    undefined,
  );

  const prompt = createTerminalCompletionPrompt({
    input: terminalInput,
    output: terminalOutput,
  });
  assert.notEqual(prompt, undefined);
  prompt?.close();
});

test('the readline prompt writes its question and returns the typed answer', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const written: string[] = [];
  output.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')));

  const prompt = createReadlineCompletionPrompt({ input, output });
  const answered = prompt.ask('Choose 1, 2, or 3 [1]: ');
  input.write('2\n');

  assert.equal(await answered, '2');
  assert.match(written.join(''), /Choose 1, 2, or 3 \[1\]: /);
  prompt.close();
});

test('reports an apply failure as an outcome instead of throwing', async () => {
  await withFixture(
    async ({ repository, workspace, patchPath, baseRevision, reporter }) => {
      const result = await finishIsolatedRun({
        repository,
        workspace,
        patchPath,
        baseRevision,
        reporter,
        createPrompt: () => scriptedPrompt(['2']),
        apply: () => Promise.reject(new Error('git apply exploded')),
      });

      assert.equal(result.outcome, 'apply-failed');
      assert.match(
        result.reason ?? '',
        /could not be applied: git apply exploded/,
      );
      assert.equal(result.workspace, workspace);
      assert.equal(await exists(patchPath), true);
    },
  );
});

test('reports a removal failure as an outcome and keeps the workspace', async () => {
  await withFixture(
    async ({ repository, workspace, patchPath, baseRevision, reporter }) => {
      const result = await finishIsolatedRun({
        repository,
        workspace,
        patchPath,
        baseRevision,
        reporter,
        createPrompt: () => scriptedPrompt(['3', 'y']),
        removeWorkspace: () => Promise.reject(new Error('worktree is locked')),
      });

      assert.equal(result.outcome, 'discard-failed');
      assert.match(
        result.reason ?? '',
        /could not be removed: worktree is locked/,
      );
      assert.equal(result.workspace, workspace);
      assert.equal(await exists(workspace), true);
    },
  );
});

test('reports a patch failure as an outcome and offers no menu', async () => {
  await withFixture(
    async ({ repository, workspace, patchPath, baseRevision, reporter }) => {
      const prompt = scriptedPrompt([]);
      const result = await finishIsolatedRun({
        repository,
        workspace,
        // A directory can never be written as a patch file.
        patchPath: workspace,
        baseRevision,
        reporter,
        createPrompt: () => prompt,
      });

      assert.equal(result.outcome, 'patch-failed');
      assert.notEqual(result.reason, undefined);
      assert.equal(result.workspace, workspace);
      assert.deepEqual(prompt.questions, []);
      assert.equal(await exists(patchPath), false);
    },
  );
});

test('every failure reason is storable in a checkpoint', async () => {
  await withFixture(
    async ({ repository, workspace, patchPath, baseRevision, reporter }) => {
      const result = await finishIsolatedRun({
        repository,
        workspace,
        patchPath,
        baseRevision,
        reporter,
        createPrompt: () => scriptedPrompt(['2']),
        apply: () =>
          Promise.reject(
            new Error(`git said \u001B[31m${'x'.repeat(4_000)}\u001B[0m`),
          ),
      });

      const reason = result.reason ?? '';
      assert.equal(reason.length <= 2_000, true);
      assert.equal(reason.includes('\u001B'), false);
    },
  );
});

test('the readline prompt reports end of input as no answer', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const prompt = createReadlineCompletionPrompt({ input, output });

  const answered = prompt.ask('Choose 1, 2, or 3 [1]: ');
  input.end();

  assert.equal(await answered, undefined);
  prompt.close();
});

test('the readline prompt reports an aborted question as no answer', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const prompt = createReadlineCompletionPrompt({ input, output });

  const answered = prompt.ask('Choose 1, 2, or 3 [1]: ');
  // What a real terminal delivers for Ctrl+D at a prompt.
  prompt.close();

  assert.equal(await answered, undefined);
});

test('marks the run complete before the completion step is allowed to run', async () => {
  const order: string[] = [];
  const reporter = new ProgressReporter({ silent: true });

  const result = await recordRunCompletion({
    markCompleted: () => {
      order.push('completed');
      return Promise.resolve();
    },
    finish: () => {
      order.push('finish');
      return Promise.resolve<CompletionResult>({ outcome: 'kept' });
    },
    recordOutcome: () => {
      order.push('record');
      return Promise.resolve();
    },
    reporter,
  });

  assert.deepEqual(order, ['completed', 'finish', 'record']);
  assert.equal(result?.outcome, 'kept');
});

test('marks a run with no isolated workspace complete and asks nothing further', async () => {
  const order: string[] = [];

  const result = await recordRunCompletion({
    markCompleted: () => {
      order.push('completed');
      return Promise.resolve();
    },
    recordOutcome: () => {
      order.push('record');
      return Promise.resolve();
    },
    reporter: new ProgressReporter({ silent: true }),
  });

  assert.equal(result, undefined);
  assert.deepEqual(order, ['completed']);
});

test('a failure to record the outcome leaves the completed checkpoint standing', async () => {
  const warnings: string[] = [];
  const reporter = new ProgressReporter({ silent: true });
  reporter.warning = (message: string) => warnings.push(message);
  let marked = 0;

  const result = await recordRunCompletion({
    markCompleted: () => {
      marked += 1;
      return Promise.resolve();
    },
    finish: () =>
      Promise.resolve<CompletionResult>({
        outcome: 'discarded',
        patchPath: '/tmp/run.patch',
      }),
    recordOutcome: () => Promise.reject(new Error('disk is full')),
    reporter,
  });

  // The outcome is still reported to the caller, and nothing was rewritten.
  assert.equal(result?.outcome, 'discarded');
  assert.equal(marked, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /could not be recorded: disk is full/);
});

test('a prompt failure that is not end of input still propagates', async () => {
  const prompt = createReadlineCompletionPrompt({
    input: new PassThrough(),
    output: new PassThrough(),
  });
  prompt.close();

  // Not a declined answer: asking a closed interface is a programming error,
  // and swallowing it would hide the question that never reached the user.
  await assert.rejects(() => prompt.ask('Choose 1, 2, or 3 [1]: '));
});

function savedRunFixture(overrides: Partial<SavedRun> = {}): SavedRun {
  const now = '2026-08-11T00:00:00.000Z';
  return {
    version: 3,
    id: 'boundary-run',
    createdAt: now,
    updatedAt: now,
    status: 'completed',
    task: 'task',
    originalCwd: '/project',
    agentCwd: '/project',
    projectKind: 'git',
    outputDirectory: '/runs',
    workflow: { kind: 'collaborative', firstAgent: 'codex', maxRounds: 2 },
    judge: 'codex',
    retries: 1,
    timeoutMinutes: 30,
    untilAgreement: true,
    requireAgreement: false,
    noTranscript: false,
    verification: [],
    protectedPaths: [],
    protectedPathFingerprints: {},
    completedCycles: 1,
    codexPrevious: '',
    claudePrevious: '',
    handoff: '',
    converged: true,
    rounds: [],
    ...overrides,
  };
}

/**
 * Drives the boundary the way cli.ts does, against a real store, so the
 * assertion is about what is on disk afterwards rather than what was returned.
 */
async function completeThroughStore({
  fixture,
  finish,
}: {
  fixture: Fixture;
  finish: () => Promise<CompletionResult>;
}): Promise<SavedRun> {
  const stateDirectory = join(fixture.root, 'state');
  const store = new RunStateStore(stateDirectory);
  const base = savedRunFixture({
    originalCwd: fixture.repository,
    agentCwd: fixture.workspace,
    workspace: fixture.workspace,
    outputDirectory: fixture.root,
  });

  await recordRunCompletion({
    markCompleted: async () => {
      await store.save(base);
    },
    finish,
    recordOutcome: async (result) => {
      await store.save({
        ...base,
        workspace: result.workspace,
        agentCwd: result.workspace ?? base.originalCwd,
        completion: {
          outcome: result.outcome,
          recordedAt: '2026-08-11T00:00:01.000Z',
          reason: result.reason,
        },
      });
    },
    reporter: fixture.reporter,
  });

  return store.load(base.id);
}

test('an injected apply failure leaves a reloaded checkpoint completed', async () => {
  await withFixture(async (fixture) => {
    const reloaded = await completeThroughStore({
      fixture,
      finish: () =>
        finishIsolatedRun({
          repository: fixture.repository,
          workspace: fixture.workspace,
          patchPath: fixture.patchPath,
          baseRevision: fixture.baseRevision,
          reporter: fixture.reporter,
          createPrompt: () => scriptedPrompt(['2']),
          apply: () => Promise.reject(new Error('git apply exploded')),
        }),
    });

    assert.equal(reloaded.status, 'completed');
    assert.equal(reloaded.completion?.outcome, 'apply-failed');
    assert.match(reloaded.completion?.reason ?? '', /git apply exploded/);
    assert.equal(reloaded.workspace, fixture.workspace);
    assert.equal(await exists(fixture.patchPath), true);
  });
});

test('an injected removal failure leaves a reloaded checkpoint completed', async () => {
  await withFixture(async (fixture) => {
    const reloaded = await completeThroughStore({
      fixture,
      finish: () =>
        finishIsolatedRun({
          repository: fixture.repository,
          workspace: fixture.workspace,
          patchPath: fixture.patchPath,
          baseRevision: fixture.baseRevision,
          reporter: fixture.reporter,
          createPrompt: () => scriptedPrompt(['3', 'y']),
          removeWorkspace: () =>
            Promise.reject(new Error('worktree is locked')),
        }),
    });

    assert.equal(reloaded.status, 'completed');
    assert.equal(reloaded.completion?.outcome, 'discard-failed');
    assert.match(reloaded.completion?.reason ?? '', /worktree is locked/);
    assert.equal(reloaded.workspace, fixture.workspace);
    assert.equal(await exists(fixture.workspace), true);
  });
});

test('a declined completion leaves a reloaded checkpoint completed', async () => {
  await withFixture(async (fixture) => {
    const reloaded = await completeThroughStore({
      fixture,
      finish: () =>
        finishIsolatedRun({
          repository: fixture.repository,
          workspace: fixture.workspace,
          patchPath: fixture.patchPath,
          baseRevision: fixture.baseRevision,
          reporter: fixture.reporter,
          createPrompt: () => scriptedPrompt([undefined]),
        }),
    });

    // D1 end to end: the run that was marked failed now stays completed.
    assert.equal(reloaded.status, 'completed');
    assert.equal(reloaded.completion?.outcome, 'declined');
    assert.equal(reloaded.completion?.reason, undefined);
  });
});

test('a workspace edited after its patch was written is re-patched before removal', async () => {
  await withFixture(async (fixture) => {
    // The patch the run wrote at completion time.
    await finishIsolatedRun({
      repository: fixture.repository,
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      reporter: fixture.reporter,
      createPrompt: () => undefined,
    });
    const stale = await readFile(fixture.patchPath, 'utf8');

    // Work done in the workspace afterwards, which the stale patch cannot know.
    await writeFile(join(fixture.workspace, 'later.txt'), 'added later\n');
    const plan = await planWorkspaceRemoval({
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      interactive: false,
    });

    assert.equal(plan.removable, true);
    const refreshed = await readFile(fixture.patchPath, 'utf8');
    assert.notEqual(refreshed, stale);
    assert.match(refreshed, /later\.txt/);
  });
});

test('a workspace holding a commit produces a patch containing it', async () => {
  await withFixture(async (fixture) => {
    await execute('git', ['add', '--all'], { cwd: fixture.workspace });
    await execute('git', ['commit', '-m', 'work committed inside'], {
      cwd: fixture.workspace,
    });

    const plan = await planWorkspaceRemoval({
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      interactive: true,
    });

    assert.equal(plan.removable, true);
    // D8: an implied HEAD baseline produced an empty patch here, silently
    // dropping every committed change.
    assert.equal(plan.removable && plan.patchPath, fixture.patchPath);
    assert.match(await readFile(fixture.patchPath, 'utf8'), /after/);
  });
});

test('a workspace with no changes is removable and needs no patch', async () => {
  await withFixture(
    async (fixture) => {
      const plan = await planWorkspaceRemoval({
        workspace: fixture.workspace,
        patchPath: fixture.patchPath,
        baseRevision: fixture.baseRevision,
        interactive: false,
      });

      // Nothing to lose, so a missing patch must not block removal forever.
      assert.equal(plan.removable, true);
      assert.equal(plan.removable && plan.patchPath, undefined);
      assert.equal(await exists(fixture.patchPath), false);
    },
    { edit: false },
  );
});

test('removal is refused for a run that recorded no base revision', async () => {
  await withFixture(async (fixture) => {
    const plan = await planWorkspaceRemoval({
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: undefined,
      interactive: true,
    });

    assert.equal(plan.removable, false);
    assert.equal(plan.removable === false && plan.outcome, 'discard-failed');
    assert.match(
      plan.removable === false ? plan.reason : '',
      /recorded no base revision/,
    );
    assert.equal(await exists(fixture.workspace), true);
  });
});

test('unattended removal is refused while workspace commits are unanchored', async () => {
  await withFixture(async (fixture) => {
    await execute('git', ['add', '--all'], { cwd: fixture.workspace });
    await execute('git', ['commit', '-m', 'unanchored work'], {
      cwd: fixture.workspace,
    });

    const refused = await planWorkspaceRemoval({
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      interactive: false,
    });
    assert.equal(refused.removable, false);
    assert.match(
      refused.removable === false ? refused.reason : '',
      /1 commit ahead .*no branch or tag contains those commits/s,
    );
    assert.match(
      refused.removable === false ? refused.reason : '',
      /git branch <name>/,
    );

    // Following the advice must actually clear the refusal.
    await execute('git', ['branch', 'keep-my-work'], {
      cwd: fixture.workspace,
    });
    const allowed = await planWorkspaceRemoval({
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      interactive: false,
    });
    assert.equal(allowed.removable, true);
    assert.equal(allowed.removable && allowed.unanchoredHistory, undefined);
  });
});

test('interactive removal of unanchored history states what a patch cannot carry', async () => {
  await withFixture(async (fixture) => {
    await execute('git', ['add', '--all'], { cwd: fixture.workspace });
    await execute('git', ['commit', '-m', 'unanchored work'], {
      cwd: fixture.workspace,
    });

    const prompt = scriptedPrompt(['3', 'y']);
    const result = await finishIsolatedRun({
      repository: fixture.repository,
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      reporter: fixture.reporter,
      createPrompt: () => prompt,
    });

    assert.equal(result.outcome, 'discarded');
    assert.match(
      prompt.questions[1] ?? '',
      /commit messages, authorship, signatures, or topology/,
    );
    assert.equal(await exists(fixture.workspace), false);
    assert.match(await readFile(fixture.patchPath, 'utf8'), /after/);
  });
});

test('a resumed run with no recorded baseline never gains one', async () => {
  await withFixture(async (fixture) => {
    const stateDirectory = join(fixture.root, 'state');
    const store = new RunStateStore(stateDirectory);
    // A legacy checkpoint: it predates base-revision tracking.
    const legacy = savedRunFixture({
      originalCwd: fixture.repository,
      agentCwd: fixture.workspace,
      workspace: fixture.workspace,
      outputDirectory: fixture.root,
    });
    assert.equal(legacy.baseRevision, undefined);

    const result = await recordRunCompletion({
      markCompleted: () => store.save(legacy).then(() => undefined),
      finish: () =>
        finishIsolatedRun({
          repository: fixture.repository,
          workspace: fixture.workspace,
          patchPath: fixture.patchPath,
          baseRevision: legacy.baseRevision,
          // Derived at startup by the resuming process.
          derivedBaseRevision: fixture.baseRevision,
          reporter: fixture.reporter,
          createPrompt: () => scriptedPrompt(['2']),
        }),
      recordOutcome: async (finished) => {
        await store.save({
          ...legacy,
          // cli.ts persists the recorded baseline, which is still absent.
          baseRevision: legacy.baseRevision,
          completion: {
            outcome: finished.outcome,
            recordedAt: '2026-08-11T00:00:01.000Z',
            reason: finished.reason,
          },
        });
      },
      reporter: fixture.reporter,
    });

    // Apply is refused for the recorded-baseline reason, not silently allowed
    // against the revision derived at startup.
    assert.equal(result?.outcome, 'apply-refused');
    assert.match(result?.reason ?? '', /predates base-revision tracking/);
    assert.equal(
      await readFile(join(fixture.repository, 'tracked.txt'), 'utf8'),
      'before\n',
    );

    // Discard is refused for the same reason.
    const removal = await planWorkspaceRemoval({
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: legacy.baseRevision,
      interactive: true,
    });
    assert.equal(removal.removable, false);

    const reloaded = await store.load(legacy.id);
    assert.equal(reloaded.status, 'completed');
    assert.equal(reloaded.baseRevision, undefined);
    assert.equal(reloaded.completion?.outcome, 'apply-refused');
  });
});

test('removal is refused when a complete patch cannot be created', async () => {
  await withFixture(async (fixture) => {
    const plan = await planWorkspaceRemoval({
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      // Nothing can be diffed against a revision that does not exist.
      baseRevision: 'not-a-revision',
      interactive: true,
    });

    assert.equal(plan.removable, false);
    assert.equal(plan.removable === false && plan.outcome, 'patch-failed');
    assert.match(
      plan.removable === false ? plan.reason : '',
      /kept because a complete patch could not be created/,
    );
    assert.equal(await exists(fixture.workspace), true);
  });
});

test('the completion step keeps a workspace it cannot capture at all', async () => {
  await withFixture(async (fixture) => {
    const prompt = scriptedPrompt([]);
    const result = await finishIsolatedRun({
      repository: fixture.repository,
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: undefined,
      derivedBaseRevision: undefined,
      reporter: fixture.reporter,
      createPrompt: () => prompt,
    });

    assert.equal(result.outcome, 'patch-failed');
    assert.match(result.reason ?? '', /No base revision is available/);
    assert.equal(result.workspace, fixture.workspace);
    assert.deepEqual(prompt.questions, []);
    assert.equal(await exists(fixture.workspace), true);
  });
});

test('a legacy run is refused a discard without being asked to confirm it', async () => {
  await withFixture(async (fixture) => {
    const prompt = scriptedPrompt(['3']);
    const result = await finishIsolatedRun({
      repository: fixture.repository,
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      // Recorded nothing, so removal cannot be proven safe at all.
      baseRevision: undefined,
      derivedBaseRevision: fixture.baseRevision,
      reporter: fixture.reporter,
      createPrompt: () => prompt,
      removeWorkspace: () => Promise.reject(new Error('must not be reached')),
    });

    assert.equal(result.outcome, 'discard-failed');
    assert.match(result.reason ?? '', /recorded no base revision/);
    assert.equal(result.workspace, fixture.workspace);
    // Asking to confirm a removal that will not happen would be misleading.
    assert.equal(prompt.questions.length, 1);
    assert.equal(await exists(fixture.workspace), true);
  });
});

test('an uninspectable history refuses removal instead of escaping', async () => {
  await withFixture(async (fixture) => {
    // A tree object: Git can diff against it, so the patch is written, but it
    // is not a commit and every history question against it fails.
    const treeRevision = (
      await execute('git', ['rev-parse', `${fixture.baseRevision}^{tree}`], {
        cwd: fixture.repository,
      })
    ).stdout.trim();

    const plan = await planWorkspaceRemoval({
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: treeRevision,
      interactive: true,
    });

    assert.equal(plan.removable, false);
    assert.equal(plan.removable === false && plan.outcome, 'discard-failed');
    assert.match(
      plan.removable === false ? plan.reason : '',
      /history could not be inspected/,
    );
    // The refreshed patch is named, because it is where the work now lives.
    assert.match(
      plan.removable === false ? plan.reason : '',
      new RegExp(
        `A complete patch is at ${fixture.patchPath.replace(/[.]/g, '\\.')}`,
      ),
    );
    assert.equal(await exists(fixture.workspace), true);
    assert.equal(await exists(fixture.patchPath), true);
  });
});

test('an uninspectable history is persisted as a completion outcome', async () => {
  await withFixture(async (fixture) => {
    const treeRevision = (
      await execute('git', ['rev-parse', `${fixture.baseRevision}^{tree}`], {
        cwd: fixture.repository,
      })
    ).stdout.trim();
    const store = new RunStateStore(join(fixture.root, 'state'));
    const base = savedRunFixture({
      originalCwd: fixture.repository,
      agentCwd: fixture.workspace,
      workspace: fixture.workspace,
      outputDirectory: fixture.root,
      baseRevision: treeRevision,
    });

    const result = await recordRunCompletion({
      markCompleted: () => store.save(base).then(() => undefined),
      finish: () =>
        finishIsolatedRun({
          repository: fixture.repository,
          workspace: fixture.workspace,
          patchPath: fixture.patchPath,
          baseRevision: treeRevision,
          reporter: fixture.reporter,
          createPrompt: () => scriptedPrompt(['3']),
        }),
      recordOutcome: async (finished) => {
        await store.save({
          ...base,
          completion: {
            outcome: finished.outcome,
            recordedAt: '2026-08-11T00:00:01.000Z',
            reason: finished.reason,
          },
        });
      },
      reporter: fixture.reporter,
    });

    assert.equal(result?.outcome, 'discard-failed');
    const reloaded = await store.load(base.id);
    assert.equal(reloaded.status, 'completed');
    assert.equal(reloaded.completion?.outcome, 'discard-failed');
    assert.match(
      reloaded.completion?.reason ?? '',
      /history could not be inspected/,
    );
    assert.equal(await exists(fixture.workspace), true);
  });
});

test('every completion outcome is reachable without a terminal', async () => {
  await withFixture(async (fixture) => {
    const kept = await finishIsolatedRun({
      repository: fixture.repository,
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      instruction: 'keep',
      reporter: fixture.reporter,
      // No prompt exists at all: nothing may try to ask.
      createPrompt: () => undefined,
    });
    assert.deepEqual(kept, {
      outcome: 'kept',
      patchPath: fixture.patchPath,
      workspace: fixture.workspace,
    });

    const applied = await finishIsolatedRun({
      repository: fixture.repository,
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      instruction: 'apply',
      reporter: fixture.reporter,
      createPrompt: () => undefined,
    });
    assert.equal(applied.outcome, 'applied');
    assert.equal(
      await readFile(join(fixture.repository, 'tracked.txt'), 'utf8'),
      'after\n',
    );

    const discarded = await finishIsolatedRun({
      repository: fixture.repository,
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      instruction: 'discard',
      reporter: fixture.reporter,
      createPrompt: () => undefined,
    });
    assert.equal(discarded.outcome, 'discarded');
    assert.equal(await exists(fixture.workspace), false);
  });
});

test('an explicit discard instruction needs no further confirmation', async () => {
  await withFixture(async (fixture) => {
    const prompt = scriptedPrompt([]);
    const result = await finishIsolatedRun({
      repository: fixture.repository,
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      instruction: 'discard',
      reporter: fixture.reporter,
      // A terminal is available, but the flag is itself the instruction.
      createPrompt: () => prompt,
    });

    assert.equal(result.outcome, 'discarded');
    assert.deepEqual(prompt.questions, []);
    assert.equal(await exists(fixture.workspace), false);
  });
});

test('an explicit discard still runs the preservation gate', async () => {
  await withFixture(async (fixture) => {
    await execute('git', ['add', '--all'], { cwd: fixture.workspace });
    await execute('git', ['commit', '-m', 'inside'], {
      cwd: fixture.workspace,
    });

    const result = await finishIsolatedRun({
      repository: fixture.repository,
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      instruction: 'discard',
      reporter: fixture.reporter,
      createPrompt: () => undefined,
    });

    // Unattended: unanchored commits are refused, never confirmed away.
    assert.equal(result.outcome, 'discard-failed');
    assert.match(
      result.reason ?? '',
      /no branch or tag contains those commits/,
    );
    assert.equal(await exists(fixture.workspace), true);
  });
});

test("unattended apply refuses a checkout holding the user's own work", async () => {
  await withFixture(async (fixture) => {
    await writeFile(join(fixture.repository, 'mine.txt'), 'my own work\n');
    await writeFile(join(fixture.repository, 'notes.md'), 'untracked\n');
    await execute('git', ['add', 'mine.txt'], { cwd: fixture.repository });

    const result = await finishIsolatedRun({
      repository: fixture.repository,
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      instruction: 'apply',
      reporter: fixture.reporter,
      createPrompt: () => undefined,
    });

    assert.equal(result.outcome, 'apply-refused');
    assert.match(
      result.reason ?? '',
      /uncommitted work \(1 changed, 1 untracked\)/,
    );
    // Counts, not paths: compact output does not expose project paths.
    assert.equal((result.reason ?? '').includes('mine.txt'), false);
    assert.equal(result.refusedInstruction, true);
    assert.equal(
      await readFile(join(fixture.repository, 'tracked.txt'), 'utf8'),
      'before\n',
    );
  });
});

test('interactive apply into a dirty checkout remains available', async () => {
  await withFixture(async (fixture) => {
    await writeFile(join(fixture.repository, 'notes.md'), 'untracked\n');
    const prompt = scriptedPrompt(['2', 'y']);

    const result = await finishIsolatedRun({
      repository: fixture.repository,
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      reporter: fixture.reporter,
      createPrompt: () => prompt,
    });

    // The user is present and answered; only unattended application refuses.
    assert.equal(result.outcome, 'applied');
    assert.equal(result.refusedInstruction, undefined);
    // D3: the state being applied into is disclosed before the answer, not
    // after it, and in counts rather than paths.
    assert.match(prompt.questions[1] ?? '', /0 changed files? and 1 untracked/);
    assert.match(prompt.questions[1] ?? '', /there is no undo/);
    assert.equal((prompt.questions[1] ?? '').includes('notes.md'), false);
    assert.match(
      prompt.questions[1] ?? '',
      /Apply the patch anyway\? \[y\/N\]: $/,
    );
    assert.equal(
      await readFile(join(fixture.repository, 'tracked.txt'), 'utf8'),
      'after\n',
    );
  });
});

test('an interactive refusal does not mark the run as an instruction failure', async () => {
  await withFixture(async (fixture) => {
    await writeFile(join(fixture.repository, 'tracked.txt'), 'conflicting\n');

    const result = await finishIsolatedRun({
      repository: fixture.repository,
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      reporter: fixture.reporter,
      createPrompt: () => scriptedPrompt(['2']),
    });

    assert.equal(result.outcome, 'apply-refused');
    assert.equal(result.refusedInstruction, undefined);
  });
});

test('overlapping dirty work is refused as dirty, not as a conflict', async () => {
  await withFixture(async (fixture) => {
    // The user edits the very file the agents changed. git apply --check would
    // call this a conflict, which is true but sends them to fix the wrong
    // thing: the actionable answer is that their own work is uncommitted.
    await writeFile(join(fixture.repository, 'tracked.txt'), 'my own work\n');

    const result = await finishIsolatedRun({
      repository: fixture.repository,
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      instruction: 'apply',
      reporter: fixture.reporter,
      createPrompt: () => undefined,
    });

    assert.equal(result.outcome, 'apply-refused');
    assert.match(
      result.reason ?? '',
      /uncommitted work \(1 changed, 0 untracked\)/,
    );
    assert.equal((result.reason ?? '').includes('conflicts with'), false);
    assert.equal(result.refusedInstruction, true);
    assert.equal(
      await readFile(join(fixture.repository, 'tracked.txt'), 'utf8'),
      'my own work\n',
    );
  });
});

test('a file both staged and modified counts once', async () => {
  await withFixture(async (fixture) => {
    await writeFile(join(fixture.repository, 'mine.txt'), 'staged\n');
    await execute('git', ['add', 'mine.txt'], { cwd: fixture.repository });
    // Modified again after staging: two status flags, one file to reconcile.
    await writeFile(join(fixture.repository, 'mine.txt'), 'and modified\n');

    const result = await finishIsolatedRun({
      repository: fixture.repository,
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      instruction: 'apply',
      reporter: fixture.reporter,
      createPrompt: () => undefined,
    });

    assert.match(
      result.reason ?? '',
      /uncommitted work \(1 changed, 0 untracked\)/,
    );
  });
});

test('an interactive apply still reports an overlapping conflict as one', async () => {
  await withFixture(async (fixture) => {
    await writeFile(join(fixture.repository, 'tracked.txt'), 'my own work\n');

    const result = await finishIsolatedRun({
      repository: fixture.repository,
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      reporter: fixture.reporter,
      createPrompt: () => scriptedPrompt(['2']),
    });

    // The dirty refusal is unattended-only, so the user still learns the real
    // obstacle to the apply they asked for.
    assert.equal(result.outcome, 'apply-refused');
    assert.match(result.reason ?? '', /conflicts with the original checkout/);
  });
});

test('a clean checkout is applied into without an extra question', async () => {
  await withFixture(async (fixture) => {
    const prompt = scriptedPrompt(['2']);
    const result = await finishIsolatedRun({
      repository: fixture.repository,
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      reporter: fixture.reporter,
      createPrompt: () => prompt,
    });

    // There is nothing to disclose, so nothing extra is asked.
    assert.equal(result.outcome, 'applied');
    assert.equal(prompt.questions.length, 1);
  });
});

test('declining the disclosure leaves the checkout untouched', async () => {
  await withFixture(async (fixture) => {
    await writeFile(join(fixture.repository, 'notes.md'), 'untracked\n');
    const prompt = scriptedPrompt(['2', 'n']);

    const result = await finishIsolatedRun({
      repository: fixture.repository,
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      reporter: fixture.reporter,
      createPrompt: () => prompt,
    });

    assert.equal(result.outcome, 'kept');
    assert.equal(result.workspace, fixture.workspace);
    assert.equal(
      await readFile(join(fixture.repository, 'tracked.txt'), 'utf8'),
      'before\n',
    );
  });
});

test('an unanswered disclosure is declined rather than applied', async () => {
  await withFixture(async (fixture) => {
    await writeFile(join(fixture.repository, 'notes.md'), 'untracked\n');

    const result = await finishIsolatedRun({
      repository: fixture.repository,
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      reporter: fixture.reporter,
      createPrompt: () => scriptedPrompt(['2', undefined]),
    });

    assert.equal(result.outcome, 'declined');
    assert.equal(
      await readFile(join(fixture.repository, 'tracked.txt'), 'utf8'),
      'before\n',
    );
  });
});

test('a successful apply reports how many files it touched', async () => {
  await withFixture(async (fixture) => {
    await writeFile(join(fixture.workspace, 'second.txt'), 'also new\n');
    const messages: string[] = [];
    const reporter = new ProgressReporter({ silent: true });
    reporter.success = (message: string) => messages.push(message);

    const result = await finishIsolatedRun({
      repository: fixture.repository,
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      instruction: 'apply',
      reporter,
      createPrompt: () => undefined,
    });

    assert.equal(result.outcome, 'applied');
    // Two files: the edited one and the new one.
    assert.match(messages.at(-1) ?? '', /2 files changed/);
    // The applied changes and any of the user's own are both unstaged and
    // appear in the same diff, so the patch is what keeps them distinguishable.
    assert.match(messages.at(-1) ?? '', /inspect the combined checkout/);
    assert.equal((messages.at(-1) ?? '').includes('separates them'), false);
    assert.ok((messages.at(-1) ?? '').includes(fixture.patchPath));
  });
});

test('a failed apply says where the patch is and how to retry', async () => {
  await withFixture(async (fixture) => {
    const result = await finishIsolatedRun({
      repository: fixture.repository,
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      instruction: 'apply',
      reporter: fixture.reporter,
      createPrompt: () => undefined,
      apply: () => Promise.reject(new Error('git apply exploded')),
    });

    // D4: the raw process error alone left the user with no next step.
    const reason = result.reason ?? '';
    assert.match(reason, /git apply exploded/);
    assert.ok(reason.includes(`still at ${fixture.patchPath}`));
    assert.ok(reason.includes(`kept at ${fixture.workspace}`));
    assert.match(reason, /Nothing was staged or committed/);
    assert.match(reason, /run `git apply` again on that patch path/);
    assert.equal(await exists(fixture.patchPath), true);
  });
});

test('a failed removal says where the workspace and patch remain', async () => {
  await withFixture(async (fixture) => {
    const result = await finishIsolatedRun({
      repository: fixture.repository,
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      instruction: 'discard',
      reporter: fixture.reporter,
      createPrompt: () => undefined,
      removeWorkspace: () => Promise.reject(new Error('worktree is locked')),
    });

    const reason = result.reason ?? '';
    assert.match(reason, /worktree is locked/);
    assert.ok(reason.includes(`still at ${fixture.workspace}`));
    assert.ok(reason.includes(`patch is at ${fixture.patchPath}`));
    assert.match(reason, /--discard-workspace/);
    assert.equal(await exists(fixture.workspace), true);
  });
});

test('an unavailable file count is reported without blocking the apply', async () => {
  await withFixture(async (fixture) => {
    const warnings: string[] = [];
    const reporter = new ProgressReporter({ silent: true });
    reporter.warning = (message: string) => warnings.push(message);

    const result = await finishIsolatedRun({
      repository: fixture.repository,
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      instruction: 'apply',
      reporter,
      createPrompt: () => undefined,
      countFiles: () => Promise.reject(new Error('unknown option')),
    });

    // The count is a convenience; the apply must still happen. Reporting the
    // failure is what keeps a broken command from hiding behind a vaguer
    // success message.
    assert.equal(result.outcome, 'applied');
    assert.match(
      warnings.at(-1) ?? '',
      /file count is unavailable: unknown option/,
    );
    assert.equal(
      await readFile(join(fixture.repository, 'tracked.txt'), 'utf8'),
      'after\n',
    );
  });
});

test('a long apply error keeps the recovery guidance', async () => {
  await withFixture(async (fixture) => {
    const result = await finishIsolatedRun({
      repository: fixture.repository,
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      instruction: 'apply',
      runId: 'run-20260811-abc123',
      reporter: fixture.reporter,
      createPrompt: () => undefined,
      apply: () => Promise.reject(new Error('x'.repeat(4_000))),
    });

    const reason = result.reason ?? '';
    // Bounded overall, but the guidance is what survives truncation.
    assert.ok(reason.length <= 2_000);
    assert.ok(reason.includes(`still at ${fixture.patchPath}`));
    assert.match(reason, /git status/);
    assert.match(reason, /run `git apply` again on that patch path/);
    // The error itself is what gets cut.
    assert.match(reason, /…/);
  });
});

test('a long removal error keeps the recovery guidance', async () => {
  await withFixture(async (fixture) => {
    const result = await finishIsolatedRun({
      repository: fixture.repository,
      workspace: fixture.workspace,
      patchPath: fixture.patchPath,
      baseRevision: fixture.baseRevision,
      instruction: 'discard',
      runId: 'run-20260811-abc123',
      reporter: fixture.reporter,
      createPrompt: () => undefined,
      removeWorkspace: () => Promise.reject(new Error('y'.repeat(4_000))),
    });

    const reason = result.reason ?? '';
    assert.ok(reason.length <= 2_000);
    assert.ok(reason.includes(`still at ${fixture.workspace}`));
    assert.match(reason, /--discard-workspace run-20260811-abc123\b/);
    assert.match(reason, /…/);
  });
});

test('a path with spaces is stated exactly, not wrapped in one shell syntax', async () => {
  await withFixture(async (fixture) => {
    // The real macOS data directory is under `Application Support`.
    const spaced = join(fixture.root, 'Application Support', 'run.patch');

    const result = await finishIsolatedRun({
      repository: fixture.repository,
      workspace: fixture.workspace,
      patchPath: spaced,
      baseRevision: fixture.baseRevision,
      instruction: 'apply',
      runId: 'run-20260811-abc123',
      reporter: fixture.reporter,
      createPrompt: () => undefined,
      apply: () => Promise.reject(new Error('failed')),
    });

    const reason = result.reason ?? '';
    // The exact path, so it can be copied wherever the user needs it.
    assert.ok(reason.includes(spaced));
    // Not embedded in a command whose quoting only works on some platforms:
    // POSIX single quotes are literal characters in `cmd.exe`, and the parent
    // shell is not knowable from here.
    assert.ok(!reason.includes(`'${spaced}'`));
    assert.ok(!reason.includes(`"${spaced}"`));
    assert.ok(reason.includes('quoted as your shell requires'));
  });
});
