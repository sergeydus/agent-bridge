import {
  createInterface,
  type Interface as ReadlineInterface,
} from 'node:readline/promises';
import { basename, resolve } from 'node:path';

import { UserConfigStore } from './config.ts';
import { ChatSessionStore } from './chat-state.ts';
import type { ReasoningEffort } from './core.ts';
import type { AppPaths } from './paths.ts';
import type { BridgeOptions } from './options.ts';
import { resolveProject, type SelectedProject } from './project.ts';
import { workingTreeStatus } from './snapshot.ts';
import { RunStateStore } from './state.ts';
import { sanitizeTerminalText } from './terminal-text.ts';
import {
  formatWorkflowPreflight,
  inspectWorkflowPreflight,
} from './workflow-preflight.ts';

interface Questioner {
  question(prompt: string): Promise<string>;
}

async function askForChoice(
  interface_: Questioner,
  prompt: string,
  choices: string[],
  defaultChoice: string,
): Promise<string> {
  while (true) {
    const answer = (await interface_.question(prompt)).trim().toLowerCase();
    const choice = answer || defaultChoice;
    if (choices.includes(choice)) {
      return choice;
    }
    console.log(`Please enter ${choices.join(', ')}.`);
  }
}

export async function configurePresentation(
  interface_: Questioner,
  options: BridgeOptions,
  enhancedAvailable = false,
): Promise<void> {
  const presentations = [
    'Standard terminal output',
    ...(enhancedAvailable
      ? ['Enhanced interactive view when this terminal supports it']
      : []),
    'Screen-reader-friendly plain output',
  ];
  const choices = presentations.map((_, index) => String(index + 1));
  const defaultPresentation = options.screenReader
    ? String(presentations.length)
    : enhancedAvailable && options.ui !== 'plain'
      ? '2'
      : '1';
  console.log(`\nHow should Agent Bridge present the conversation?
${presentations
  .map(
    (label, index) =>
      `  ${index + 1}) ${label}${String(index + 1) === defaultPresentation ? ' (current)' : ''}`,
  )
  .join('\n')}
`);
  const presentation = await askForChoice(
    interface_,
    `Choose ${enhancedAvailable ? '1, 2, or 3' : '1 or 2'} [${defaultPresentation}]: `,
    choices,
    defaultPresentation,
  );
  if (enhancedAvailable && presentation === '2') {
    options.screenReader = false;
    options.noColor = false;
    options.ui = 'auto';
  } else if (presentation === String(presentations.length)) {
    options.screenReader = true;
    options.noColor = true;
    options.ui = 'plain';
  } else {
    options.screenReader = false;
    options.noColor = false;
    options.ui = 'plain';
  }
}

export async function configureAccessibility(
  interface_: Questioner,
  options: BridgeOptions,
  configStore: UserConfigStore,
): Promise<void> {
  const config = await configStore.load();
  if (config.presentation) {
    if (!options.screenReaderExplicit) {
      options.screenReader = config.presentation.screenReader;
    }
    options.noColor ||= config.presentation.noColor;
    if (!options.uiExplicit) {
      options.ui = config.presentation.ui;
    }
  } else if (!options.screenReaderExplicit) {
    const accessible = await askForChoice(
      interface_,
      'Use screen-reader-friendly output? [y/N]: ',
      ['y', 'yes', 'n', 'no'],
      'n',
    );
    options.screenReader = ['y', 'yes'].includes(accessible);
    if (options.screenReader) {
      options.noColor = true;
      options.ui = 'plain';
    }
  }
  if (options.uiExplicit && !options.screenReaderExplicit) {
    options.screenReader = false;
  }
  if (options.screenReader) {
    options.noColor = true;
    options.ui = 'plain';
  }
  await configStore.rememberPresentation({
    screenReader: options.screenReader,
    noColor: options.noColor,
    ui: options.ui,
  });
}

const EFFORT_CHOICES: Array<{
  choice: string;
  value?: ReasoningEffort;
  label: string;
}> = [
  { choice: '1', label: 'Provider default' },
  { choice: '2', value: 'low', label: 'Low' },
  { choice: '3', value: 'medium', label: 'Medium' },
  { choice: '4', value: 'high', label: 'High' },
  { choice: '5', value: 'xhigh', label: 'Extra high' },
  { choice: '6', value: 'max', label: 'Maximum' },
];

async function askForModel(
  interface_: Questioner,
  label: string,
): Promise<string | undefined> {
  while (true) {
    const answer = (await interface_.question(label)).trim();
    if (!answer) {
      return undefined;
    }
    if (answer.length <= 200 && !/\s/.test(answer)) {
      return answer;
    }
    console.log('Enter one model name without spaces, or leave it blank.');
  }
}

async function askForEffort(
  interface_: Questioner,
  provider: string,
): Promise<ReasoningEffort | undefined> {
  console.log(`
${provider} reasoning effort:
${EFFORT_CHOICES.map(({ choice, label }) => `  ${choice}) ${label}`).join('\n')}
`);
  const choice = await askForChoice(
    interface_,
    'Choose 1–6 [1]: ',
    EFFORT_CHOICES.map((item) => item.choice),
    '1',
  );
  return EFFORT_CHOICES.find((item) => item.choice === choice)?.value;
}

export async function configureModels(
  interface_: Questioner,
  options: BridgeOptions,
  askToCustomize = true,
): Promise<void> {
  if (
    options.codexModel &&
    options.claudeModel &&
    options.codexEffort &&
    options.claudeEffort
  ) {
    return;
  }
  if (askToCustomize) {
    const customize = await askForChoice(
      interface_,
      '\nCustomize models or reasoning effort? [y/N]: ',
      ['y', 'yes', 'n', 'no'],
      'n',
    );
    if (!['y', 'yes'].includes(customize)) {
      return;
    }
  }
  if (!options.codexModel) {
    options.codexModel = await askForModel(
      interface_,
      'Codex model [provider default]: ',
    );
  }
  if (!options.claudeModel) {
    options.claudeModel = await askForModel(
      interface_,
      'Claude model [provider default]: ',
    );
  }
  if (!options.codexEffort) {
    options.codexEffort = await askForEffort(interface_, 'Codex');
  }
  if (!options.claudeEffort) {
    options.claudeEffort = await askForEffort(interface_, 'Claude');
  }
}

export function presentationLabel(options: BridgeOptions): string {
  if (options.screenReader) {
    return 'screen-reader-friendly';
  }
  const colorSuffix = options.noColor ? ', no color' : '';
  if (options.ui === 'enhanced') {
    return `enhanced${colorSuffix}`;
  }
  if (options.ui === 'auto') {
    return `enhanced when supported, otherwise standard${colorSuffix}`;
  }
  return `standard${colorSuffix}`;
}

async function askForMaxRounds(
  interface_: Questioner,
  label = 'Maximum review cycles',
  minimum = 2,
): Promise<number> {
  while (true) {
    const answer = (await interface_.question(`${label} [6]: `)).trim();
    const value = Number(answer || '6');
    if (Number.isInteger(value) && value >= minimum && value <= 20) {
      return value;
    }
    console.log(`Please enter a whole number from ${minimum} to 20.`);
  }
}

async function validRecentProjects(
  configStore: UserConfigStore,
): Promise<SelectedProject[]> {
  const config = await configStore.load();
  const valid: SelectedProject[] = [];
  for (const candidate of config.recentProjects) {
    try {
      const project = await resolveProject(candidate);
      if (!valid.some((item) => item.root === project.root)) {
        valid.push(project);
      }
    } catch {
      // Moved or deleted recent projects should not break the wizard.
    }
  }
  return valid;
}

async function askForProjectPath(
  interface_: Questioner,
  prompt: string,
): Promise<SelectedProject> {
  while (true) {
    const input = await interface_.question(prompt);
    try {
      return await resolveProject(input);
    } catch (error) {
      console.log(
        sanitizeTerminalText(
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
}

export async function chooseProject(
  interface_: Questioner,
  options: BridgeOptions,
  configStore: UserConfigStore,
  installRoot: string,
): Promise<SelectedProject> {
  if (options.cwdExplicit) {
    const project = await resolveProject(options.cwd);
    await configStore.rememberProject(project.root);
    return project;
  }

  const candidates: SelectedProject[] = [];
  if (resolve(options.cwd) !== installRoot) {
    try {
      candidates.push(await resolveProject(options.cwd));
    } catch {
      // The current folder is only a convenience candidate.
    }
  }
  for (const recent of await validRecentProjects(configStore)) {
    if (!candidates.some((candidate) => candidate.root === recent.root)) {
      candidates.push(recent);
    }
  }

  console.log('\nWhich project should the agents work on?');
  if (candidates.length === 0) {
    const project = await askForProjectPath(
      interface_,
      'Paste a project folder, or drag it into this window:\n> ',
    );
    await configStore.rememberProject(project.root);
    return project;
  }

  candidates.forEach((project, index) => {
    const kind = project.kind === 'git' ? 'Git' : 'folder';
    console.log(
      `  ${index + 1}) ${sanitizeTerminalText(project.root)} (${kind})`,
    );
  });
  console.log('  Or paste or drag in another project folder.');

  let project: SelectedProject | undefined;
  while (!project) {
    const shortcutPrompt =
      candidates.length === 1 ? 'Choose 1' : `Choose 1–${candidates.length}`;
    const input = (
      await interface_.question(
        `${shortcutPrompt}, or enter a project folder [1]: `,
      )
    ).trim();
    if (!input) {
      project = candidates[0];
      continue;
    }
    if (/^\d+$/.test(input)) {
      project = candidates[Number(input) - 1];
      if (!project) {
        console.log(
          `Please choose a number from 1 to ${candidates.length}, or enter a project folder.`,
        );
      }
      continue;
    }
    try {
      project = await resolveProject(input);
    } catch (error) {
      console.log(
        sanitizeTerminalText(
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }
  await configStore.rememberProject(project.root);
  return project;
}

interface WorkflowChoice {
  value: string;
  label: string;
  description?: string;
  action:
    | 'chat'
    | 'edit'
    | 'advanced'
    | 'collaborate-claude'
    | 'collaborate-codex'
    | 'implement-claude'
    | 'implement-codex'
    | 'review';
}

const BASE_WORKFLOWS: Array<Omit<WorkflowChoice, 'value'>> = [
  {
    action: 'chat',
    label: 'Discuss',
    description:
      'Chat with both agents without changing files. Use /edit later if you want changes.',
  },
  {
    action: 'edit',
    label: 'Make changes',
    description:
      'The agents discuss, edit in a safe workspace, and review each other’s work.',
  },
  {
    action: 'review',
    label: 'Review',
    description: 'Both agents inspect the project. No files are changed.',
  },
  {
    action: 'advanced',
    label: 'Advanced role setup',
    description: 'Choose who edits first, fixed roles, models, and limits.',
  },
];

export function workflowChoices({
  projectKind = 'git',
}: {
  projectKind?: SelectedProject['kind'];
} = {}): WorkflowChoice[] {
  return BASE_WORKFLOWS.filter(
    ({ action }) => projectKind === 'git' || action !== 'edit',
  ).map(({ action, label, description }, index) => ({
    value: String(index + 1),
    action,
    label,
    ...(description ? { description } : {}),
  }));
}

async function chooseAdvancedWorkflow(
  interface_: Questioner,
  projectKind: SelectedProject['kind'],
): Promise<WorkflowChoice['action']> {
  const allChoices: Array<{
    value: string;
    action: WorkflowChoice['action'];
    label: string;
  }> = [
    {
      value: '1',
      action: 'collaborate-claude',
      label: 'Alternate editing and review (Claude starts)',
    },
    {
      value: '2',
      action: 'collaborate-codex',
      label: 'Alternate editing and review (Codex starts)',
    },
    {
      value: '3',
      action: 'implement-claude',
      label: 'Claude edits; Codex reviews',
    },
    {
      value: '4',
      action: 'implement-codex',
      label: 'Codex edits; Claude reviews',
    },
    { value: '5', action: 'review', label: 'Review only' },
    { value: '6', action: 'chat', label: 'Discuss only' },
  ];
  const choices = allChoices.filter(
    ({ action }) =>
      projectKind === 'git' || action === 'review' || action === 'chat',
  );
  choices.forEach((choice, index) => {
    choice.value = String(index + 1);
  });
  console.log(`
Advanced role setup
${choices.map(({ value, label }) => `  ${value}) ${label}`).join('\n')}
`);
  const value = await askForChoice(
    interface_,
    `Choose 1–${choices.length} [1]: `,
    choices.map((choice) => choice.value),
    '1',
  );
  return choices.find((choice) => choice.value === value)?.action ?? 'chat';
}

async function configureAdvancedSettings(
  interface_: Questioner,
  options: BridgeOptions,
  configStore: UserConfigStore,
  chat: boolean,
): Promise<void> {
  const customize = await askForChoice(
    interface_,
    '\nCustomize advanced settings? [y/N]: ',
    ['y', 'yes', 'n', 'no'],
    'n',
  );
  if (!['y', 'yes'].includes(customize)) {
    return;
  }
  await configureModels(interface_, options, false);
  if (chat) {
    options.maxAutoRounds = await askForMaxRounds(
      interface_,
      'Maximum automatic chat exchanges',
      1,
    );
    await configurePresentation(interface_, options, true);
  } else {
    options.maxRounds = await askForMaxRounds(interface_);
  }
  await configStore.rememberPresentation({
    screenReader: options.screenReader,
    noColor: options.noColor,
    ui: options.ui,
  });
}

async function chooseReviewEvidence(
  interface_: ReadlineInterface,
  options: BridgeOptions,
): Promise<string> {
  const hasWorkingChanges = Boolean(await workingTreeStatus(options));
  console.log(`
What should they review?
  1) Current working tree${hasWorkingChanges ? ' (changes detected)' : ' (clean)'}
  2) Last commit
  3) A custom Git diff range
`);
  const defaultChoice = hasWorkingChanges ? '1' : '2';
  const choice = await askForChoice(
    interface_,
    `Choose 1, 2, or 3 [${defaultChoice}]: `,
    ['1', '2', '3'],
    defaultChoice,
  );
  if (choice === '1') {
    return 'working-tree';
  }
  if (choice === '2') {
    return 'last-commit';
  }
  while (true) {
    const range = (
      await interface_.question('Git diff range (for example main...HEAD): ')
    ).trim();
    if (range && !range.startsWith('-')) {
      return range;
    }
    console.log('Enter a non-empty Git range that does not start with "-".');
  }
}

export async function runWizard({
  options,
  appPaths,
  installRoot,
}: {
  options: BridgeOptions;
  appPaths: AppPaths;
  installRoot: string;
}): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('--wizard requires an interactive terminal');
  }
  const interface_ = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const configStore = new UserConfigStore(appPaths.configFile, (message) =>
      console.warn(sanitizeTerminalText(message)),
    );
    await configureAccessibility(interface_, options, configStore);
    const resumableRun = await new RunStateStore(
      appPaths.stateDirectory,
    ).latestIncomplete();
    const resumableChat =
      (await new ChatSessionStore(appPaths.chatsDirectory).list()).find(
        (session) => session.status !== 'completed',
      ) ?? null;
    console.log(
      options.screenReader
        ? `
Agent Bridge.
Choose a project, then say whether you want to discuss, change, or review it.
Project material needed for the task can be sent to Codex and Claude.
`
        : `
Agent Bridge
============
Choose a project, then say whether you want to discuss, change, or review it.
Project material needed for the task can be sent to Codex and Claude.
`,
    );

    if (resumableRun || resumableChat) {
      const resumeChoices: Array<{
        value: string;
        action: 'resume-run' | 'resume-chat' | 'new';
        label: string;
      }> = [];
      if (resumableChat) {
        resumeChoices.push({
          value: String(resumeChoices.length + 1),
          action: 'resume-chat',
          label: `Reopen chat for ${basename(resumableChat.projectRoot)} (${resumableChat.messages.length} messages)`,
        });
      }
      if (resumableRun) {
        resumeChoices.push({
          value: String(resumeChoices.length + 1),
          action: 'resume-run',
          label: `Continue ${resumableRun.workflow.kind} work in ${basename(resumableRun.originalCwd)}`,
        });
      }
      resumeChoices.push({
        value: String(resumeChoices.length + 1),
        action: 'new',
        label: 'Start something new',
      });
      console.log(`Continue where you left off?
${resumeChoices
  .map(({ value, label }) => `  ${value}) ${sanitizeTerminalText(label)}`)
  .join('\n')}
`);
      const resumeChoice = await askForChoice(
        interface_,
        `Choose 1–${resumeChoices.length} [1]: `,
        resumeChoices.map(({ value }) => value),
        '1',
      );
      const resumeAction = resumeChoices.find(
        ({ value }) => value === resumeChoice,
      )?.action;
      if (resumeAction === 'resume-chat' && resumableChat) {
        options.chat = true;
        options.resume = resumableChat.id;
        return;
      }
      if (resumeAction === 'resume-run' && resumableRun) {
        options.resume = resumableRun.id;
        return;
      }
    }

    const project = await chooseProject(
      interface_,
      options,
      configStore,
      installRoot,
    );
    options.cwd = project.root;

    const choices = workflowChoices({ projectKind: project.kind });
    console.log(`
What do you want to do?
${choices
  .map(
    ({ value, label, description }) =>
      `  ${value}) ${label}${description ? `\n     ${description}` : ''}`,
  )
  .join('\n')}
`);
    const choice = await askForChoice(
      interface_,
      `Choose 1–${choices.length} [1]: `,
      choices.map(({ value }) => value),
      '1',
    );
    let mode = choices.find(({ value }) => value === choice)?.action;
    if (!mode) {
      throw new Error('The selected workflow is no longer available.');
    }
    const advancedSelected = mode === 'advanced';
    if (advancedSelected) {
      mode = await chooseAdvancedWorkflow(interface_, project.kind);
    } else if (mode === 'edit') {
      mode = 'collaborate-claude';
    }
    if (mode === 'collaborate-claude') {
      options.collaborative = 'claude';
    } else if (mode === 'collaborate-codex') {
      options.collaborative = 'codex';
    } else if (mode === 'implement-claude') {
      options.implementer = 'claude';
    } else if (mode === 'implement-codex') {
      options.implementer = 'codex';
    }
    if (mode !== 'chat') {
      options.untilAgreement = true;
    }
    if (advancedSelected) {
      await configureAdvancedSettings(
        interface_,
        options,
        configStore,
        mode === 'chat',
      );
    }
    if (mode === 'chat') {
      options.chat = true;
      console.log(
        sanitizeTerminalText(`
Ready to chat${options.screenReader ? '' : '\n-------------'}
Project: ${project.root}
Presentation: ${presentationLabel(options)}
Ordinary messages are read-only and normally ask both agents (2 provider calls).
Use /ask for one agent, /auto for a bounded conversation, or /edit for safe changes.
`),
      );
      return;
    }
    if (
      project.kind === 'directory' &&
      (options.implementer || options.collaborative)
    ) {
      throw new Error(
        'Safe editing currently requires Git. Run `git init` in this folder, ' +
          'or choose review-only mode.',
      );
    }

    while (!options.task) {
      options.task = (
        await interface_.question('\nDescribe what you want them to do:\n> ')
      ).trim();
      if (!options.task) {
        console.log('Please enter a task.');
      }
    }

    if (
      !options.implementer &&
      !options.collaborative &&
      project.kind === 'git'
    ) {
      options.gitDiff = await chooseReviewEvidence(interface_, options);
    }

    const workflowKind = options.collaborative
      ? 'collaborative'
      : options.implementer
        ? 'fixed'
        : 'review';
    const firstAgent = options.collaborative ?? options.implementer;
    const preflight = await inspectWorkflowPreflight({
      mode: workflowKind,
      firstAgent,
      options,
    });
    if (options.implementer || options.collaborative) {
      const status = preflight.dirtyStatus;
      if (status && options.isolation) {
        console.log(`
This project has uncommitted changes. The safe isolated workspace starts from
committed HEAD, so agents will not see those changes.`);
        const confirmed = await askForChoice(
          interface_,
          'Continue explicitly from committed HEAD? [y/N]: ',
          ['y', 'yes', 'n', 'no'],
          'n',
        );
        if (!['y', 'yes'].includes(confirmed)) {
          throw new Error(
            'Cancelled. Commit or stash the changes and try again.',
          );
        }
        options.fromHead = true;
      } else if (status && !options.isolation) {
        const confirmed = await askForChoice(
          interface_,
          'Allow agents to edit alongside existing changes? [y/N]: ',
          ['y', 'yes', 'n', 'no'],
          'n',
        );
        if (!['y', 'yes'].includes(confirmed)) {
          throw new Error(
            'Cancelled. Commit or stash the changes and try again.',
          );
        }
        options.allowDirty = true;
      }
    }

    const projectConfig = preflight.projectConfig;
    if (
      workflowKind !== 'review' &&
      projectConfig.path &&
      projectConfig.config.verification.length > 0
    ) {
      console.log('\nProject verification commands:');
      for (const command of projectConfig.config.verification) {
        console.log(
          `  • ${sanitizeTerminalText(
            [command.command, ...command.args].join(' '),
          )}`,
        );
      }
      const trust = await askForChoice(
        interface_,
        'Allow Agent Bridge to run these commands after edits? [y/N]: ',
        ['y', 'yes', 'n', 'no'],
        'n',
      );
      options.trustProjectConfig = ['y', 'yes'].includes(trust);
    }

    console.log(
      sanitizeTerminalText(`
${formatWorkflowPreflight({
  mode: workflowKind,
  firstAgent,
  options,
  preflight,
})}
Codex model: ${options.codexModel ?? 'provider default'}
Claude model: ${options.claudeModel ?? 'provider default'}
Presentation: ${presentationLabel(options)}
Task: ${options.task}
`),
    );
    const confirmed = await askForChoice(
      interface_,
      'Start now? [Y/n]: ',
      ['y', 'yes', 'n', 'no'],
      'y',
    );
    if (!['y', 'yes'].includes(confirmed)) {
      throw new Error('Cancelled.');
    }
  } finally {
    interface_.close();
  }
}
