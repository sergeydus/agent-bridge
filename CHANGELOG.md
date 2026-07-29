# Changelog

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
