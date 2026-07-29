# Architecture

Agent Bridge is a local state-machine coordinator, not a shared provider
session. Each provider call receives the task or bounded chat history, relevant
evidence, current role, and previous handoff required for that turn.

## Independent boundaries

Three filesystem locations must never be conflated:

1. **Installation** — source checkout or installed package.
2. **Target project** — a user-selected Git repository or ordinary directory.
3. **User data** — preferences, checkpoints, transcripts, patches, and
   temporary worktrees in a platform application-data directory.

`AGENT_BRIDGE_HOME` overrides user data for portable use and tests.

## Components

```text
bin/agent-bridge.mjs
  └─ CLI composition (cli.ts)
      ├─ options + wizard ───────── options.ts, wizard.ts
      ├─ terminal presentation ──── presentation.ts, ui.ts
      ├─ interactive chat ──────── chat.ts, chat-input.ts,
      │                           chat-state.ts, chat-workflow.ts
      ├─ task + review evidence ── task.ts
      ├─ project + instructions ── project.ts, instructions.ts
      ├─ trusted config ────────── project-config.ts, verification.ts
      ├─ orchestration ─────────── orchestrator.ts
      │    ├─ rules + types ────── core.ts
      │    ├─ prompts ──────────── prompts.ts
      │    └─ provider contract ── response.ts
      ├─ provider adapters ─────── providers.ts
      │    └─ process lifecycle ── process.ts
      ├─ workspace evidence ────── snapshot.ts
      ├─ Git isolation ─────────── git.ts, artifacts.ts
      ├─ checkpoints + history ─── state.ts, runs.ts
      │                              run-management.ts
      ├─ transcripts ───────────── transcript.ts
      └─ diagnostics ───────────── doctor.ts
```

The CLI composes modules but does not decide turn order. The orchestrator does
not know Codex or Claude command-line syntax. Provider adapters do not decide
whether a turn converged.

Interactive chat is a higher-level coordinator. Its ordinary turns are always
read-only. Editing and formal review commands launch the existing one-shot
workflow as a child process with inherited terminal control, so repository
safety has one implementation rather than two.

Presentation is resolved once at the CLI boundary. Semantic speaker and
progress formatting lives outside provider orchestration, while provider
adapters receive only the accessibility capability they need to construct
their own CLI arguments.

## Turn data flow

```text
task + shared instructions + previous handoff
                    │
                    ▼
             role-specific prompt
                    │
                    ▼
              provider adapter
                    │
                    ▼
       structured { decision, text }
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
 captured workspace       checkpoint/transcript
 revision + checks
        │
        ▼
 read-only reviewer of that revision
```

Task, transcript, diff, and response material is JSON-serialized when embedded
in prompts so user-controlled delimiters cannot masquerade as instructions.

## Workspace model

Review-only runs operate directly on the selected project with provider
write access disabled. Ordinary directories are supported in this mode.

Editing requires Git. By default a detached worktree is created beneath the
run-data directory from the source repository's committed `HEAD`. Agent edits,
snapshots, verification, and reviews all use that isolated path. Completion
produces a portable binary patch using an alternate Git index, which includes
tracked changes, deletions, executable-bit changes, symlinks, binaries, and
ordinary untracked files without mutating the real index.

Direct editing is an explicit advanced mode. When accepted beside existing
changes, those paths are fingerprinted before the first agent call and checked
after every writer.

## Persistence

`RunStateStore` validates versioned checkpoints at runtime, migrates supported
legacy state, writes through a unique temporary file and atomic rename, and
uses an exclusive run lock for resume. State is saved before and after
important external work so an interrupted process has a conservative recovery
point.

Successful runs create Markdown and JSON transcripts plus a small context
manifest. `--no-transcript` still uses an active checkpoint for recovery and
removes it after success.

`ChatSessionStore` independently validates and atomically saves ordered chat
messages, linked workflow events, and resumable status. It also writes a
derived Markdown transcript and uses an exclusive lock. Completed chats remain
reopenable unless `--no-transcript` requested deletion.

Schemas in `schemas/` document persisted and provider-facing formats.

## Compiled and source execution

`npm run build` compiles strict TypeScript to `dist/` with declarations and
source maps. The launcher prefers compiled `dist/cli.js`. A source checkout can
still run on Node 22.6+ using built-in TypeScript type stripping when `dist/`
does not exist.

There are no production npm dependencies.
