import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseProviderResponse,
  TURN_RESPONSE_SCHEMA,
} from '../src/response.ts';

test('parses direct and Claude-wrapped structured responses', () => {
  assert.deepEqual(
    parseProviderResponse(
      JSON.stringify({ decision: 'done', text: 'Approved' }),
      'turn',
    ),
    { decision: 'done', text: 'Approved' },
  );
  assert.deepEqual(
    parseProviderResponse(
      JSON.stringify({
        structured_output: { decision: 'continue', text: 'Fix one issue' },
      }),
      'turn',
    ),
    { decision: 'continue', text: 'Fix one issue' },
  );
  assert.deepEqual(
    parseProviderResponse(
      JSON.stringify({
        result: JSON.stringify({ text: 'Final answer' }),
      }),
      'synthesis',
    ),
    { text: 'Final answer' },
  );
});

test('rejects ambiguous or unstructured decisions', () => {
  assert.throws(
    () =>
      parseProviderResponse(
        'Peer said done but my final decision is continue',
        'turn',
      ),
    /invalid turn response/,
  );
  assert.throws(
    () =>
      parseProviderResponse(
        '{"decision":"done","text":"Approved","unexpected":true}',
        'turn',
      ),
    /invalid turn response/,
  );
  assert.deepEqual(TURN_RESPONSE_SCHEMA.required, ['decision', 'text']);
});
