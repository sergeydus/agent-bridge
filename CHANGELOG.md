# Changelog

## Unreleased

- Made complete enhanced-chat responses automatically available in native
  terminal scrollback while retaining the full-screen view for active work.
- Fixed explicit `--ui auto` and `--ui enhanced` overrides being rejected at
  wizard startup before the wizard could select interactive chat mode.
- Made automatic enhanced chat presentation the default for new sessions on
  capable interactive terminals, while preserving saved choices and the plain
  fallback for screen readers, redirected streams, and unsupported terminals.
- Made enhanced chat feel live during provider work with bounded 50 ms stream
  redraws, low-frequency activity animation, lower-flicker in-place updates,
  and a status footer showing the active agent, phase, elapsed time, model,
  token usage when available, and read-only safety mode.
- Fixed implementation agents never receiving write access on Windows. The
  multi-line Claude system prompt truncated the `cmd.exe` command line used for
  npm `.cmd` shims, silently discarding every later argument — including
  `--permission-mode acceptEdits` — so Claude ran with default permissions and
  refused every edit. Provider arguments are now single-line, and `runProcess`
  refuses to spawn a command Windows would truncate instead of running it.
- Fixed Codex rejecting every edit on Windows. `--ignore-user-config` also
  discarded the `windows.sandbox` setting that activates its restricted-token
  sandbox, so `--sandbox workspace-write` degraded to read-only. Agent Bridge
  now supplies that setting itself.
- Made `--safe-mode` and `--ax-screen-reader` capability-gated. Both exist in
  current Claude Code but not in every installed version, and argument
  truncation had been hiding the resulting aborted calls. Agent Bridge now
  probes the CLI's own help output once per session and uses each flag only
  where it is offered, so project customizations stay excluded and the native
  accessible renderer stays available wherever the installed CLI supports them.
  `--doctor` reports which optional flags were detected. `--dry-run` never
  runs the probe, so it stays side-effect free and immediate.
- Fixed the change summary reporting the first changed file as staged and
  without its first character, caused by trimming the leading space of a
  porcelain status record.

- Fixed a failed provider preflight marking a resumed chat `paused`, and
  saving a ghost session for a new chat, instead of leaving persisted state
  untouched; also fixed a partially failed checkpoint save (JSON written,
  transcript write failed) leaving the saved chat `active` instead of
  `paused`.
- Fixed resuming a chat that is already open in another Agent Bridge process
  reporting a provider-availability error instead of the actual lock conflict.
- Fixed Windows editing when the target project and Agent Bridge run-data
  directory are on different drive letters.
- Fixed launching npm-installed Codex and Claude `.cmd` shims on Windows, and
  added actionable provider checks before chats or workflow workspace creation.
- Kept editing workflows visible for non-Git and not-yet-committed projects,
  added explicit, non-staging `git init` guidance to the novice wizard, and
  made direct CLI and chat editing report the missing initial commit clearly.
- Reworked first-run setup around project-first Discuss, Make changes, and
  Review intents, with provider roles and model/interface tuning under
  Advanced settings.
- Added a persisted first-run accessibility choice and restored chat UI mode
  across resumes, with safe migrations for existing local configuration and
  chat checkpoints.
- Added the recommended `/edit` command and a shared workflow preview covering
  roles, isolation, dirty changes, verification, limits, and provider-call
  estimates before any chat-launched workflow starts.
- Separated automatic-chat exchange limits from editing-workflow cycle limits,
  added `/auto` cost confirmation, and made Ctrl+C cancel active provider work
  while keeping the chat open.
- Simplified first-run setup by accepting pasted or dragged project folders
  directly, hiding unavailable resume actions, and offering the safe automatic
  enhanced chat presentation in the wizard. Workflow descriptions and chat
  onboarding now explicitly distinguish read-only discussion from commands
  that start safe code editing.
- Added the opt-in Phase 3 enhanced chat preview with compact, stacked, and
  wide terminal layouts.
- Added conservative `--ui plain|enhanced|auto` capability resolution,
  screen-reader fallback, resize redraws, and alternate-screen restoration
  around child workflows and exit.
- Added Unicode grapheme width handling and terminal-control sanitization for
  rendered conversation content.
- Added recoverable enhanced-to-plain renderer fallback, exception-safe chat
  cleanup, readable supplemental command output, and bidirectional-control
  sanitization.
- Prevented a failed chat-lock acquisition from saving over the session owned
  by another Agent Bridge process.
- Extended terminal-control sanitization to plain, screen-reader, wizard,
  diagnostics, and run-management output.
- Added redirected-input chat sessions, exception-safe terminal cleanup,
  shared atomic persistence and locking, and lock-owner-safe run recovery.
- Bounded large instruction, diff, snapshot, task-file, checkpoint, and
  provider-process reads; patches and workspace fingerprints now stream
  without buffering the complete diff.
- Refused legacy patch application when the saved run has no verifiable base
  revision.

## 0.5.0

- Added live, provider-neutral progress events from Codex JSONL and Claude
  stream-json output.
- Added readable streaming updates in interactive chat and atomic,
  speaker-labeled updates where concurrent providers could otherwise
  interleave.
- Kept schema-validated final responses authoritative and excluded private
  reasoning, raw commands, tool inputs, and file paths from live output.
- Added buffered screen-reader updates, bounded live output, deterministic
  split-chunk fixtures, and streaming process cancellation tests.
- Preserved source execution on the declared Node 22.6 minimum and enforced LF
  checkouts so the same formatting checks pass on Windows.

## 0.4.0

- Added targeted `/ask`, `/both`, and `@agent` interactive turns.
- Added Tab completion and bounded, deduplicated in-process input history.
- Added screen-reader-friendly, append-only terminal presentation and
  `--no-color`/`NO_COLOR` support.
- Added guided Codex and Claude model and reasoning-effort selection.
- Added clearer live agent, model, elapsed-time, and structured-decision
  status while responses are running.

## 0.3.0

- Added durable `agent-bridge chat` sessions with alternating read-only
  Codex/Claude exchanges and human follow-ups.
- Added bounded `/auto` deliberation and structured per-exchange agreement.
- Added `/implement`, `/collaborate`, and `/review` handoff into the existing
  isolated workflow engine.
- Added completed-session reopening, pause/resume, locking, owner-only JSON and
  Markdown persistence, chat listing/deletion, and transcript-free cleanup.
- Made interactive chat the recommended first choice in the novice wizard.

## 0.2.0

- Added multi-phase alternating implementation and same-revision review.
- Replaced prose status tags with schema-validated provider decisions.
- Added safe non-Git review mode and explicit Git-only editing.
- Added verification commands, protected paths, and project configuration.
- Added collision-resistant checkpoints, resume locks, cancellation recovery,
  run listing/deletion/pruning, and transcript-free completion.
- Added safe cleanup for retained completed worktrees.
- Hardened isolated patches, base-revision checks, process-tree timeouts, and
  direct dirty-worktree protection.
- Added a pre-agent recovery patch for explicitly approved direct dirty edits.
- Added compiled TypeScript distribution, cross-platform CI, schemas,
  diagnostics, and expanded documentation.
