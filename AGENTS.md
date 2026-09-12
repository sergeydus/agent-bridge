# Agent Bridge contributor guide

## Product boundary

Agent Bridge is a standalone, repository-agnostic CLI. It coordinates Codex
CLI and Claude Code in review-only, fixed-role, and alternating
implement-and-review workflows, plus persistent human-guided chats.

The installation directory, user-selected target project, and application-data
directory are always independent. Never infer a target project from the
location of Agent Bridge itself.

## Read this first

- `README.md` — user behavior and supported workflows
- `docs/architecture.md` — module ownership and data flow
- `docs/workflow-state-machine.md` — convergence and checkpoint transitions
- `docs/interactive-chat.md` — persistent chat and workflow handoff
- `docs/provider-contract.md` — structured provider boundary
- `docs/project-configuration.md` — trusted project commands
- `docs/security.md` — permissions, privacy, and filesystem invariants

## Module ownership

- `cli.ts` composes startup, recovery, persistence, and completion.
- `chat.ts` owns the interactive coordinator and agent exchanges.
- `chat-input.ts` owns queued terminal input and slash-command parsing.
- `chat-workflow.ts` owns safe handoff to editing and review workflows.
- `chat-state.ts` owns chat validation, locking, persistence, and transcripts.
- `wizard.ts` owns novice-facing interactive setup.
- `workflow-preflight.ts` owns the one inspection and preview shared by the
  wizard and chat before any read-only-to-editing transition.
- `options.ts` owns CLI types, help, parsing, and validation.
- `presentation-model.ts` owns bounded, renderer-neutral terminal state.
- `presentation.ts` owns accessible plain rendering, presentation control, and
  color resolution.
- `enhanced-terminal.ts` owns responsive alternate-screen rendering.
- `terminal-text.ts` is the single sanitizer for untrusted text reaching a
  terminal; every renderer, reporter, and diagnostic goes through it.
- `terminal-capabilities.ts` owns UI mode selection and process-free capability
  checks.
- `orchestrator.ts` owns the provider-independent state machine.
- `core.ts` contains shared workflow types and deterministic helpers. Closed
  vocabularies are declared there as value arrays with the type derived from
  them, so a validator and a CLI flag cannot disagree about the members.
- `response.ts` owns structured response schemas and parsing.
- `providers.ts` translates the provider-independent contract into CLI flags.
- `provider-events.ts` incrementally normalizes safe provider stream events.
- `prompts.ts` is the only home for agent role prompts.
- `verification.ts` executes user-approved commands without a shell.
- `project.ts` distinguishes Git projects from ordinary directories.
- `project-config.ts` validates `.agent-bridge.json`.
- `git.ts` owns repositories, isolated worktrees, and binary-safe patches.
- `snapshot.ts` captures bounded evidence and fingerprints protected paths.
- `artifacts.ts` owns completion choices for isolated workspaces.
- `state.ts` owns checkpoint validation, migration, atomic writes, and locks.
- `filesystem.ts` owns atomic owner-only writes and bounded prefix reads. Every
  persisted format goes through it instead of writing files directly.
- `file-lock.ts` owns the single exclusive-lock primitive, including stale-owner
  detection, shared by run checkpoints and chat sessions.
- `validation.ts` owns the predicates every runtime validator shares, so
  checkpoints, chat sessions, project configuration, and provider responses
  agree on what an object, an allow-listed key set, and a timestamp are.
- `runs.ts` owns run listing and conservative artifact deletion.
- `run-management.ts` maps CLI history actions to run operations.
- `task.ts` loads task input and bounded Git review evidence.
- `instructions.ts` loads bounded shared project instructions.
- `transcript.ts` renders persisted run records.
- `doctor.ts` probes versions, auth, storage, and provider capabilities.
- `process.ts` owns subprocess lifetime, timeouts, and process-tree shutdown.
- `config.ts` and `paths.ts` own preferences and platform data locations.
- `ui.ts` owns one-shot workflow progress and completion presentation.
- `schemas/` documents persisted and provider-facing JSON.

## Non-negotiable invariants

- Only one implementation agent may have write access at a time.
- Reviewers and the final judge are read-only.
- Ordinary interactive-chat turns are always read-only; editing commands must
  reuse the established workflow engine.
- Agreement requires structured `done` decisions about the same captured
  implementation cycle. Prose or a legacy status tag is not authoritative.
- Never automatically retry a write call; it may have partially edited files.
- Never commit, stage, reset, or silently discard a target project.
- Editing ordinary non-Git folders is rejected. Review-only access is allowed.
- Isolated worktrees are the default for editing.
- A dirty isolated source requires explicit `--from-head` acknowledgement.
- Direct dirty editing requires `--allow-dirty`, and pre-existing changed paths
  must be fingerprinted and backed up before agent modification is allowed.
- Worktree cleanup must validate the exact path registered by Git.
- Patch application must verify both the base revision and `git apply --check`.
- Spawn subprocesses with `shell: false` and argument arrays.
- Timeouts and cancellation must terminate descendant processes, not only the
  immediate CLI.
- Project verification is opt-in and runs outside the agent permission set.
- Resume must use checkpointed settings, not silently adopt changed config.
- Invalid local config and stale recent projects are recoverable where doing so
  does not weaken safety.
- Persisted task material is private local data and may still be sensitive.
- Provider-native sessions stay ephemeral; interactive history is
  coordinator-owned, bounded, and JSON-encoded in prompts.
- Live events never expose reasoning or raw tool payloads and never drive
  workflow state; only the validated final response is authoritative.

## Change checklist

When behavior changes:

1. Add or update deterministic tests.
2. Update `README.md` and `--help` for user-facing behavior.
3. Update the relevant design document.
4. For persisted formats, change the TypeScript type, runtime validator, JSON
   Schema, migration/version handling, and fixture tests together.
5. For provider changes, keep provider flags out of orchestration and add a
   dry-run command assertion.
6. For new subprocesses, prove argument-array execution, cancellation, timeout,
   and useful error output.
7. Run `npm run check`, `npm run test:pty`, `npm run test:coverage`, and
   `npm pack --dry-run`.

Tests use temporary repositories, fake providers, and temporary
`AGENT_BRIDGE_HOME` directories. They must not require network access, global
authentication, real provider calls, or the repository containing this tool.

## Style

- Keep TypeScript strict and boundary types explicit.
- Prefer small deterministic functions over CLI-local conditionals.
- Inject providers, clocks, paths, and reporters when a unit test benefits.
- Keep prompts centralized and serialize untrusted task/evidence content.
- Explain the safest corrective action in error messages.
- Preserve both the novice wizard and complete scriptability.
