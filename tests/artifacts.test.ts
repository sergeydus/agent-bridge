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
  recordRunCompletion,
  type CompletionPrompt,
  type CompletionResult,
} from '../src/artifacts.ts';
import { createIsolatedWorktree, currentCommit, execute } from '../src/git.ts';
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

    const workspace = await createIsolatedWorktree({
      repository,
      runsDirectory: join(root, 'runs'),
      runId: 'run',
    });
    if (edit) {
      await writeFile(join(workspace, 'tracked.txt'), 'after\n');
    }
    await body({
      root,
      repository,
      workspace,
      patchPath: join(root, 'run.patch'),
      baseRevision: await currentCommit(repository),
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
  await withFixture(async ({ repository, workspace, patchPath, reporter }) => {
    const prompt = scriptedPrompt(['2']);
    const result = await finishIsolatedRun({
      repository,
      workspace,
      patchPath,
      baseRevision: undefined,
      reporter,
      createPrompt: () => prompt,
    });

    assert.equal(result.outcome, 'apply-refused');
    assert.match(result.reason ?? '', /predates base-revision tracking/);
    assert.deepEqual(
      { patchPath: result.patchPath, workspace: result.workspace },
      { patchPath, workspace },
    );
    assert.equal(
      await readFile(join(repository, 'tracked.txt'), 'utf8'),
      'before\n',
    );
  });
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

test('closes the prompt when a completion action throws', async () => {
  await withFixture(
    async ({ root, workspace, patchPath, baseRevision, reporter }) => {
      const prompt = scriptedPrompt(['2']);
      await assert.rejects(() =>
        finishIsolatedRun({
          repository: join(root, 'not-a-repository'),
          workspace,
          patchPath,
          baseRevision,
          reporter,
          createPrompt: () => prompt,
        }),
      );

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
