import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
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
    version: 1,
    id,
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
    status: 'active',
    projectRoot: '/tmp/project',
    projectKind: 'git',
    maxAutoRounds: 6,
    retries: 1,
    timeoutMinutes: 30,
    noTranscript: false,
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
  assert.equal(isChatSession({ ...session, unexpected: true }), false);
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
