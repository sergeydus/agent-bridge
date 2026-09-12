import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AGENT_DECISIONS,
  AGENT_NAMES,
  COMPLETION_OUTCOMES,
  PROJECT_KINDS,
  REASONING_EFFORTS,
  RUN_STATUSES,
  WORKFLOW_KINDS,
} from '../src/core.ts';
import {
  CHAT_ROLES,
  CHAT_STATUSES,
  SETTLED_EXCHANGE_OUTCOMES,
} from '../src/chat-state.ts';
import { TURN_RESPONSE_SCHEMA } from '../src/response.ts';
import { UI_MODES } from '../src/terminal-capabilities.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const schemaNames = [
  'chat-session.schema.json',
  'config.schema.json',
  'run-state.schema.json',
  'transcript.schema.json',
  'project-config.schema.json',
  'agent-response.schema.json',
] as const;

for (const name of schemaNames) {
  test(`${name} is valid JSON Schema metadata`, async () => {
    const contents = await readFile(resolve(root, 'schemas', name), 'utf8');
    const schema: unknown = JSON.parse(contents);
    assert.equal(
      (schema as { $schema?: string }).$schema,
      'https://json-schema.org/draft/2020-12/schema',
    );
    assert.equal((schema as { type?: string }).type, 'object');
  });
}

function collectReferences(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectReferences);
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  const record = value as Record<string, unknown>;
  return [
    ...(typeof record.$ref === 'string' ? [record.$ref] : []),
    ...Object.values(record).flatMap(collectReferences),
  ];
}

function resolveJsonPointer(document: unknown, pointer: string): unknown {
  return pointer
    .split('/')
    .slice(1)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce<unknown>((value, key) => {
      if (!value || typeof value !== 'object') {
        return undefined;
      }
      return (value as Record<string, unknown>)[key];
    }, document);
}

test('every local schema reference resolves to an existing definition', async () => {
  const schemas = new Map<string, unknown>();
  for (const name of schemaNames) {
    schemas.set(
      name,
      JSON.parse(await readFile(resolve(root, 'schemas', name), 'utf8')),
    );
  }

  for (const [name, schema] of schemas) {
    for (const reference of collectReferences(schema)) {
      const [referencedFile, fragment = ''] = reference.split('#');
      const targetName = referencedFile || name;
      const target = schemas.get(targetName);
      assert.ok(target, `${name} references missing schema ${targetName}`);
      if (fragment) {
        assert.notEqual(
          resolveJsonPointer(target, fragment),
          undefined,
          `${name} has unresolved reference ${reference}`,
        );
      }
    }
  }
});

test('run state schema exposes the version 3 completion record', async () => {
  const schema = JSON.parse(
    await readFile(resolve(root, 'schemas', 'run-state.schema.json'), 'utf8'),
  ) as {
    required: string[];
    properties: Record<string, Record<string, unknown>>;
    $defs: Record<string, Record<string, unknown>>;
  };

  assert.equal(schema.properties.version?.const, 3);
  assert.equal(schema.properties.completion?.$ref, '#/$defs/completion');
  assert.equal(schema.required.includes('completion'), false);
  assert.deepEqual(schema.$defs.completion?.required, [
    'outcome',
    'recordedAt',
  ]);
  assert.deepEqual(
    (schema.$defs.completion?.properties as Record<string, { enum?: string[] }>)
      .outcome?.enum,
    COMPLETION_OUTCOMES,
  );
});

test('chat session schema exposes the version 4 exchange unions', async () => {
  const schema = JSON.parse(
    await readFile(
      resolve(root, 'schemas', 'chat-session.schema.json'),
      'utf8',
    ),
  ) as {
    properties: Record<string, Record<string, unknown>>;
    $defs: Record<string, Record<string, unknown>>;
  };

  assert.equal(schema.properties.version?.const, 4);
  assert.equal(
    schema.properties.pendingExchange?.$ref,
    '#/$defs/pendingExchange',
  );
  assert.equal(
    schema.properties.latestPairedExchange?.$ref,
    '#/$defs/recordedExchange',
  );
  assert.deepEqual(schema.$defs.pendingExchange?.oneOf, [
    { $ref: '#/$defs/awaitingPeerExchange' },
    { $ref: '#/$defs/awaitingConfirmationExchange' },
  ]);
  assert.deepEqual(schema.$defs.recordedExchange?.oneOf, [
    { $ref: '#/$defs/settledExchange' },
    { $ref: '#/$defs/abandonedExchange' },
  ]);
});

/**
 * Every closed vocabulary Agent Bridge validates at runtime, keyed by the name
 * a failure should report. The published JSON Schemas are the documented
 * contract for the same persisted and provider-facing formats, so an enum in a
 * schema and the array a validator uses must not be able to drift apart: adding
 * a reasoning effort or a run status in TypeScript while leaving the schema
 * behind produces a file the tool accepts and the documentation rejects.
 */
const VOCABULARIES: ReadonlyArray<{
  name: string;
  members: readonly string[];
}> = [
  { name: 'AGENT_NAMES', members: AGENT_NAMES },
  { name: 'AGENT_DECISIONS', members: AGENT_DECISIONS },
  { name: 'WORKFLOW_KINDS', members: WORKFLOW_KINDS },
  { name: 'REASONING_EFFORTS', members: REASONING_EFFORTS },
  { name: 'PROJECT_KINDS', members: PROJECT_KINDS },
  { name: 'RUN_STATUSES', members: RUN_STATUSES },
  { name: 'COMPLETION_OUTCOMES', members: COMPLETION_OUTCOMES },
  { name: 'UI_MODES', members: UI_MODES },
  { name: 'CHAT_STATUSES', members: CHAT_STATUSES },
  { name: 'CHAT_ROLES', members: CHAT_ROLES },
  { name: 'SETTLED_EXCHANGE_OUTCOMES', members: SETTLED_EXCHANGE_OUTCOMES },
];

function collectEnums(
  value: unknown,
  pointer = '',
): Array<{ pointer: string; values: unknown[] }> {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      collectEnums(item, `${pointer}/${index}`),
    );
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  const record = value as Record<string, unknown>;
  return [
    ...(Array.isArray(record.enum)
      ? [{ pointer, values: record.enum as unknown[] }]
      : []),
    ...Object.entries(record).flatMap(([key, item]) =>
      key === 'enum' ? [] : collectEnums(item, `${pointer}/${key}`),
    ),
  ];
}

async function schemaEnums(): Promise<
  Array<{ schema: string; pointer: string; values: unknown[] }>
> {
  const found: Array<{ schema: string; pointer: string; values: unknown[] }> =
    [];
  for (const name of schemaNames) {
    const document: unknown = JSON.parse(
      await readFile(resolve(root, 'schemas', name), 'utf8'),
    );
    for (const entry of collectEnums(document)) {
      found.push({ schema: name, ...entry });
    }
  }
  return found;
}

/**
 * A nullable field spells its absence as an explicit `null` member. That is a
 * property of the field, not of the vocabulary, so it is removed before the
 * comparison rather than being added to every vocabulary that has one.
 */
function withoutNullMember(values: unknown[]): unknown[] {
  return values.filter((value) => value !== null);
}

test('every schema enum matches a declared runtime vocabulary', async () => {
  const enums = await schemaEnums();
  assert.ok(enums.length > 0, 'no schema enums were found to compare');
  for (const { schema, pointer, values } of enums) {
    const members = withoutNullMember(values);
    const match = VOCABULARIES.find(
      (vocabulary) =>
        vocabulary.members.length === members.length &&
        vocabulary.members.every((member, index) => member === members[index]),
    );
    assert.ok(
      match,
      `${schema}${pointer} has enum ${JSON.stringify(members)}, which matches ` +
        'no declared vocabulary. Update the schema and the vocabulary together, ' +
        'or add the new vocabulary to VOCABULARIES.',
    );
  }
});

test('every declared runtime vocabulary is documented by a schema', async () => {
  const enums = (await schemaEnums()).map(({ values }) =>
    JSON.stringify(withoutNullMember(values)),
  );
  for (const vocabulary of VOCABULARIES) {
    assert.ok(
      enums.includes(JSON.stringify([...vocabulary.members])),
      `${vocabulary.name} appears in no published schema, so its members are ` +
        'validated at runtime but undocumented.',
    );
  }
});

test('the provider-facing turn schema states the shared decisions', () => {
  // The runtime schema is sent to the providers and the published file
  // documents it; both describe one wire format and are asserted against the
  // same vocabulary rather than against each other's copy.
  assert.deepEqual(
    [...TURN_RESPONSE_SCHEMA.properties.decision.enum],
    [...AGENT_DECISIONS],
  );
});
