import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ChatSessionStore,
  formatChatTranscript,
  isChatSession,
  type ChatSession,
} from '../src/chat-state.ts';

function makeSession(id = 'chat-test'): ChatSession {
  return {
    version: 3,
    id,
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    status: 'active',
    projectRoot: '/tmp/project',
    projectKind: 'git',
    maxAutoRounds: 6,
    maxWorkflowRounds: 6,
    retries: 1,
    timeoutMinutes: 30,
    noTranscript: false,
    ui: 'plain',
    messages: [
      {
        sequence: 1,
        createdAt: '2026-07-29T00:00:00.000Z',
        role: 'user',
        text: 'Review this',
      },
    ],
    workflows: [],
  };
}

test('migrates a saved chat without inventing a color choice', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-v2-'));
  try {
    const store = new ChatSessionStore(directory);
    const load = async (
      id: string,
      noColor: boolean | undefined,
    ): Promise<boolean | undefined | 'absent'> => {
      const { color, ...rest } = makeSession(id);
      void color;
      await writeFile(
        join(directory, `${id}.json`),
        JSON.stringify({
          ...rest,
          version: 2,
          ...(noColor === undefined ? {} : { noColor }),
        }),
      );
      const session = await store.load(id);
      assert.equal(session.version, 3);
      return 'color' in session ? session.color : 'absent';
    };

    // An intentional `--no-color` survives as an explicit "no color".
    assert.equal(await load('chat-nocolor', true), false);
    // The CLI that wrote `noColor: false` had no `--color`, so it only meant
    // "nothing was chosen" and NO_COLOR still applied. Promoting it to an
    // explicit color-on would make legacy chats start overriding NO_COLOR.
    assert.equal(await load('chat-default', false), 'absent');
    assert.equal(await load('chat-absent', undefined), 'absent');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('persists private chat state and a readable transcript', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-state-'));
  try {
    const store = new ChatSessionStore(directory);
    const session = makeSession();
    await store.save(session);

    assert.equal(
      (await store.load(session.id)).messages[0]?.text,
      'Review this',
    );
    assert.equal((await store.latest())?.id, session.id);
    assert.match(
      formatChatTranscript(session),
      /Agent Bridge Interactive Chat/,
    );
    assert.match(formatChatTranscript(session), /Review this/);

    await store.delete(session.id);
    assert.equal(await store.latest(), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('validates chat sequences, limits, and unexpected properties', () => {
  const session = makeSession();
  assert.equal(isChatSession(session), true);
  assert.equal(
    isChatSession({
      ...session,
      messages: [{ ...session.messages[0], sequence: 2 }],
    }),
    false,
  );
  assert.equal(isChatSession({ ...session, maxAutoRounds: 21 }), false);
  assert.equal(isChatSession({ ...session, maxWorkflowRounds: 0 }), false);
  assert.equal(isChatSession({ ...session, ui: 'unknown' }), false);
  assert.equal(isChatSession({ ...session, screenReader: 'yes' }), false);
  assert.equal(isChatSession({ ...session, nextFirstAgent: 'other' }), false);
  assert.equal(isChatSession({ ...session, unexpected: true }), false);
});

test('migrates version 1 chat limits and presentation safely', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-v1-'));
  try {
    const legacy = {
      ...makeSession('chat-legacy'),
      version: 1,
    } as Record<string, unknown>;
    delete legacy.maxWorkflowRounds;
    delete legacy.ui;
    const store = new ChatSessionStore(directory);
    await writeFile(
      store.pathFor('chat-legacy'),
      `${JSON.stringify(legacy)}\n`,
    );
    const migrated = await store.load('chat-legacy');
    assert.equal(migrated.version, 3);
    assert.equal(migrated.maxWorkflowRounds, 6);
    assert.equal(migrated.ui, 'plain');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('locks a chat against concurrent use', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-lock-'));
  try {
    const store = new ChatSessionStore(directory);
    const lock = await store.acquireLock('chat-locked');
    await assert.rejects(
      () => store.acquireLock('chat-locked'),
      /already open/,
    );
    await lock.release();
    const next = await store.acquireLock('chat-locked');
    await next.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('transcript-free chat retains only its active JSON checkpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-private-'));
  try {
    const store = new ChatSessionStore(directory);
    const session = { ...makeSession('chat-private'), noTranscript: true };
    await store.save(session);
    await access(store.pathFor(session.id));
    await assert.rejects(
      () => access(store.transcriptPathFor(session.id)),
      /ENOENT/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
