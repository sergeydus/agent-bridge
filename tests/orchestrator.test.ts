import assert from 'node:assert/strict';
import test from 'node:test';

import { runOrchestration } from '../src/orchestrator.ts';
import type { AgentResponse } from '../src/response.ts';
import { ProgressReporter } from '../src/ui.ts';

for (const workflowKind of ['review', 'fixed', 'collaborative'] as const) {
  for (const mode of ['plain', 'screen-reader', 'silent'] as const) {
    test(`${workflowKind} prints complete final responses in ${mode} mode`, async (t) => {
      const chunks: string[] = [];
      t.mock.method(process.stdout, 'write', (chunk: unknown) => {
        chunks.push(String(chunk));
        return true;
      });
      const responses: Array<{ agent: string; text: string }> = [];
      const result = await runOrchestration({
        task: 'Make the entire conversation readable',
        workflowKind,
        firstAgent: 'claude',
        roundLimit: 1,
        untilAgreement: false,
        judge: 'codex',
        dryRun: false,
        reporter: new ProgressReporter({
          screenReader: mode === 'screen-reader',
          silent: mode === 'silent',
        }),
        runAgent: async (agent, _prompt, options) => {
          if (options.responseKind === 'synthesis') {
            return { text: 'Synthesis ready' };
          }
          const text = [
            `Start of ${agent} turn ${responses.length + 1}.`,
            'Complete analysis beyond the old summary limit. '.repeat(10),
            '```ts',
            'const complete = true;',
            '```',
            `End of ${agent} turn ${responses.length + 1}.`,
          ].join('\n');
          responses.push({ agent, text });
          return { text: `${text}\u001B[2J\u202E`, decision: 'done' };
        },
        captureWorkspace: async () => ({
          snapshot: 'Captured workspace',
          revision: 'same-revision',
        }),
        runVerification: async () => 'PASS',
        checkpoint: async () => {},
      });

      // Presentation sanitizes the terminal without rewriting saved evidence.
      assert.ok(result.rounds.every((round) => round.codex.includes('\u001B')));
      assert.ok(
        result.rounds.every((round) => round.claude.includes('\u202E')),
      );
      if (mode === 'silent') {
        assert.deepEqual(chunks, []);
        return;
      }
      const output = chunks.join('');
      for (const response of responses) {
        const blocks = chunks.filter((chunk) => chunk.includes(response.text));
        assert.equal(blocks.length, 1, 'one complete block per final response');
        assert.match(
          blocks[0] ?? '',
          new RegExp(
            `${response.agent === 'codex' ? 'Codex' : 'Claude'} response:`,
          ),
        );
        assert.ok(blocks[0]?.includes('\n\nDecision: DONE\n'));
        assert.equal(output.split(response.text.split('\n')[0]!).length - 1, 1);
      }
      assert.equal(output.includes('\u001B'), false);
      assert.equal(output.includes('\u202E'), false);
      if (mode === 'screen-reader') {
        assert.doesNotMatch(output, /[─●✓]/);
      }
    });
  }
}

test('alternates writers and converges only after a reviewer approves the same cycle', async () => {
  const writes: string[] = [];
  const checkpoints: string[] = [];
  let implementationCalls = 0;
  let captureCalls = 0;

  const result = await runOrchestration({
    task: 'Implement a safe change',
    workflowKind: 'collaborative',
    firstAgent: 'claude',
    roundLimit: 3,
    untilAgreement: true,
    judge: 'codex',
    dryRun: false,
    reporter: new ProgressReporter({ silent: true }),
    runAgent: async (agent, _prompt, options): Promise<AgentResponse> => {
      if (options.responseKind === 'synthesis') {
        return { text: 'Ready to ship' };
      }
      if (options.writeAccess) {
        writes.push(agent);
        implementationCalls += 1;
        return {
          text: `${agent} implemented`,
          decision: implementationCalls === 1 ? 'continue' : 'done',
        };
      }
      const isPlanning = writes.length === 0;
      return {
        text: `${agent} reviewed`,
        decision: isPlanning || implementationCalls === 1 ? 'continue' : 'done',
      };
    },
    captureWorkspace: async () => {
      captureCalls += 1;
      return {
        snapshot: `snapshot-${captureCalls}`,
        revision: `revision-${Math.min(2, Math.ceil(captureCalls / 2))}`,
        changedFiles: 1,
      };
    },
    runVerification: async () => 'PASS npm test',
    checkpoint: async (checkpoint) => {
      checkpoints.push(checkpoint.status);
    },
  });

  assert.deepEqual(writes, ['claude', 'codex']);
  assert.equal(result.converged, true);
  assert.equal(result.synthesis, 'Ready to ship');
  assert.match(result.rounds.at(-1)?.codex ?? '', /Revision: revision-2/);
  assert.ok(checkpoints.includes('implementing'));
  assert.ok(checkpoints.includes('reviewing'));
  assert.equal(
    captureCalls,
    5,
    'each writer is checkpointed before checks and reviewed after checks',
  );
});

test('fixed-round review completes without pretending agreement was requested', async () => {
  const result = await runOrchestration({
    task: 'Review this',
    workflowKind: 'review',
    roundLimit: 1,
    untilAgreement: false,
    judge: 'claude',
    dryRun: false,
    reporter: new ProgressReporter({ silent: true }),
    runAgent: async (_agent, _prompt, options) =>
      options.responseKind === 'synthesis'
        ? { text: 'Review complete' }
        : { text: 'One review', decision: 'continue' },
    captureWorkspace: async () => ({ snapshot: 'unused' }),
    runVerification: async () => 'unused',
    checkpoint: async () => {},
  });
  assert.equal(result.converged, false);
  assert.equal(result.synthesis, 'Review complete');
});

test('resumes a pending review without repeating the completed write', async () => {
  const calls: Array<{ agent: string; writeAccess: boolean }> = [];
  const result = await runOrchestration({
    task: 'Resume safely',
    workflowKind: 'fixed',
    firstAgent: 'claude',
    roundLimit: 1,
    untilAgreement: true,
    judge: 'codex',
    dryRun: false,
    initial: {
      currentRevision: 'saved-revision',
      pendingReview: {
        round: 1,
        implementer: 'claude',
        implementerResponse: 'The edit completed before interruption.',
        implementerDecision: 'done',
        revision: 'saved-revision',
        verification: 'PASS npm test',
        verificationComplete: true,
      },
    },
    reporter: new ProgressReporter({ silent: true }),
    runAgent: async (agent, prompt, options) => {
      calls.push({ agent, writeAccess: options.writeAccess });
      if (options.responseKind === 'synthesis') {
        return { text: 'Recovered safely' };
      }
      assert.match(prompt, /edit completed before interruption/);
      return { text: 'Review approved', decision: 'done' };
    },
    captureWorkspace: async () => ({
      snapshot: 'saved snapshot',
      revision: 'saved-revision',
    }),
    runVerification: async () => {
      throw new Error('Saved verification should be reused');
    },
    checkpoint: async () => {},
  });

  assert.deepEqual(calls, [
    { agent: 'codex', writeAccess: false },
    { agent: 'codex', writeAccess: false },
  ]);
  assert.equal(result.converged, true);
  assert.equal(result.pendingReview, undefined);
});

test('does not converge when verification changes the writer revision', async () => {
  let capture = 0;
  const result = await runOrchestration({
    task: 'Keep decisions revision-specific',
    workflowKind: 'fixed',
    firstAgent: 'claude',
    roundLimit: 1,
    untilAgreement: true,
    judge: 'codex',
    dryRun: false,
    reporter: new ProgressReporter({ silent: true }),
    runAgent: async (_agent, prompt, options) => {
      if (options.responseKind === 'synthesis') {
        return { text: 'Verification changed the result' };
      }
      if (!options.writeAccess) {
        assert.match(prompt, /verification commands changed the workspace/);
      }
      return { text: 'Approved', decision: 'done' };
    },
    captureWorkspace: async () => {
      capture += 1;
      return {
        snapshot: `snapshot-${capture}`,
        revision: capture === 1 ? 'writer-revision' : 'verified-revision',
      };
    },
    runVerification: async () => 'PASS generator',
    checkpoint: async () => {},
  });

  assert.equal(result.converged, false);
  assert.equal(result.rounds[0]?.claudeDecision, 'continue');
  assert.equal(result.rounds[0]?.codexDecision, 'done');
});
