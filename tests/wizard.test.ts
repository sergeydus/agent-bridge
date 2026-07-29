import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseArgs } from '../src/options.ts';
import { configureModels, configurePresentation } from '../src/wizard.ts';

class ScriptedQuestioner {
  #answers: string[];

  constructor(answers: string[]) {
    this.#answers = [...answers];
  }

  question(): Promise<string> {
    return Promise.resolve(this.#answers.shift() ?? '');
  }
}

test('wizard configures accessible presentation and optional models', async () => {
  const temporaryDirectory = tmpdir();
  const options = parseArgs([], {
    initialCwd: temporaryDirectory,
    defaultOutput: join(temporaryDirectory, 'runs'),
  });
  const questioner = new ScriptedQuestioner([
    '2',
    'yes',
    'codex-test',
    'claude-test',
    '4',
    '3',
  ]);

  await configurePresentation(questioner, options);
  await configureModels(questioner, options);

  assert.equal(options.screenReader, true);
  assert.equal(options.noColor, true);
  assert.equal(options.codexModel, 'codex-test');
  assert.equal(options.claudeModel, 'claude-test');
  assert.equal(options.codexEffort, 'high');
  assert.equal(options.claudeEffort, 'medium');
});

test('wizard preserves explicit model settings and asks only for missing ones', async () => {
  const temporaryDirectory = tmpdir();
  const options = parseArgs(
    ['--codex-model', 'explicit-codex', '--codex-effort', 'high'],
    {
      initialCwd: temporaryDirectory,
      defaultOutput: join(temporaryDirectory, 'runs'),
    },
  );
  const questioner = new ScriptedQuestioner(['yes', 'claude-test', '3']);

  await configureModels(questioner, options);

  assert.equal(options.codexModel, 'explicit-codex');
  assert.equal(options.codexEffort, 'high');
  assert.equal(options.claudeModel, 'claude-test');
  assert.equal(options.claudeEffort, 'medium');
});
