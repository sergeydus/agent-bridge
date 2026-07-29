import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { UserConfigStore } from '../src/config.ts';
import { parseArgs } from '../src/options.ts';
import {
  chooseProject,
  configureAccessibility,
  configureModels,
  configurePresentation,
  presentationLabel,
  workflowChoices,
} from '../src/wizard.ts';

class ScriptedQuestioner {
  #answers: string[];
  readonly prompts: string[] = [];

  constructor(answers: string[]) {
    this.#answers = [...answers];
  }

  question(prompt: string): Promise<string> {
    this.prompts.push(prompt);
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

test('wizard offers automatic enhanced presentation for interactive chat', async () => {
  const temporaryDirectory = tmpdir();
  const options = parseArgs([], {
    initialCwd: temporaryDirectory,
    defaultOutput: join(temporaryDirectory, 'runs'),
  });

  await configurePresentation(new ScriptedQuestioner(['2']), options, true);

  assert.equal(options.ui, 'auto');
  assert.equal(options.screenReader, false);
  assert.equal(
    presentationLabel(options),
    'enhanced when supported, otherwise standard',
  );
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

test('wizard offers simple intents appropriate to the project', () => {
  const chatChoice = workflowChoices()[0];
  assert.match(chatChoice?.description ?? '', /without changing files/);
  assert.match(chatChoice?.description ?? '', /\/edit/);
  assert.deepEqual(
    workflowChoices().map(({ value }) => value),
    ['1', '2', '3', '4'],
  );
  assert.deepEqual(
    workflowChoices({ projectKind: 'directory' }).map(({ action }) => action),
    ['chat', 'review', 'advanced'],
  );
});

test('wizard asks accessibility first once and restores the preference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-accessible-'));
  try {
    const store = new UserConfigStore(join(directory, 'config.json'));
    const first = parseArgs([], {
      initialCwd: directory,
      defaultOutput: join(directory, 'runs'),
    });
    const firstQuestioner = new ScriptedQuestioner(['yes']);
    await configureAccessibility(firstQuestioner, first, store);
    assert.equal(first.screenReader, true);
    assert.equal(
      firstQuestioner.prompts[0],
      'Use screen-reader-friendly output? [y/N]: ',
    );

    const restored = parseArgs([], {
      initialCwd: directory,
      defaultOutput: join(directory, 'runs'),
    });
    const secondQuestioner = new ScriptedQuestioner([]);
    await configureAccessibility(secondQuestioner, restored, store);
    assert.equal(restored.screenReader, true);
    assert.deepEqual(secondQuestioner.prompts, []);
    await configurePresentation(new ScriptedQuestioner(['']), restored, true);
    assert.equal(restored.screenReader, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('an explicit enhanced UI overrides a saved screen-reader preference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-ui-override-'));
  try {
    const store = new UserConfigStore(join(directory, 'config.json'));
    await store.rememberPresentation({
      screenReader: true,
      noColor: true,
      ui: 'plain',
    });
    const options = parseArgs(['chat', '--ui', 'enhanced'], {
      initialCwd: directory,
      defaultOutput: join(directory, 'runs'),
    });
    await configureAccessibility(new ScriptedQuestioner([]), options, store);
    assert.equal(options.screenReader, false);
    assert.equal(options.ui, 'enhanced');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('wizard asks for a project path directly when there are no shortcuts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-wizard-'));
  const project = await mkdtemp(join(tmpdir(), 'agent-bridge-target-'));
  try {
    const options = parseArgs([], {
      initialCwd: root,
      defaultOutput: join(root, 'runs'),
    });
    const questioner = new ScriptedQuestioner([project]);

    const selected = await chooseProject(
      questioner,
      options,
      new UserConfigStore(join(root, 'config.json')),
      resolve(root),
    );

    assert.equal(selected.root, project);
    assert.equal(selected.kind, 'directory');
    assert.deepEqual(questioner.prompts, [
      'Paste a project folder, or drag it into this window:\n> ',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(project, { recursive: true, force: true });
  }
});

test('wizard accepts a pasted path instead of a recent-project number', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-wizard-'));
  const recentProject = await mkdtemp(
    join(tmpdir(), 'agent-bridge-recent-target-'),
  );
  const pastedProject = await mkdtemp(
    join(tmpdir(), 'agent-bridge-pasted-target-'),
  );
  try {
    const options = parseArgs([], {
      initialCwd: root,
      defaultOutput: join(root, 'runs'),
    });
    const configStore = new UserConfigStore(join(root, 'config.json'));
    await configStore.rememberProject(recentProject);
    const questioner = new ScriptedQuestioner([pastedProject]);

    const selected = await chooseProject(
      questioner,
      options,
      configStore,
      resolve(root),
    );

    assert.equal(selected.root, pastedProject);
    assert.deepEqual(questioner.prompts, [
      'Choose 1, or enter a project folder [1]: ',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(recentProject, { recursive: true, force: true });
    await rm(pastedProject, { recursive: true, force: true });
  }
});
