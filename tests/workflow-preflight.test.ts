import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseArgs } from '../src/options.ts';
import {
  formatWorkflowPreflight,
  type WorkflowPreflight,
} from '../src/workflow-preflight.ts';

test('workflow preview makes editing authority, cost, and safety explicit', () => {
  const project = tmpdir();
  const options = parseArgs(
    [
      '--cwd',
      project,
      '--collaborative',
      'claude',
      '--max-rounds',
      '5',
      '--from-head',
      '--trust-project-config',
    ],
    { initialCwd: project, defaultOutput: join(project, 'runs') },
  );
  const preflight: WorkflowPreflight = {
    dirtyStatus: ' M src/example.ts',
    estimate: {
      minimum: 7,
      maximum: 15,
      description: 'bounded collaborative workflow',
    },
    projectConfig: {
      path: join(project, '.agent-bridge.json'),
      config: {
        version: 1,
        protectedPaths: [],
        verification: [{ command: 'npm', args: ['test'] }],
      },
    },
  };
  const preview = formatWorkflowPreflight({
    mode: 'collaborative',
    firstAgent: 'claude',
    options,
    preflight,
  });

  assert.match(preview, /Claude edits first/);
  assert.match(preview, /isolated Git worktree/);
  assert.match(preview, /committed HEAD/);
  assert.match(preview, /verification command\(s\) approved/);
  assert.match(preview, /Maximum cycles: 5/);
  assert.match(preview, /Estimated provider calls: 7–15/);
  assert.match(preview, /not commit, push, or stage/);
  assert.match(preview, /apply, keep, or discard/);
});

test('review preview never implies write access or patch handling', () => {
  const project = tmpdir();
  const options = parseArgs([], {
    initialCwd: project,
    defaultOutput: join(project, 'runs'),
  });
  const preview = formatWorkflowPreflight({
    mode: 'review',
    options,
    preflight: {
      dirtyStatus: '',
      estimate: {
        minimum: 3,
        maximum: 13,
        description: 'bounded review workflow',
      },
      projectConfig: {
        config: { version: 1, protectedPaths: [], verification: [] },
      },
    },
  });

  assert.match(preview, /Both agents review; nobody edits/);
  assert.match(preview, /Selected project \(read-only\)/);
  assert.doesNotMatch(preview, /apply, keep, or discard/);
});
