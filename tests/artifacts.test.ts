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
  type CompletionPrompt,
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

      assert.deepEqual(result, { workspace });
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

      assert.deepEqual(result, { patchPath, workspace });
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

      assert.deepEqual(result, { patchPath, workspace });
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

test('repeats the menu with a correction until the answer is a listed choice', async () => {
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

      assert.deepEqual(result, { patchPath, workspace });
      assert.equal(prompt.questions.length, 3);
      assert.equal(prompt.questions[0]?.startsWith('Please enter'), false);
      for (const question of prompt.questions.slice(1)) {
        assert.match(question, /^Please enter 1, 2, 3\.\n\nWhat should happen/);
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

      assert.deepEqual(result, { patchPath, workspace, applied: true });
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

    assert.deepEqual(result, { patchPath, workspace });
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

      assert.deepEqual(result, { patchPath, workspace });
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

      assert.deepEqual(result, { patchPath, workspace });
      assert.equal(
        await readFile(join(repository, 'tracked.txt'), 'utf8'),
        'conflicting\n',
      );
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

      assert.deepEqual(result, { patchPath });
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

      assert.deepEqual(result, { patchPath, workspace });
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

      assert.deepEqual(result, { patchPath, workspace });
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

      assert.deepEqual(result, { patchPath, workspace });
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
