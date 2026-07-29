import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
