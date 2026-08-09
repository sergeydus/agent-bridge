import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ChatSessionStore,
  formatChatTranscript,
  isChatSession,
  LEGACY_PENDING_EXCHANGE_WARNING,
  type ChatSession,
  type ChatMessage,
} from '../src/chat-state.ts';

function makeSession(id = 'chat-test'): ChatSession {
  return {
    version: 4,
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

function message(
  sequence: number,
  role: ChatMessage['role'],
  decision?: ChatMessage['decision'],
): ChatMessage {
  return {
    sequence,
    createdAt: '2026-07-29T00:00:00.000Z',
    role,
    text: `${role} message ${sequence}`,
    ...(decision === undefined ? {} : { decision }),
  };
}

function versionThreeSession(
  id: string,
  status: ChatSession['status'],
  messages: ChatMessage[],
  pendingExchange?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...makeSession(id),
    version: 3,
    status,
    messages,
    ...(pendingExchange === undefined ? {} : { pendingExchange }),
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
      assert.equal(session.version, 4);
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

test('migrates final version 3 pending responses by session status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-v3-'));
  try {
    const store = new ChatSessionStore(directory);
    const pending = {
      firstAgent: 'codex',
      secondAgent: 'claude',
      firstMessageSequence: 2,
    };
    for (const status of ['active', 'paused'] as const) {
      const id = `chat-${status}`;
      await writeFile(
        store.pathFor(id),
        JSON.stringify(
          versionThreeSession(
            id,
            status,
            [message(1, 'user'), message(2, 'codex', 'continue')],
            pending,
          ),
        ),
      );
      const migrated = await store.load(id);
      assert.deepEqual(migrated.pendingExchange, {
        stage: 'awaiting-peer',
        ...pending,
      });
      assert.equal(migrated.latestPairedExchange, undefined);
    }

    const completedId = 'chat-completed';
    await writeFile(
      store.pathFor(completedId),
      JSON.stringify(
        versionThreeSession(
          completedId,
          'completed',
          [message(1, 'user'), message(2, 'codex', 'done')],
          pending,
        ),
      ),
    );
    const completed = await store.load(completedId);
    assert.equal(completed.pendingExchange, undefined);
    assert.deepEqual(completed.latestPairedExchange, {
      firstAgent: 'codex',
      secondAgent: 'claude',
      firstMessageSequence: 2,
      outcome: 'abandoned',
    });

    completed.status = 'active';
    await store.save(completed);
    assert.deepEqual(
      (await store.load(completedId)).latestPairedExchange,
      completed.latestPairedExchange,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('drops only ambiguous legacy pending metadata and warns once per load', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-v3-gap-'));
  const warnings: string[] = [];
  try {
    const store = new ChatSessionStore(directory, (warning) =>
      warnings.push(warning),
    );
    const id = 'chat-ambiguous-pending';
    const messages = [
      message(1, 'user'),
      message(2, 'codex', 'continue'),
      message(3, 'system'),
    ];
    await writeFile(
      store.pathFor(id),
      JSON.stringify(
        versionThreeSession(id, 'completed', messages, {
          firstAgent: 'codex',
          secondAgent: 'claude',
          firstMessageSequence: 2,
        }),
      ),
    );

    const direct = await store.load(id);
    assert.equal(direct.version, 4);
    assert.equal(direct.status, 'completed');
    assert.deepEqual(direct.messages, messages);
    assert.equal(direct.pendingExchange, undefined);
    assert.equal(direct.latestPairedExchange, undefined);
    assert.deepEqual(warnings, [LEGACY_PENDING_EXCHANGE_WARNING]);

    assert.equal((await store.list())[0]?.id, id);
    assert.equal(warnings.length, 2);
    assert.equal((await store.latest())?.id, id);
    assert.equal(warnings.length, 3);
    assert.ok(
      warnings.every((warning) => warning === LEGACY_PENDING_EXCHANGE_WARNING),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects legacy chats whose version-specific fields were never valid', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bridge-chat-bad-'));
  try {
    const store = new ChatSessionStore(directory);
    const write = async (
      id: string,
      legacy: Record<string, unknown>,
    ): Promise<void> => {
      const { color, ...rest } = makeSession(id);
      void color;
      await writeFile(
        join(directory, `${id}.json`),
        JSON.stringify({ ...rest, version: 2, ...legacy }),
      );
    };

    // Migration drops `noColor`, so an unchecked malformed value would be
    // laundered into an accepted record claiming no color choice was made.
    await write('chat-bad-nocolor', { noColor: 'yes' });
    await assert.rejects(() => store.load('chat-bad-nocolor'), /Invalid saved/);

    // `color` did not exist before version 3, so a version 2 record carrying it
    // was never legitimate and must not pass by surviving the migration.
    await write('chat-early-color', { color: true });
    await assert.rejects(() => store.load('chat-early-color'), /Invalid saved/);

    // A version 1 record is held to the same rule.
    const { color, ...rest } = makeSession('chat-v1-color');
    void color;
    await writeFile(
      join(directory, 'chat-v1-color.json'),
      JSON.stringify({ ...rest, version: 1, color: false }),
    );
    await assert.rejects(() => store.load('chat-v1-color'), /Invalid saved/);
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

test('validates version 4 pending and recorded exchange invariants', () => {
  const confirmedMessages = [
    message(1, 'user'),
    message(2, 'codex', 'done'),
    message(3, 'claude', 'done'),
    message(4, 'codex', 'done'),
  ];
  const confirmed = {
    ...makeSession('chat-confirmed'),
    messages: confirmedMessages,
    latestPairedExchange: {
      firstAgent: 'codex' as const,
      secondAgent: 'claude' as const,
      firstMessageSequence: 2,
      secondMessageSequence: 3,
      confirmationMessageSequence: 4,
      outcome: 'confirmed' as const,
    },
  };
  assert.equal(isChatSession(confirmed), true);
  assert.equal(
    isChatSession({
      ...confirmed,
      latestPairedExchange: {
        ...confirmed.latestPairedExchange,
        outcome: 'open',
      },
    }),
    false,
  );
  assert.equal(
    isChatSession({
      ...confirmed,
      messages: confirmedMessages.map((entry) =>
        entry.sequence === 4 ? { ...entry, decision: 'continue' } : entry,
      ),
      latestPairedExchange: {
        ...confirmed.latestPairedExchange,
        outcome: 'open',
      },
    }),
    true,
  );
  assert.equal(
    isChatSession({
      ...confirmed,
      latestPairedExchange: {
        ...confirmed.latestPairedExchange,
        confirmationMessageSequence: undefined,
      },
    }),
    false,
  );

  const awaitingPeer = {
    ...makeSession('chat-awaiting-peer'),
    messages: [message(1, 'user'), message(2, 'codex', 'continue')],
    pendingExchange: {
      stage: 'awaiting-peer' as const,
      firstAgent: 'codex' as const,
      secondAgent: 'claude' as const,
      firstMessageSequence: 2,
    },
  };
  assert.equal(isChatSession(awaitingPeer), true);
  assert.equal(isChatSession({ ...awaitingPeer, status: 'completed' }), false);
  assert.equal(
    isChatSession({
      ...awaitingPeer,
      messages: [...awaitingPeer.messages, message(3, 'system')],
    }),
    false,
  );
  assert.equal(
    isChatSession({
      ...awaitingPeer,
      pendingExchange: { ...awaitingPeer.pendingExchange, stage: 'unknown' },
    }),
    false,
  );

  const awaitingConfirmation = {
    ...makeSession('chat-awaiting-confirmation'),
    messages: [
      message(1, 'user'),
      message(2, 'codex', 'done'),
      message(3, 'claude', 'done'),
    ],
    pendingExchange: {
      stage: 'awaiting-confirmation' as const,
      firstAgent: 'codex' as const,
      secondAgent: 'claude' as const,
      firstMessageSequence: 2,
      secondMessageSequence: 3,
    },
  };
  assert.equal(isChatSession(awaitingConfirmation), true);
  assert.equal(
    isChatSession({
      ...awaitingConfirmation,
      messages: awaitingConfirmation.messages.map((entry) =>
        entry.sequence === 3 ? { ...entry, decision: 'continue' } : entry,
      ),
    }),
    false,
  );

  const abandoned = {
    ...makeSession('chat-abandoned'),
    status: 'completed' as const,
    messages: [message(1, 'user'), message(2, 'codex', 'continue')],
    latestPairedExchange: {
      firstAgent: 'codex' as const,
      secondAgent: 'claude' as const,
      firstMessageSequence: 2,
      outcome: 'abandoned' as const,
    },
  };
  assert.equal(isChatSession(abandoned), true);
  assert.equal(
    isChatSession({
      ...abandoned,
      latestPairedExchange: {
        ...abandoned.latestPairedExchange,
        secondAgent: 'codex',
      },
    }),
    false,
  );
  const abandonedConfirmation = {
    ...makeSession('chat-abandoned-confirmation'),
    status: 'completed' as const,
    messages: [
      message(1, 'user'),
      message(2, 'codex', 'done'),
      message(3, 'claude', 'done'),
    ],
    latestPairedExchange: {
      firstAgent: 'codex' as const,
      secondAgent: 'claude' as const,
      firstMessageSequence: 2,
      secondMessageSequence: 3,
      outcome: 'abandoned' as const,
    },
  };
  assert.equal(isChatSession(abandonedConfirmation), true);
  assert.equal(
    isChatSession({
      ...abandonedConfirmation,
      messages: abandonedConfirmation.messages.map((entry) =>
        entry.sequence === 2 ? { ...entry, decision: 'continue' } : entry,
      ),
    }),
    false,
  );

  const laterPending = {
    ...makeSession('chat-later-pending'),
    messages: [
      message(1, 'user'),
      message(2, 'codex', 'continue'),
      message(3, 'claude', 'done'),
      message(4, 'user'),
      message(5, 'claude', 'continue'),
    ],
    latestPairedExchange: {
      firstAgent: 'codex' as const,
      secondAgent: 'claude' as const,
      firstMessageSequence: 2,
      secondMessageSequence: 3,
      outcome: 'open' as const,
    },
    pendingExchange: {
      stage: 'awaiting-peer' as const,
      firstAgent: 'claude' as const,
      secondAgent: 'codex' as const,
      firstMessageSequence: 5,
    },
  };
  assert.equal(isChatSession(laterPending), true);
  assert.equal(
    isChatSession({
      ...laterPending,
      pendingExchange: {
        ...laterPending.pendingExchange,
        firstMessageSequence: 2,
        firstAgent: 'codex',
        secondAgent: 'claude',
      },
    }),
    false,
  );
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
    assert.equal(migrated.version, 4);
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
