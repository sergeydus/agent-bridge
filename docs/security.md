# Security and data handling

Agent Bridge coordinates two powerful external coding tools. Its safety model
is based on explicit scope, least privilege, recoverable Git operations, and a
small trusted local coordinator.

## Trust boundaries

- The user chooses the target project and task.
- Codex and Claude are external providers and receive project material needed
  for their turns.
- Project `.agent-bridge.json` is untrusted until the user explicitly approves
  its commands.
- Provider prose is untrusted data. Only schema-validated decisions drive the
  workflow.
- Provider event streams are untrusted data. They are size-bounded and parsed
  incrementally; malformed streams terminate the provider call.
- Interactive-chat messages and linked workflow summaries are untrusted data
  and are JSON-encoded in subsequent prompts.
- The target checkout may already contain valuable uncommitted work.

## Agent permissions

- Only the current implementation agent receives write access.
- Reviewers and the final judge remain read-only.
- Claude write turns allow file operations without Bash.
- Provider prompts forbid package, build, deploy, commit, stage, reset, and
  unrelated operations.
- Verification commands execute through Agent Bridge after explicit approval.
- A write failure is never retried because the workspace may already have
  changed.

Codex's sandbox still exposes command execution within its writable scope, so
the default isolated Git worktree remains an important containment boundary.
Agent Bridge is not a security sandbox for hostile code.

## Repository protection

- Editing requires Git with an initial commit and defaults to an isolated
  detached worktree.
- The novice wizard may run `git init` only after confirmation. It never stages
  or creates the initial commit; the user reviews `.gitignore` and chooses the
  committed files.
- A dirty source checkout requires explicit acknowledgement that isolation
  starts from committed `HEAD`.
- Direct editing requires explicit flags; pre-existing dirty paths are
  fingerprinted and checked after every write. A complete private recovery
  patch is saved before the first agent call.
- The coordinator never commits, stages, resets, or automatically discards
  changes.
- Patch creation uses a temporary alternate Git index and leaves the user's
  real index untouched.
- Patch application verifies the source base revision and performs
  `git apply --check`.
- Worktree removal validates the exact path registered in Git.
- Symlinks are not followed when capturing untracked evidence. Protected paths
  containing symlinks are rejected because their targets cannot be guaranteed.
- Run artifacts must be outside a project used for editing.

## Process safety

Agent Bridge always supplies a fixed executable and an argument array and never
enables Node's `shell: true` option. On Windows, npm `.cmd` provider shims are
resolved by a compatibility layer that applies Windows command escaping.
Timeouts and signals terminate the child process tree so provider descendants
do not remain running after cancellation. Write phases remain checkpointed and
preserved when an outcome is uncertain.

Live presentation uses an allowlisted normalized event contract. It never
renders provider reasoning, thinking deltas, raw commands, tool inputs, file
paths, or unknown event payloads. Live text is informational and bounded; the
separately validated final structured response remains the sole authority for
workflow decisions.

All terminal presentation modes remove terminal escape sequences, C0/C1
controls, and Unicode bidirectional embedding, override, and isolate controls
from untrusted text before displaying it. Direction marks used by ordinary
mixed left-to-right and right-to-left text remain supported. The enhanced
renderer does not enable mouse capture or raw input, and it leaves the
alternate screen before a child workflow inherits the terminal. Its start,
suspend, resume, redraw, and stop operations cannot update checkpoints or
workflow decisions. If drawing fails but normal terminal state can be restored,
presentation falls back to the plain renderer without changing workflow state.

Interactive chat never gives providers write access. Its editing commands
create an owner-only temporary task file and launch the existing isolated
workflow without a shell. The task file is removed after the child exits.

## Exclusive locks

Run checkpoints and chat sessions share one lock primitive. Creating the lock
file with an exclusive open is what confers ownership; the record naming the
owner is written immediately afterwards and only says who won. A lock is
released by re-reading that record and comparing an ownership token, so a
process whose lock was removed cannot later delete a successor's lock.

A lock left behind by a process that is gone is taken over, never deleted and
recreated. Takeover happens under a separate marker created with the same
exclusive open, so at most one process is ever inside it, and the stale record is
overwritten in place, so the lock path is never briefly free for a further
process to claim. No process ever unlinks a lock file it does not own. A marker
left behind by a process interrupted mid-takeover is not removed automatically
either; it disables automatic recovery for that one lock and is named in the
message, which is the same manual recovery as any unattributable lock.

A lock path must be a plain file with exactly one name. A symbolic link, a hard
link, or any other special file in its place is never treated as a lock and never
written to, because writing through it would modify whatever it refers to. The
check is made against the path and again against the opened handle, and the record
is confirmed through that same handle before anything is written to it.

A lock is eligible for takeover in exactly one case: it is a plain file, its
record parses, names this host, and its process is gone. Every other state is left
in place and reported — an empty file, a record from an older Agent Bridge version, content
that does not parse, a record naming another host, or a live process. An empty
lock file is the state left behind when an owner is interrupted between claiming
the lock and recording itself; it cannot be told apart from a live owner, so it
is never cleared automatically. Contention always names the lock file and the
recovery step. Deleting a lock file by hand is safe only when no Agent Bridge
process is using that run or chat.

A process identifier is only meaningful on the machine that wrote it, so lock
records carry a host name and a foreign host is never evaluated against the
local process table. **All Agent Bridge installations that share a data
directory must be upgraded together.** An older build reads the process
identifier and ignores the host, so a lock written on one machine can be judged
against another machine's processes and cleared while it is genuinely held.
Mixed versions on a single host remain safe.

Configured verification executables must be bare names without path
separators. This prevents shell syntax injection, but an approved executable or
package script can still run arbitrary project code. Trust configuration only
from projects you trust.

## Convergence integrity

Provider responses must match the turn's JSON Schema. A review turn includes
the captured revision produced by its corresponding writer. Agreement is true
only when both decisions for the same cycle are `done`; optimistic wording,
ambiguous text, and legacy status tags cannot end a run.

Writer state is checkpointed before verification and review. If verification
or any later activity changes the workspace revision, the earlier approval no
longer counts toward convergence.

`--require-agreement` returns a non-zero status when the safety cap is reached
without convergence.

## Sensitive data

The following may be sent to both providers:

- task text and root instruction files;
- diffs and bounded workspace evidence;
- verification output;
- prior agent responses.
- interactive-chat messages and linked workflow status.

The following may be stored locally:

- recent project paths and user preferences;
- resumable state and agent responses;
- transcripts, context manifests, and patches;
- interactive chat checkpoints and Markdown transcripts;
- isolated worktrees.

Files use owner-only permissions and coordinator-owned directories use
owner-only access where supported. Default locations:

- macOS: `~/Library/Application Support/Agent Bridge`
- Linux: `${XDG_STATE_HOME:-~/.local/state}/agent-bridge`
- Windows: `%LOCALAPPDATA%\\Agent Bridge`

Set `AGENT_BRIDGE_HOME` to use another location. `--no-transcript` removes the
successful run checkpoint and avoids completed transcript files, but an active
checkpoint is still necessary for interruption recovery.
In chat mode, the same rule applies until `/done`; pausing necessarily retains
the checkpoint so it can be resumed.

Protected paths prevent edits; they do not prevent provider visibility if the
task or project evidence includes their contents. Never put credentials in a
task. Keep secrets out of the selected project when stronger confidentiality
is required.
