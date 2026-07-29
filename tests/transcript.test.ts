import assert from 'node:assert/strict';
import test from 'node:test';

import { formatMarkdownTranscript } from '../src/transcript.ts';

test('formats a readable transcript from the persisted structure', () => {
  const markdown = formatMarkdownTranscript({
    metadata: {
      startedAt: '2026-07-29T00:00:00.000Z',
      cwd: '/project',
      agentCwd: '/workspace',
      workspace: '/workspace',
      roundCount: 1,
      judge: 'codex',
      untilAgreement: true,
      converged: true,
      implementer: null,
      collaborative: 'claude',
      projectKind: 'git',
      baseRevision: 'abc123',
      finalRevision: 'def456',
    },
    task: 'Implement the task',
    rounds: [
      {
        phase: 'Implementation',
        round: 1,
        codex: 'Approved',
        claude: 'Implemented',
      },
    ],
    synthesis: 'Ready to ship',
  });

  assert.match(markdown, /Converged: yes/);
  assert.match(markdown, /Implementation Round 1/);
  assert.match(markdown, /Ready to ship/);
});
