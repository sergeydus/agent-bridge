import {
  createInterface,
  type Interface as ReadlineInterface,
} from 'node:readline/promises';
import { resolve } from 'node:path';

import { UserConfigStore } from './config.ts';
import { ChatSessionStore } from './chat-state.ts';
import { estimateCalls } from './core.ts';
import type { AppPaths } from './paths.ts';
import type { BridgeOptions } from './options.ts';
import { loadProjectConfig } from './project-config.ts';
import { resolveProject, type SelectedProject } from './project.ts';
import { workingTreeStatus } from './snapshot.ts';
import { RunStateStore } from './state.ts';

async function askForChoice(
  interface_: ReadlineInterface,
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

async function askForMaxRounds(
  interface_: ReadlineInterface,
  label = 'Maximum review cycles',
): Promise<number> {
  while (true) {
    const answer = (await interface_.question(`${label} [6]: `)).trim();
    const value = Number(answer || '6');
    if (Number.isInteger(value) && value >= 2 && value <= 20) {
      return value;
    }
    console.log('Please enter a whole number from 2 to 20.');
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

async function chooseProject(
  interface_: ReadlineInterface,
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
  candidates.forEach((project, index) => {
    const kind = project.kind === 'git' ? 'Git' : 'folder';
    console.log(`  ${index + 1}) ${project.root} (${kind})`);
  });
  const customChoice = String(candidates.length + 1);
  console.log(`  ${customChoice}) Enter or drag in another project folder`);
  const choices = [
    ...candidates.map((_, index) => String(index + 1)),
    customChoice,
  ];
  const choice = await askForChoice(
    interface_,
    `Choose ${choices.join(', ')} [${candidates.length ? '1' : customChoice}]: `,
    choices,
    candidates.length ? '1' : customChoice,
  );

  let project: SelectedProject;
  if (choice === customChoice) {
    while (true) {
      const input = await interface_.question(
        '\nPaste a project folder, or drag it into this window:\n> ',
      );
      try {
        project = await resolveProject(input);
        break;
      } catch (error) {
        console.log(error instanceof Error ? error.message : String(error));
      }
    }
  } else {
    const selected = candidates[Number(choice) - 1];
    if (!selected) {
      throw new Error('The selected project is no longer available.');
    }
    project = selected;
  }
  await configStore.rememberProject(project.root);
  return project;
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
    const resumableRun = await new RunStateStore(
      appPaths.stateDirectory,
    ).latestIncomplete();
    const resumableChat = await new ChatSessionStore(
      appPaths.chatsDirectory,
    ).latest();
    console.log(`
Agent Bridge
============
Codex and Claude will work in turns until both agree the task is done.
Project material needed for the task may be sent to both providers.
`);
    console.log(`What should they do?
  1) Open a longer interactive chat (recommended)
  2) Collaborate: discuss first, then alternate editing (Claude starts)
  3) Collaborate: discuss first, then alternate editing (Codex starts)
  4) Fixed roles: Claude implements; Codex reviews
  5) Fixed roles: Codex implements; Claude reviews
  6) Both review only; nobody edits
  7) Continue the most recent interrupted run${
    resumableRun ? ` (${resumableRun.id})` : ' (none available)'
  }
  8) Reopen the most recent interactive chat${
    resumableChat ? ` (${resumableChat.id})` : ' (none available)'
  }
`);
    const mode = await askForChoice(
      interface_,
      'Choose 1–8 [1]: ',
      ['1', '2', '3', '4', '5', '6', '7', '8'],
      '1',
    );
    if (mode === '7') {
      if (!resumableRun) {
        throw new Error('There is no incomplete run to continue.');
      }
      options.resume = resumableRun.id;
      return;
    }
    if (mode === '8') {
      if (!resumableChat) {
        throw new Error('There is no saved interactive chat to reopen.');
      }
      options.chat = true;
      options.resume = resumableChat.id;
      return;
    }
    if (mode === '2') {
      options.collaborative = 'claude';
    } else if (mode === '3') {
      options.collaborative = 'codex';
    } else if (mode === '4') {
      options.implementer = 'claude';
    } else if (mode === '5') {
      options.implementer = 'codex';
    }
    if (mode !== '1') {
      options.untilAgreement = true;
    }

    const project = await chooseProject(
      interface_,
      options,
      new UserConfigStore(appPaths.configFile, (message) =>
        console.warn(message),
      ),
      installRoot,
    );
    options.cwd = project.root;
    console.log(`\nProject: ${project.root}`);
    if (mode === '1') {
      options.chat = true;
      options.maxRounds = await askForMaxRounds(
        interface_,
        'Maximum automatic exchanges',
      );
      console.log(`
Ready to chat
-------------
Project: ${project.root}
Automatic exchange limit: ${options.maxRounds}
Each message first returns control to you. Use /auto when you want Codex and
Claude to continue without waiting, or /implement and /collaborate when you
want the existing safe editing workflow.
`);
      const confirmed = await askForChoice(
        interface_,
        'Open the chat now? [Y/n]: ',
        ['y', 'yes', 'n', 'no'],
        'y',
      );
      if (!['y', 'yes'].includes(confirmed)) {
        throw new Error('Cancelled.');
      }
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
    options.maxRounds = await askForMaxRounds(interface_);

    if (options.implementer || options.collaborative) {
      const status = await workingTreeStatus(options);
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

    const projectConfig = await loadProjectConfig({
      projectRoot: project.root,
      configPath: options.projectConfigPath,
    });
    if (projectConfig.path && projectConfig.config.verification.length > 0) {
      console.log('\nProject verification commands:');
      for (const command of projectConfig.config.verification) {
        console.log(`  • ${[command.command, ...command.args].join(' ')}`);
      }
      const trust = await askForChoice(
        interface_,
        'Allow Agent Bridge to run these commands after edits? [y/N]: ',
        ['y', 'yes', 'n', 'no'],
        'n',
      );
      options.trustProjectConfig = ['y', 'yes'].includes(trust);
    }

    const workflowKind = options.collaborative
      ? 'collaborative'
      : options.implementer
        ? 'fixed'
        : 'review';
    const estimate = estimateCalls({
      kind: workflowKind,
      firstAgent: options.collaborative ?? options.implementer,
      maxRounds: options.maxRounds,
    });
    console.log(`
Ready to start
--------------
Mode: ${workflowKind}
Project: ${project.root}
Workspace: ${
      workflowKind === 'review'
        ? 'Selected project (read-only)'
        : options.isolation
          ? 'New isolated Git worktree'
          : 'Selected checkout'
    }
Maximum cycles: ${options.maxRounds}
Estimated calls: ${estimate.minimum}–${estimate.maximum}
Task: ${options.task}
`);
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
