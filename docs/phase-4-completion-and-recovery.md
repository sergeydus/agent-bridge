# Phase 4: completion and recovery hardening

Status: Contract revision 3, incorporating two rounds of Codex review; awaiting
approval before implementation

Target release: 0.7.0

Scope owner: Agent Bridge workspace-completion, patch, and lock layers

## Objective

Phases 1 through 3 hardened the conversation, the agreement rules, and the
terminal. The code that actually touches the user's repository was not part of
any of them and is now the least-tested surface in the product.

Phase 4 hardens the end of an editing run: patch creation, the completion
decision, patch application into the original checkout, isolated-workspace
removal, and the locks that make an interrupted run recoverable. It changes no
agreement rule, no permission model, and no orchestration.

The scope is chosen by consequence rather than by novelty. Everything in it can
write to, or permanently remove, work the user cares about.

## Why this phase, measured

Coverage on `main` at `8009945` (`npm run test:coverage`):

| Module         | Lines  | Branches | Functions | Owns                            |
| -------------- | ------ | -------- | --------- | ------------------------------- |
| `artifacts.ts` | 23.81% | 66.67%   | 33.33%    | the keep/apply/discard decision |
| `file-lock.ts` | 76.67% | 55.56%   | 66.67%    | run and chat exclusive locks    |
| `git.ts`       | 92.64% | 73.68%   | 80.00%    | patches and worktrees           |

`artifacts.ts` is the lowest-covered module in `src/`. Its only test file is 14
lines long and covers one branch of `patchApplicationRefusalReason`.
`finishIsolatedRun` — the function that offers to apply a patch to the user's
real checkout and to permanently delete a worktree — has no test at all. It is
untested because it reads `process.stdin` directly and cannot be driven from a
deterministic test.

`tests/git.test.ts` contains two tests for the module that creates and applies
binary patches.

## Verified defects

Each of these was reproduced against `main` at `8009945` before being written
down. They are the acceptance targets, not illustrations.

### D1 — Ctrl+D at the completion prompt marks a successful run failed

`askForChoice` awaits `readline/promises`'s `question()`. On a real TTY, Ctrl+D
rejects that promise with `AbortError: Aborted with Ctrl+D` (`ABORT_ERR`).
Reproduced in a PTY: the process exits with code 1 after printing the raw abort
stack.

The rejection propagates out of `finishIsolatedRun` into the `cli.ts` handler at
[cli.ts:672](../src/cli.ts#L672). The signal is not aborted and the error is not
a `ProcessAbortError`, so the run takes the failure branch:

- `saveState('failed', …)` is written;
- `saveState('completed')` at [cli.ts:662](../src/cli.ts#L662) never runs;
- `printCompletion` never runs, so the user is not told where anything landed;
- `--no-transcript` cleanup never runs.

The consequence outlives the process. `discardRunWorkspace` refuses any run
whose status is not `completed` or `cancelled`
([runs.ts:66](../src/runs.ts#L66)), so the isolated worktree created by a run
that finished successfully can no longer be discarded through run management.
The agents' work is intact on disk and the checkpoint describes it as a failure.

Pressing Ctrl+D at a menu is a normal way to decline. It must not be able to
invalidate a completed run.

### D2 — completion is unreachable without a TTY

`finishIsolatedRun` returns early when either stream is not a TTY
([artifacts.ts:74](../src/artifacts.ts#L74)). Every non-interactive run
therefore ends with the workspace kept, and there is no flag that selects any
other outcome. A CI job or script can produce a patch but can never ask Agent
Bridge to apply it, and cannot clean up after itself.

`AGENTS.md` requires preserving "both the novice wizard and complete
scriptability". The completion step is the one place where that does not hold.

### D3 — applying into a dirty checkout is silent

`patchApplicationRefusalReason` checks the base revision and
`git apply --check`. Neither observes unrelated uncommitted work in the target
checkout. Reproduced: with `b.txt` modified and `c.txt` untracked, a patch
touching only `a.txt` passes `--check` and applies. Afterwards the checkout
holds the user's edits and the agents' edits with nothing distinguishing them.

This is the documented action and must remain available interactively. The
defect is that the user authorizes it without being told the state they are
applying into. Agent Bridge does not commit or stage, so there is no undo.

### D4 — application and removal failures name no corrective action

`applyPatch` and `removeIsolatedWorktree` surface raw process errors. A failed
apply does not say that the patch is still on disk, where, or that the checkout
was not modified. `AGENTS.md` requires that error messages explain the safest
corrective action.

### D5 — lock contention names no recovery, and cross-host records are misread

Both callers of `acquireFileLock` pass a message of the form
`Chat <id> is already open in another Agent Bridge process.`
([chat-state.ts:723](../src/chat-state.ts#L723),
[state.ts:417](../src/state.ts#L417)). Neither names the lock file or any way
forward.

`removeStaleLock` clears a lock only when `process.kill(pid, 0)` reports
`ESRCH`. Two reachable states leave a permanent lock with no documented
recovery: an unrelated live process inheriting the recorded PID, and `EPERM`
from a live process owned by another user. The lock record also carries no host
identity, so a PID written on one machine is evaluated against local processes
if the data directory is synced or shared — capable of clearing a lock that is
genuinely held elsewhere.

### D6 — two processes can hold the same lock

Raised by Codex as an ownership-token concern and found to be worse on
inspection. `acquireFileLock` creates the lock with `open(path, 'wx')` and
writes its record as a separate step
([file-lock.ts:64](../src/file-lock.ts#L64)). A concurrent acquirer that reads
the file inside that window sees `''`, `JSON.parse` throws, and the catch at
[file-lock.ts:48](../src/file-lock.ts#L48) unlinks a live lock and proceeds.

Reproduced deterministically rather than by racing: with a 0-byte lock file
present and its owner holding the handle open with its record deliberately
unwritten, a second `acquireFileLock` returned successfully. Both callers then
believe they hold the lock. This is a mutual-exclusion failure, not only a
stale-detection weakness.

Codex's related observation is also correct and separate: `FileLock.release`
unlinks by path with no ownership check
([file-lock.ts:16](../src/file-lock.ts#L16)), so a process whose lock was
removed as stale can later unlink a replacement holder's lock.

### D7 — patch artifacts are not written atomically

`createPatch` streams `git diff --output=` directly to the destination
([git.ts:134](../src/git.ts#L134)), bypassing `filesystem.ts`. `AGENTS.md`
states that `filesystem.ts` owns atomic owner-only writes and that every
persisted format goes through it instead of writing files directly.

An interrupted diff therefore leaves a truncated `.patch` at the final path.
Because `createPatch` reports success by testing that the file is non-empty, a
partial artifact is indistinguishable from a complete one. This matters most
under the discard rule below, where "a patch exists" would otherwise be taken
as proof that work is preserved.

## Non-goals

Phase 4 does not:

- change which agent may edit, or allow simultaneous writers;
- add automatic retry of any write call;
- commit, stage, reset, or stash anything in the target project;
- apply a patch without an explicit interactive answer or explicit flag;
- apply a patch into a dirty checkout non-interactively (deferred; see
  "Authority to apply");
- change agreement, convergence, or the orchestrator;
- change chat, the presentation model, or either renderer;
- add a new provider or provider flag;
- introduce a production dependency;
- close the Phase 3 manual accessibility matrix, which remains open (see
  "Relationship to Phase 3");
- redesign run history, pruning policy, or the transcript format.

## Invariants

These hold before and after every slice.

1. Agent Bridge never commits, stages, resets, or silently discards a target
   project.
2. A patch is applied to the original checkout only after an explicit
   interactive answer or an explicit command-line instruction, and only after
   the base-revision and `git apply --check` gates both pass.
3. A worktree is removed only after `removeIsolatedWorktree` confirms the exact
   path is registered by Git.
4. Declining, cancelling, or ending input at the completion prompt is never a
   run failure.
5. **Completion is a one-way boundary.** Once `saveState('completed')` succeeds,
   no later event — prompt cancellation, `SIGINT`, apply failure, removal
   failure, presentation failure, or an unexpected throw — may overwrite that
   status. Later saves may refine `workspace`, `agentCwd`, and the recorded
   completion outcome only.
6. No completion or run-management path removes a workspace unless a complete
   patch representing that workspace's **current** contents was written first,
   or a fresh inspection proves the workspace holds no changes.
7. Every completion path terminates: no path can leave a pending prompt that
   never settles.
8. Every persisted artifact, including patches, is written through an atomic
   rename so a partial file never occupies the final path. Lock records are
   deliberately excluded: their exclusivity comes from `open(path, 'wx')`, which
   rename semantics would defeat. See "Lock recovery and ownership".
9. A lock is held by at most one process at a time, and a lock is released only
   by the process that acquired it. A lock whose ownership cannot be determined
   is treated as held, never as stale.
10. Subprocesses keep `shell: false` and argument-array execution.
11. Error messages name the failed action, where the artifacts are, and the
    safest next step.

Invariants 4 through 9 are new. The rest restate existing project invariants
that this phase must not weaken.

## Design

### Completion outcomes

The completion step resolves to exactly one outcome. Revision 1 defined no
outcome for the D4 failures, which Codex correctly identified as a gap; the
failure outcomes below close it.

| Outcome          | Workspace | Patch   | Original checkout | Exit code   |
| ---------------- | --------- | ------- | ----------------- | ----------- |
| `no-changes`     | retained  | none    | untouched         | unchanged   |
| `kept`           | retained  | on disk | untouched         | unchanged   |
| `declined`       | retained  | on disk | untouched         | unchanged   |
| `applied`        | retained  | on disk | patch applied     | unchanged   |
| `apply-refused`  | retained  | on disk | untouched         | conditional |
| `apply-failed`   | retained  | on disk | see below         | 1           |
| `discarded`      | removed   | on disk | untouched         | unchanged   |
| `discard-failed` | retained  | on disk | untouched         | 1           |
| `patch-failed`   | retained  | none    | untouched         | 1           |

`declined` covers D1: the user ended input or cancelled. Its effect on disk is
identical to `kept`; it is recorded separately so the completion summary can be
honest about whether a choice was made. It is not a failure and does not change
the exit code.

`apply-refused` is today's behavior when `patchApplicationRefusalReason` returns
a reason, extended by the non-interactive dirty-checkout refusal below. Its exit
code is conditional, which Codex is right to require:

- refused after an **interactive** answer, the exit code is unchanged, because
  the user is present, saw the reason, and can act on it;
- refused after an **explicit `--on-complete apply`**, the exit code is `1`,
  because an unattended script asked for an application that did not happen and
  would otherwise read the run as a success.

`apply-failed` means `git apply` itself failed after both gates passed. `git
apply` without `--3way` validates before writing, so the expected state is an
untouched checkout, but the contract does not promise that — the message must
tell the user to inspect the checkout and points at the retained patch.

`patch-failed` means `createPatch` threw. Under invariant 6 the workspace is
always retained in this case, and no discard is offered.

"Exit code unchanged" means the run's own exit-code rules continue to apply:
`0`, or `2` under `--require-agreement` without convergence. The failure and
non-interactive-refusal outcomes set exit code `1` while leaving the checkpoint
status `completed`, because the work finished and only the completion action
failed.

**Precedence:** completion failure or non-interactive refusal produces exit code
`1` even when `--require-agreement` would otherwise produce `2`. A completion
action that did not happen is the more actionable signal, and the persisted
`completion.outcome` plus the run's `converged` field let a script recover the
finer detail without overloading the exit status.

### The one-way completion boundary

Revision 1 claimed that moving `saveState('completed')` ahead of the completion
step enforced invariant 5. Codex is right that it does not: the handler at
[cli.ts:672](../src/cli.ts#L672) still writes `cancelled` or `failed` after any
throw from the completion step.

The boundary is explicit state, not ordering:

- `saveState('completed')` runs before the completion step.
- On success it sets a `completionRecorded` flag.
- The `catch` handler consults that flag first. When set, it never calls
  `saveState('failed')` or `saveState('cancelled')`; it reports the completion
  failure, records the corresponding failure outcome, and sets exit code `1`.
- The outcome-recording save is itself failure-tolerant: if it throws, the
  already-durable `completed` checkpoint stands and the failure is reported.

Ordering alone is necessary but not sufficient, and the tests must assert the
checkpoint's reloaded status rather than the absence of an exception.

### Persisted completion outcome

Revision 1 said the outcome would be recorded by a second save while also
claiming no persisted format changed. Codex is right that this is
self-contradictory: `isSavedRun` uses an exact-key check
([state.ts:260](../src/state.ts#L260)), so an added field is rejected outright.

Resolved in Codex's direction. Run state advances to version 3:

```ts
export interface SavedRunCompletion {
  outcome: CompletionOutcome;
  recordedAt: string;
  reason?: string; // bounded and sanitized; set for refused and failed outcomes
}

export interface SavedRun {
  version: 3;
  // …unchanged fields…
  completion?: SavedRunCompletion;
}
```

`applied` and `discarded` are consequential events and are worth a durable
record. This is independent of the `--on-complete` decision below: the
instruction stays fresh, the action that occurred becomes durable.

Version 2 migrates by setting `version: 3` and leaving `completion` absent,
which correctly reads as "this run predates completion recording" rather than
as any particular outcome. No message, workspace, or status information is lost.

Per `AGENTS.md`, the TypeScript type, `isSavedRun`, `hasOnlyKeys`,
`schemas/run-state.schema.json`, the v2 migration, and fixture tests change in
one slice.

#### Cross-field invariants

Codex is right that structure is not enough. The JSON Schema documents shape;
the runtime validator owns these semantics and rejects a checkpoint violating
any of them:

1. `completion` is present only when `status === 'completed'`.
2. `recordedAt` parses as an ISO timestamp.
3. `apply-refused`, `apply-failed`, `discard-failed`, and `patch-failed`
   require a non-empty bounded `reason`.
4. `no-changes`, `kept`, `declined`, `applied`, and `discarded` reject `reason`
   entirely, so a success cannot carry contradictory failure data.
5. `discarded` requires `workspace === undefined` and
   `agentCwd === originalCwd`.
6. `no-changes` and `patch-failed` require `workspace` to be present, since both
   mean nothing was captured to a patch.

Invariant 1 has a consequence worth stating rather than discovering in slice 4.
`discardRunWorkspace` accepts runs whose status is `completed` **or**
`cancelled` ([runs.ts:66](../src/runs.ts#L66)). If run management also wrote a
`completion` record, a discarded `cancelled` run would fail its own validator.

Resolution: `completion` describes how **the run's own completion step**
resolved, and run management never writes it. A workspace later removed through
`--discard-workspace` therefore leaves `completion.outcome` as whatever the run
recorded — commonly `kept` — with `workspace` absent. That is permitted, because
invariant 5 is one-directional: `discarded` implies no workspace, but an absent
workspace does not imply `discarded`. Run management remains responsible for
setting `workspace: undefined` and `agentCwd: originalCwd`, which it already
does.

### Preserving work before any removal

Codex's objection to "a patch exists" is correct on both sides, and D7 makes it
sharper still.

A retained workspace can be edited after its patch was written, so the patch on
disk may be stale. An interrupted `createPatch` can leave a truncated file that
merely exists. And a run that produced no changes has no patch at all, which
under revision 1's rule would have made it permanently undiscardable.

The rule becomes: **before any workspace removal, from either the completion
step or run management,**

1. run a complete `createPatch` over the workspace's current contents through
   the atomic path from D7;
2. if patch creation fails, preserve the workspace and report `patch-failed`
   or the run-management equivalent — never remove;
3. if that same `createPatch` reports no changes, removal is permitted with no
   patch, because there is nothing to lose;
4. after successful removal, save `workspace: undefined` **and**
   `agentCwd: originalCwd`.

Point 3 answers revision 2's open question in Codex's direction: the
empty-workspace proof is a full `createPatch` returning "no changes", not the
cheaper `workingTreeStatus`. A destructive path should use the same mechanism
that would have preserved binary content, mode bits, symlinks, deletions, and
untracked files, and the cost is negligible against permanent removal.

Point 4 is a requirement Codex asked for and is also an existing defect.
`saveState` writes `agentCwd: options.cwd`, and `options.cwd` was reassigned to
the workspace at [cli.ts:379](../src/cli.ts#L379), so today's CLI discard path
records `agentCwd` pointing at a directory it just removed.
`discardRunWorkspace` already sets both fields
([runs.ts:76](../src/runs.ts#L76)); the CLI path must match it.

### Authority to apply

Codex's distinction between interactive and unattended application is right.
A disclosure printed to a process nobody is watching authorizes nothing, and
`--on-complete apply` may execute hours after the flag was typed.

- **Interactive apply** may proceed into a dirty checkout after the disclosure
  and an explicit confirmation. The disclosure is shown before the confirmation
  so the answer responds to it.
- **Non-interactive apply refuses a dirty checkout** and reports
  `apply-refused` with a reason naming the dirty state. This is a refusal, not
  an error.
- `--allow-dirty-apply` is deliberately **not** added in this phase. It is
  recorded here as the designed extension point if the refusal proves too
  strict in practice.

The disclosure reports counts — how many tracked files are modified and how
many untracked files are present — and does not list paths, because compact
output does not expose project paths by default.

After a successful apply, the summary reports how many files the patch touched,
so agent changes remain distinguishable from the user's own while the two are
still separable in memory.

### Injectable prompt boundary

`finishIsolatedRun` takes its input source as a parameter rather than reading
`process.stdin`:

```ts
export interface CompletionPrompt {
  ask(question: string): Promise<string | undefined>;
  close(): void;
}
```

`ask` resolves `undefined` for end-of-input or cancellation. That single
convention removes D1 at the source: there is no rejection to propagate, and
every caller must handle "no answer" explicitly. The default implementation
wraps `readline/promises` and converts an `ABORT_ERR` rejection and the
interface's `close` event into `undefined`.

A `CompletionPrompt` is constructed only when both streams are TTYs.

### Scriptable completion

Add one option:

```text
--on-complete ask|keep|apply|discard
```

- `ask` is the default and preserves today's interactive menu.
- `keep` is the default when either stream is not a TTY, matching current
  non-interactive behavior exactly.
- `apply` runs the same base-revision and `git apply --check` gates, plus the
  non-interactive dirty-checkout refusal above.
- `discard` removes the worktree only after the preservation rule is satisfied.
  It skips the interactive confirmation because the flag is itself the explicit
  instruction, and its help text says "permanently removes".

`--on-complete` is **not** persisted, which Codex and this contract agree on: it
is fresh authorization for an action outside the tool, and a resumed run must
not apply a patch because of a flag passed to an earlier invocation.
`--no-transcript` is persisted because it governs what gets written throughout
the run, which is a privacy setting rather than an authorization.

**Validation is runtime, not parse-time.** Revision 1 proposed rejecting
`--on-complete discard` alongside `--no-isolation` at parse time. Codex is
right that this is insufficient: a resumed run takes its isolation from the
checkpoint, so parse-time inspection of the current flags cannot tell whether
an isolated workspace exists.

Revision 2 then placed the runtime check at the completion gate
([cli.ts:622](../src/cli.ts#L622)), which Codex is also right to reject — a
resumed direct run would pay for every remaining provider call before learning
the option was impossible.

The check runs as early as the information exists. `options.isolation` is
resolved from the checkpoint at [cli.ts:150](../src/cli.ts#L150) and
`editingWorkflow` at [cli.ts:162](../src/cli.ts#L162), both before the run lock,
before workspace creation, and before any provider call. `apply` and `discard`
are validated immediately after that point and rejected with an explanatory
message when the effective mode has no isolated workspace. A test asserts the
rejection performs **zero** provider calls.

Parse-time rejection of an incompatible flag combination is retained as an
early, better-worded error, not as the enforcement point.

### Lock recovery and ownership

Revision 2 asked for a complete record to become visible atomically _and_ for
`open(path, 'wx')` to stay the exclusivity primitive on the final name. Codex is
right that those are mutually exclusive: opening the final path first is what
creates the empty-file window, and publishing by rename uses replacement
semantics — [writePrivateFileAtomic](../src/filesystem.ts#L12) would silently
overwrite a live lock, which is worse than the defect it was meant to fix.

**Adopted protocol.** Exclusivity stays with `open(path, 'wx')`, and D6 is
closed on the reader side instead:

1. `open(path, 'wx')` creates the lock. Winning that call is what confers
   ownership.
2. The owner then writes a record containing the PID, hostname, a random
   ownership token, and the creation time.
3. Any other process that finds the path occupied and reads empty or malformed
   content treats it as an **occupied lock with an unknown owner** — never as
   stale, never removable.

Step 3 is the whole fix. The window between steps 1 and 2 still exists, but a
process observing it now backs off instead of unlinking a live lock.

`FileLock.release` re-reads the record and unlinks only when the ownership
token still matches, closing Codex's ABA case.

`removeStaleLock` removes a lock only when the record parses, its host matches
the current host, and its PID is gone. A record from a different host is not
stale. A missing, malformed, or unparseable record is unknown, never stale.

**Residual failure mode, accepted knowingly.** A process killed between steps 1
and 2 leaves a 0-byte lock that no longer self-heals; today's code would clear
it. The window is small and the existing code already unlinks on a _failed_
write ([file-lock.ts:73](../src/file-lock.ts#L73)), so only an uncatchable kill
reaches it. Trading a rare manual recovery for guaranteed mutual exclusion is
the right direction, but the recovery message must name the empty-lock case
specifically, because "the lock file is empty" is otherwise an unreadable
symptom.

**Rejected alternative.** Publishing a prewritten temporary file with an
exclusive `link()` would close the window entirely. It is not adopted in this
phase: it needs cross-platform CI proof, and NTFS supports hard links while
other Windows filesystems do not. It is recorded as the extension point if the
empty-lock recovery proves annoying in practice.

Revision 1 also stated "no persisted format changes", which Codex correctly
called inaccurate. The lock record is a persisted format. It is transient
rather than versioned, and the change is additive, so it needs compatibility
tests against old and new records rather than a migration.

## Migration impact

Two persisted formats change.

**Run state, versioned:** version 2 to version 3, adding optional `completion`.
Type, `isSavedRun`, `hasOnlyKeys`, JSON Schema, migration, and fixtures change
together in one slice. Version 1 continues to migrate through version 2 as it
does today.

**Lock records, transient and unversioned:** additive `host` and ownership
token. No migration. Old records are readable and are treated as unknown-owner,
never auto-removed.

Revision 2 claimed new records are "ignored safely by older Agent Bridge
versions". Codex is right that this holds only on one host. An older binary
reads `pid` and ignores `host`, so a record written on host A can be evaluated
against host B's process table and cleared while genuinely held. **All Agent
Bridge installations sharing a data directory must be upgraded together.** This
is documented in `docs/security.md` alongside the existing filesystem
invariants, and mixed versions on a single host remain safe.

Chat session state is untouched and stays at version 4.

## Slices

Each slice leaves the tree releasable and is independently reviewable.

### Slice 1 — testable completion boundary, no behavior change

Introduce `CompletionPrompt`, inject it into `finishIsolatedRun`, and add
deterministic tests for every existing path against temporary repositories:
no-changes, keep, apply, apply refused for each of the three refusal reasons,
discard confirmed, discard declined, and invalid-then-valid menu input.

Acceptance: `artifacts.ts` line and function coverage above 90%, with the
observable behavior of every existing path unchanged.

### Slice 2 — run state version 3

Type, validator, exact-key list, JSON Schema, v2 migration, and fixtures for the
optional `completion` record. No behavior yet reads or writes it beyond a
round-trip test.

Acceptance: a version 2 fixture migrates with `completion` absent; a version 3
fixture round-trips; an unknown outcome string is rejected; each of the six
cross-field invariants is rejected by a dedicated case.

### Slice 3 — completion cannot fail a finished run

The one-way boundary flag, `declined`, the failure outcomes, outcome recording,
`printCompletion` on every path, and the exit-code rules.

Acceptance: D1 no longer reproduces, in a deterministic test and in the PTY
harness; injected apply and removal failures leave a reloaded checkpoint whose
status is `completed`.

### Slice 4 — atomic patches and safe discard

Atomic patch writing through `filesystem.ts` (D7), the fresh-patch preservation
rule, the empty-workspace exception, and the `agentCwd` reset on both the CLI
and run-management removal paths.

Acceptance: an interrupted patch write never leaves a file at the final path; a
workspace edited after its patch was written is re-patched before removal; a
no-change workspace is discardable; removal is refused when patch creation
fails.

### Slice 5 — scriptable completion

`--on-complete`, runtime validation against resolved run state, the
non-interactive dirty-checkout refusal, help text, and README coverage.

Acceptance: every outcome reachable without a TTY except `ask`; `apply` and
`discard` rejected for a resumed non-isolated run before any provider call;
non-interactive `apply-refused` exits `1` and takes precedence over `2`.

### Slice 6 — disclosure and error quality

The pre-apply dirty-checkout disclosure and confirmation ordering, the
post-apply touched-file count, and corrective-action messages for apply and
removal failures.

Acceptance: D3 and D4 no longer reproduce.

### Slice 7 — lock correctness and recovery

The adopted `wx`-plus-unknown-owner protocol (D6), ownership-token release, host
recording, unknown-record conservatism, recovery hints in both contention
messages including the empty-lock case, and the shared-data-directory note in
`docs/security.md`.

Acceptance: D5 and D6 no longer reproduce; `file-lock.ts` branch coverage above
80%.

Slices 1 through 6 are ordered by dependency. Slice 7 is independent of all of
them and may be reviewed or dropped separately.

## Test strategy

All tests use temporary Git repositories, temporary `AGENT_BRIDGE_HOME`, and
injected prompts. No network, no provider authentication, no dependency on this
repository.

### Deterministic

- every completion outcome, including each refusal reason separately;
- `ask(…)` resolving `undefined` produces `declined`, and the reloaded
  checkpoint status is `completed`;
- injected apply failure and injected removal failure each leave a reloaded
  checkpoint status of `completed` with the matching failure outcome and exit
  code `1`;
- interactive `apply-refused` leaves the exit code unchanged while
  non-interactive `apply-refused` exits `1`, and exit code `1` wins over the
  `--require-agreement` code `2`;
- each version 3 cross-field invariant rejected individually, including a
  `completion` record on a non-`completed` status and a `discarded` outcome that
  still names a workspace;
- a run left by a declined completion can still be discarded through
  `discardRunWorkspace`, which is the durable consequence of D1;
- `--on-complete` parsing, defaults, TTY interaction, and runtime rejection for
  a resumed run with no isolated workspace;
- apply into a clean checkout; interactive apply into a dirty checkout after
  disclosure; non-interactive apply into a dirty checkout refused;
- apply refused when the base revision moved, when no base revision was
  recorded, and when `git apply --check` fails;
- an untracked-file collision in the target checkout;
- removal refused when patch creation fails; removal permitted for a workspace
  with no changes; a workspace modified after its patch was written is
  re-patched before removal;
- after removal, both `workspace` and `agentCwd` are corrected;
- an interrupted patch write leaves no file at the final destination;
- `removeIsolatedWorktree` still refuses an unregistered path and the
  repository root itself;
- binary, executable-bit, symlink, deletion, and untracked-file patches survive
  a create-then-apply round trip;
- version 2 to version 3 run-state migration and fixture round-trips;
- lock records: a 0-byte or malformed record is never treated as stale; a
  foreign-host record is never removed; a local record whose PID is gone is
  removed; `release` after another process took over does not unlink the new
  holder's lock; both contention messages name the lock path, and the empty-lock
  message names that case specifically.

### Concurrency

D6 needs a test proving that two acquirers cannot both hold the same path.
Codex is right that a probabilistic race is not adequate evidence, and it is
not needed: the boundary between claiming the path and writing the record is
directly controllable. The test creates the 0-byte lock, holds it open, and
calls `acquireFileLock` while the record is deliberately unwritten — the exact
state reproduced against `main` — then asserts the second call is refused.

A second case runs the same sequence in the opposite order to prove the first
holder's `release` does not unlink a successor's lock.

Both run in-process against a temporary directory with no providers, no network,
and no timing dependence.

### PTY

The existing harness gains one case: Ctrl+D at the completion prompt exits 0,
prints a completion summary naming the retained workspace and patch, and leaves
a checkpoint whose status is `completed`. This case belongs in the PTY suite
rather than the deterministic suite because the `ABORT_ERR` rejection in D1
only occurs on a real terminal driver.

### Required project checks

`npm run check`, `npm run test:pty`, `npm run test:coverage`, and
`npm pack --dry-run` before each handoff.

Global coverage thresholds are **not** raised. Codex's reasoning is accepted: a
global floor is not evidence about these specific paths, and moving an
already-low floor would prove nothing. The two targeted module requirements in
the acceptance criteria carry that weight instead.

## Acceptance criteria

Phase 4 is complete when:

1. D1 through D7 no longer reproduce, each with a test that fails against
   `8009945`.
2. `finishIsolatedRun` is driven entirely through injected input in tests.
3. Every completion outcome is reachable non-interactively except `ask`.
4. Once a run is recorded `completed`, no completion-step event can change that
   status, proven by reloading the checkpoint after injected failures.
5. No completion or run-management path removes a workspace without a fresh
   complete patch or a fresh proof that the workspace holds no changes.
6. No persisted artifact can be observed partially written at its final path.
7. Interactive apply into a non-clean checkout discloses that state before
   asking and remains permitted; non-interactive apply into a non-clean
   checkout is refused.
8. Apply and removal failures name the artifact locations and the next step.
9. A lock is held by at most one process, is released only by its owner, and an
   unknown or foreign-host record is never removed automatically. Lock
   contention names the lock path and a recovery step.
10. Run state version 3 ships with type, validator, schema, migration, and
    fixtures changed together; every cross-field invariant is enforced at
    runtime; and version 1 and 2 checkpoints still load.
11. An impossible `--on-complete` is rejected before any provider call.
12. `artifacts.ts` line coverage above 90%; `file-lock.ts` branch coverage above
    80%.
13. `npm run check`, `npm run test:pty`, `npm run test:coverage`, and
    `npm pack --dry-run` pass.

## Relationship to Phase 3

Phase 3's manual acceptance matrix — VoiceOver, NVDA, Orca, VS Code's
integrated terminal, a 40-column terminal, and repeated resizing during
streaming — is **not** closed and is **not** absorbed into this phase. It
remains the outstanding Phase 3 release gate, and
`docs/phase-3-interactive-terminal.md` continues to record it as Slice 5
release-hardening work.

Phase 4 does not depend on it and does not block it. Neither phase may be
declared released while it is open, and its results should be recorded per
assistive technology rather than signed off in aggregate, because nothing in CI
can re-verify it later.

## Revision history

**Revision 2** incorporates Codex's review of revision 1. Accepted without
reservation: the one-way completion boundary and its failure outcomes; run
state version 3; the fresh-patch preservation rule and the `agentCwd` reset;
non-interactive refusal to apply into a dirty checkout; unknown-host locks and
the honest description of the lock-format change; runtime rather than
parse-time validation of `--on-complete`; not raising global coverage
thresholds; not persisting `--on-complete`; no second acknowledgement for
non-interactive discard; keeping the lock slice.

Two findings were added while verifying that review. D6 escalates Codex's
ownership-token suggestion: two processes can already hold the same lock
simultaneously, reproduced directly. D7 records that patch artifacts bypass
`filesystem.ts` and can be left truncated at their final path, which is what
made revision 1's "a patch exists" rule unsound in the first place.

**Revision 3** resolves Codex's review of revision 2.

The blocking item was real: revision 2 asked for atomic publication of the lock
record while keeping `open(path, 'wx')` on the final name, which is not
implementable — the first requirement creates the empty-file window and the
second forbids the rename that would close it. Adopted Codex's recommended
protocol: exclusivity stays with `wx`, and an empty or malformed record is read
as an occupied lock with an unknown owner. Exclusive `link()` publication is
recorded as a rejected alternative with its cross-platform caveat rather than
left as an unstated assumption. The D6 test is now deterministic at the
claim/write boundary instead of probabilistic.

Also accepted: non-interactive `apply-refused` must exit non-zero, with
completion exit code `1` taking precedence over the agreement-cap code `2`;
`--on-complete` validation moves to [cli.ts:150](../src/cli.ts#L150)–
[162](../src/cli.ts#L162), before any provider call, with a zero-provider-call
assertion; version 3 gains six runtime cross-field invariants; and the
empty-workspace proof uses a full `createPatch`.

Two corrections to revision 2's own text. The claim that unknown legacy locks
"only exist until the next successful acquisition" was backwards — such a lock
_prevents_ that acquisition until its owner releases it or an operator removes
it. And "new records are ignored safely by older versions" holds only on a
single host, since an older binary reads `pid` while ignoring `host`; the
requirement that all installations sharing a data directory be upgraded
together is now stated and routed to `docs/security.md`.

One consequence surfaced while accepting invariant 1 of the version 3
cross-field rules. `discardRunWorkspace` accepts `cancelled` runs, so a
run-management discard that wrote a `completion` record would produce a
checkpoint failing its own validator. Resolved by scoping `completion` to the
run's own completion step; run management never writes it.

## Questions for review

None blocking. Revision 3 adopts every recommendation from the revision 2
review, and the two open items it raised are recorded as decisions rather than
questions:

1. The empty-lock residual — a process killed between claiming the path and
   writing its record leaves a lock that no longer self-heals. Accepted
   knowingly in exchange for guaranteed mutual exclusion, mitigated by naming
   that case explicitly in the recovery message, with `link()` publication as
   the documented escape hatch.
2. Scoping `completion` to the run's own completion step, which follows from
   the cross-field invariants rather than being an independent choice.

Ready for slice 1 on approval.
