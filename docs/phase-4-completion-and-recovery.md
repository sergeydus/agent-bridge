# Phase 4: completion and recovery hardening

Status: Contract revision 15, approved; slices 1 to 7 implemented

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

The same gap exists for the completed Markdown transcript, JSON transcript, and
context JSON, which are written with three direct `writeFile` calls at
[cli.ts:587](../src/cli.ts#L587).

Two other direct writes are **not** in scope and the invariant is worded to
exclude them: [chat-workflow.ts:138](../src/chat-workflow.ts#L138) and
[providers.ts:232](../src/providers.ts#L232) write into freshly created
`mkdtemp` directories and are consumed by a subprocess within the same process
lifetime. No reader survives the process, and a partial write there fails the
subprocess loudly rather than masquerading as complete.

### D8 — committed work inside a workspace is invisible to patch creation

Found by Codex while reviewing revision 3's preservation rule, and confirmed
here. `runCompleteWorkspaceDiff` seeds its temporary index from the workspace's
**current** `HEAD` and diffs against that same `HEAD`
([git.ts:169](../src/git.ts#L169)). If anything commits inside the worktree,
`HEAD` moves and the committed work vanishes from the comparison.

Reproduced: an isolated worktree at base commit A, a file edited and committed
as B, then `createPatch`:

```json
{ "base": "546e9b1", "head": "f82ac10", "created": false, "patchExists": false }
```

`createPatch` reports no changes. Worse, no branch or ref contains commit B — it
is reachable only as the detached worktree's `HEAD`, so
`git worktree remove --force` drops the last reference to it and the objects
become unreferenced. Revision 3's preservation rule would therefore have
authorized removing a workspace whose work it had just failed to capture,
which is exactly the failure the rule exists to prevent.

Agents are instructed not to commit, so this is an off-nominal state. It is
still reachable: an agent may disregard the instruction, and a user may commit
inside a retained worktree before running `--discard-workspace`.

This also silently weakens per-cycle change detection. `workspaceFingerprint`
shares `runCompleteWorkspaceDiff`, so an agent commit currently produces an
unchanged fingerprint while the files did change.

### D9 — a missing base revision is silently replaced at startup

Found by Codex while reviewing revision 4's legacy-run protection, and confirmed
here as an existing defect rather than only a future risk.

`baseRevision` starts as `resumedRun?.baseRevision`
([cli.ts:214](../src/cli.ts#L214)) and is then filled in with
`baseRevision ??= await currentCommit(repository)`
([cli.ts:227](../src/cli.ts#L227)). A resumed run that recorded no base
revision therefore acquires the repository's **current** `HEAD`, which may be an
entirely different commit from the one its workspace was created against.

The consequences are already live:

- `patchApplicationRefusalReason` refuses only when `baseRevision` is undefined
  ([artifacts.ts:40](../src/artifacts.ts#L40)). With a fabricated value that
  branch never fires.
- Its next check compares `currentCommit(repository)` against `baseRevision`,
  which now compares equal by construction, so the guard passes.
- A legacy resumed run can therefore auto-apply a patch whose true baseline is
  unknown, which is exactly what the "predates base-revision tracking" message
  exists to prevent.

Under this contract it would also defeat the new protections: the discard
refusal for runs with no recorded baseline would never trigger, and D8's
explicit baseline would be computed against a commit the workspace was never
based on.

**Provenance must be preserved.** A recorded base revision and a runtime-derived
fallback are different facts. For a fresh run, the revision captured when its
workspace is created becomes the recorded baseline — that run observed the
commit its workspace was built from, so recording it is exactly right. For a
resumed run, only the checkpoint's existing `baseRevision` is authoritative. If
it is absent, a runtime-derived fallback may support non-destructive operations
but is never persisted as the run's baseline and never authorizes apply or
discard.

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
   patch representing that workspace's **current** contents **relative to the
   run's recorded base revision** was written first, or a fresh inspection
   against that same base proves the workspace holds no changes.
7. Every completion path terminates: no path can leave a pending prompt that
   never settles.
8. Every persisted artifact written to the run output directory — patches,
   transcripts, and context manifests — is written through an atomic rename so a
   partial file never occupies the final path. Temporary files in a process-owned
   `mkdtemp` directory, consumed by a subprocess within the same process
   lifetime, are outside this invariant. Lock records are also excluded: their
   exclusivity comes from `open(path, 'wx')`, which rename semantics would
   defeat. See "Lock recovery and ownership".
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

`apply-failed` means the requested apply did not happen and the checkout's
state is not known to be clean. It covers two cases:

- `git apply` itself failed after both gates passed. `git apply` without
  `--3way` validates before writing, so the expected state is an untouched
  checkout, but the contract does not promise that — the message must tell the
  user to inspect the checkout and points at the retained patch.
- **the gates could not be evaluated at all.** Codex found this reachable in
  slice 3: `patchApplicationRefusalReason` runs `git rev-parse` and
  `git apply --check` against the original checkout, and either can throw if
  that checkout has become unreadable. Nothing is applied in this case, so
  `apply-refused` looks tempting — but a refusal is a known answer, and here
  the answer is unknown. It is recorded as a failure, which exits `1` and tells
  the user to look, rather than as a refusal that a script would read as a
  deliberate decision.

Both cases keep the workspace and the patch.

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
- Known operational completion failures — patch creation, the apply gates, the
  apply itself, and workspace removal — are converted to outcomes inside the
  completion step and recorded there, before the `catch` handler is reached.
- The `catch` handler consults that flag first. When set, it never calls
  `saveState('failed')` or `saveState('cancelled')`. An unexpected
  post-boundary throw is reported with exit code `1` while the `completed`
  checkpoint remains unchanged; no outcome is fabricated.
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

**Version 3 is the new compatibility baseline, and no run-state migration
ships.** Revisions 1 through 6 specified a version 2 migration. That was
reconsidered against the evidence: no run checkpoint has ever been written on
the maintainer's machine — the `runs` directory does not exist — and the package
is unpublished. Migrating a format with no instances is speculative code on the
path that decides whether a user's work can be recovered.

The removal is scoped to run checkpoints only:

- `SavedRunV1`, `SavedRunV2`, their validators, and both migrations are deleted,
  along with `legacyDecision`, whose only remaining caller was the v1 migration.
- Only version 3 checkpoints are accepted. An older version is recognized by its
  version number and refused with a message that names the version, states that
  version 3 is the baseline, and says explicitly that the checkpoint file and
  any isolated workspace it created were left untouched. `list` skips such a
  checkpoint with a warning instead of failing.
- Version numbers are never reused. The next format change is version 4.
- **Chat session migrations are not touched.** They are load-bearing today: the
  maintainer's saved chats are at version 2 against a current format of version
  4, which is the concrete evidence that stranding persisted data is a real
  failure mode rather than a hypothetical one.

`completion` remains optional in version 3. Absent still reads as "no completion
was recorded" rather than as any particular outcome, which is what a checkpoint
written before slice 3 will look like.

Per `AGENTS.md`, the TypeScript type, `isSavedRun`, `hasOnlyKeys`,
`schemas/run-state.schema.json`, the superseded-version refusal, and fixture
tests change in one slice.

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

1. run a complete `createPatch` over the workspace's current contents
   **against the run's recorded `baseRevision`**, through the atomic path from
   D7;
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

#### Explicit baseline (D8)

Patch creation takes the baseline as a required argument instead of implying it
from the workspace's `HEAD`:

- `runCompleteWorkspaceDiff` seeds its temporary index from the current
  worktree and diffs it against the supplied `baseRevision`.
- `createPatch` and `workspaceFingerprint` both require the baseline. Making it
  required rather than defaulted forces every call site to state its intent,
  which is what the current implicit `HEAD` failed to do.

This changes `workspaceFingerprint` semantics, and the change is the point.
Against the moving `HEAD`, committing an edit returned the fingerprint to its
clean value: the work was still there, but the workspace looked untouched.
Against a fixed base the fingerprint keeps the value the edit gave it, so
committed and uncommitted work are indistinguishable to the comparison — which
is what it needs. Cycle-to-cycle comparison stays valid because the baseline is
stable across a run.

A run with no recorded `baseRevision` cannot be proven safe to discard. Removal
is refused for those runs with a message pointing at the retained workspace.
`patchApplicationRefusalReason` already refuses to apply in the same situation
([artifacts.ts:40](../src/artifacts.ts#L40)); this makes removal equally
conservative.

#### Commits inside a workspace

Fixing the baseline preserves the _content_ of committed work, but a patch
cannot carry commit messages, authorship, signatures, or topology. That is worth
surfacing before a destructive operation rather than flattening silently.

Revision 4 keyed this on `HEAD !== baseRevision`. Codex is right that the
predicate is too broad: a user who responds to the refusal by creating a branch
has made the history durable, yet the rule would keep refusing forever. The
question is not whether `HEAD` moved but whether anything would still point at
those commits afterwards.

The predicate is **anchoring**:

```text
git for-each-ref --contains <workspace HEAD> --count=1 refs/heads refs/tags
```

Verified to return nothing for a detached worktree commit and the ref name once
a branch or tag contains it. Refs are shared across worktrees, so this runs
correctly from inside the workspace.

- **Unanchored** — no branch or tag contains the workspace `HEAD`. Removing the
  worktree would drop the last reference to those commits. Non-interactive
  removal is refused, and the message explains how to anchor them
  (`git branch <name> <sha>` from inside the workspace).
- **Anchored** — a branch or tag contains `HEAD`. The history survives removal
  independently, so removal proceeds after the normal fresh-patch checks with no
  extra ceremony.
- **Interactive removal of unanchored history** remains permitted, behind a
  confirmation that states precisely what survives: the patch preserves the
  resulting files, not commit messages, authorship, signatures, or topology.

Describing the divergence requires care. `baseRevision` is not necessarily an
ancestor of `HEAD` — a reset or rebase inside the workspace breaks that
assumption — so the message distinguishes the two cases with
`git merge-base --is-ancestor`:

- ancestor: report the count from `git rev-list --count <base>..<HEAD>`;
- not an ancestor: report the workspace as **diverged** from its base and do not
  claim a commit count.

None of this engages on the normal path, where `HEAD` equals `baseRevision`.

#### The workspace starts where the baseline says (D10)

Codex found during slice 4 review that the recorded baseline and the workspace
were not guaranteed to be the same commit. `cli.ts` records the source revision,
then `createIsolatedWorktree` ran `git worktree add --detach <path> HEAD`,
resolving `HEAD` a second time. Reproduced directly: recorded `A`, advanced the
source to `B`, and the workspace was created at `B` while every later patch,
apply, and removal decision measured against `A`.

`createIsolatedWorktree` now requires an explicit revision and is given the
recorded baseline, so the workspace is pinned to the commit the run wrote down.

#### Baseline provenance (D9)

Two distinct values replace today's single `baseRevision` variable, and which
one exists depends on how the run started:

- **Fresh run.** The revision captured when its workspace is created is the
  **recorded** baseline. That run observed the commit its workspace was built
  from, so it is written to the checkpoint and authorizes apply and discard for
  the rest of the run's life. Nothing changes for these runs.
- **Resumed run.** Only the checkpoint's existing `baseRevision` is
  authoritative. When it is absent, a **derived** fallback may be computed at
  startup and used for non-destructive purposes — reporting, and any comparison
  whose failure mode is a message rather than a deletion — but it is never
  persisted as the run's baseline and never authorizes apply or discard.

So a legacy run keeps the fact that its original baseline is unknown for its
whole lifetime, across any number of resumes, while a run that recorded a real
baseline is unaffected.

This is enforced end to end rather than only at the call sites: a resume test
loads a checkpoint with no `baseRevision`, runs to completion, asserts that both
apply and discard are refused for that reason, and then reloads the saved
checkpoint and asserts `baseRevision` is still absent.

#### Atomic transcripts

The three transcript and context writes at [cli.ts:587](../src/cli.ts#L587)
move to `writePrivateFileAtomic`. Codex offered narrowing invariant 8 as the
alternative; routing them is correct, because `AGENTS.md` already requires every
persisted format to go through `filesystem.ts`, and all three are string writes
that match the helper's existing signature and file mode exactly.

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

After a successful apply, the summary reports how many files the patch touched.
It must not claim that `git diff` separates those changes from the user's own:
applied into a dirty checkout both are unstaged and appear together, which is
the condition D3 exists to disclose. The saved patch is the separate record.

Failure messages compose their guidance separately from the quoted command
output, so a long Git error truncates the error rather than the artifact
locations and the next command.

Recovery guidance does not embed a path in a pasteable command. Quoting is
shell-specific — POSIX single quotes are literal characters in `cmd.exe` — and
the parent shell cannot be inferred from inside the process, so a quoted
suggestion would be wrong on a supported platform. Paths, which may contain
spaces such as the macOS `Application Support`, are stated exactly and named as
the argument to a shell-neutral command. Run ids are printed unquoted inside the
suggested command, which is safe for every shell because `isSafeRunId` restricts
them to alphanumerics, dot, dash, and underscore; the discard suggestion prints
the actual run id rather than a placeholder.

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

**Adopted protocol.** Exclusivity comes from creating the lock, and D6 is
closed on the reader side instead:

1. Creating the lock is what confers ownership. Revision 14 makes that a
   directory rather than a file; see below.
2. The owner then writes a record containing the PID, hostname, a random
   ownership token, and the creation time.
3. Any other process that finds the path occupied and reads empty or malformed
   content treats it as an **occupied lock with an unknown owner** — never as
   stale, never removable.

Step 3 is the whole fix. The window between steps 1 and 2 still exists, but a
process observing it now backs off instead of unlinking a live lock.

`FileLock.release` re-reads the record and unlinks only when the ownership
token still matches, closing Codex's ABA case.

A lock is eligible for takeover only when the path is a plain file with exactly
one name, the record parses, its host matches the current host, and its PID is
gone. A symbolic link, a hard link, or any other special file at the lock path is
never treated as a lock and never written to. A record from a different host is not stale. A
missing, malformed, or unparseable record is unknown, never stale.

**Takeover must be atomic, not merely token-checked.** Revision 10's slice 7
compared the ownership token and then unlinked, which is not a fix: two
contenders can both read the same stale token, the first unlinks and claims a new
lock, and the second performs its already-authorized unlink and deletes the new
holder's lock. Codex found this under stress and it reproduces at 4 to 6 winners
out of 32 concurrent acquirers. The window is between two syscalls and cannot be
narrowed away.

Takeover therefore happens under a marker at `<lock>.takeover`, created with the
same exclusive open, so at most one process is inside it; and the stale record is
overwritten **in place** rather than removed and recreated, so the lock path is
never briefly free for a further process to claim. No process unlinks a lock file
it does not own. A marker left by a process interrupted inside the section is
never removed automatically either: it disables automatic takeover for that one
lock and is named in the message, degrading to the same manual recovery as any
unattributable lock rather than to a shared lock.

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

**Run state, versioned:** version 3 adds optional `completion` and becomes the
compatibility baseline. Type, `isSavedRun`, `hasOnlyKeys`, JSON Schema, the
superseded-version refusal, and fixtures change together in one slice. No
run-state migration ships: versions 1 and 2 are refused with an actionable
message that leaves the checkpoint and its workspace untouched. The version
field and the schema `const` stay, because they are what distinguishes "written
by an older build" from "corrupt", and they are what makes a future version 4
migration possible.

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

Type, validator, exact-key list, JSON Schema, and fixtures for the optional
`completion` record, plus removal of the version 1 and version 2 types,
validators, and migrations. No behavior yet reads or writes `completion` beyond
a round-trip test.

Acceptance: a version 3 fixture round-trips; a version 1 and a version 2 fixture
are each refused by version number with the file left byte-identical on disk; a
superseded checkpoint is skipped with a warning by `list` rather than failing
it; an unknown outcome string is rejected; each of the six cross-field
invariants is rejected by a dedicated case.

### Slice 3 — completion cannot fail a finished run

The one-way boundary flag, `declined`, the failure outcomes, outcome recording,
`printCompletion` on every completion-outcome path, and the exit-code rules.

"Every completion-outcome path" is the precise claim. Known operational
completion failures are converted to outcomes before reaching the catch
handler, so each of the nine outcomes reaches the final summary. Other throws
remain possible — including from constructing or using the prompt, which is
inside the completion step, not outside it. An unexpected post-boundary throw
is reported with exit code `1` while the `completed` checkpoint remains
unchanged; no outcome is fabricated and no summary is printed. That is the
boundary's floor, not its guarantee.

Acceptance: D1 no longer reproduces, in a deterministic test and in the PTY
harness; injected apply and removal failures leave a reloaded checkpoint whose
status is `completed`.

### Slice 4 — atomic artifacts, correct baselines, and safe discard

Atomic patch and transcript writing through `filesystem.ts` (D7), the explicit
baseline for patch creation and fingerprinting (D8), separated recorded and
derived baseline provenance (D9), the fresh-patch preservation rule, the
empty-workspace exception, the anchoring rules for committed history, and the
`agentCwd` reset on both the CLI and run-management removal paths.

Acceptance: an interrupted patch or transcript write never leaves a file at the
final path; a workspace edited after its patch was written is re-patched before
removal; a workspace holding a commit beyond its base produces a patch
containing that committed change; a no-change workspace is discardable; removal
is refused when patch creation fails, when the run has no recorded base
revision, and non-interactively when the workspace `HEAD` is unanchored;
removal proceeds once a branch or tag contains that `HEAD`; a resumed legacy run
never gains an apparently trusted baseline.

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

Implemented. Lock states are classified once, and `stale` — the only removable
one — requires a parsed record naming this host whose process is gone. Empty,
older-build, unparseable, over-long, and foreign-host records are all left in
place, each with its own recovery message; the contention message is composed
centrally, so both callers gained the lock path and a next step without changing
their own text. Two additions beyond the contract, both in the conservative
direction: the record is read through the bounded reader in `filesystem.ts`, so a
lock file too large to parse is unidentified rather than assumed dead, and a
`host` longer than 256 characters is treated as corruption rather than identity.
The host string is untrusted file content and is sanitized before it reaches a
message.

`takeOverStaleLock` is exported so each of its outcomes — owned, lost, vanished,
blocked — can be driven directly, and the concurrency test asserts that 32
contenders against one stale record yield exactly one holder, no surviving
takeover marker, and the winner's record on disk. `release` marks itself released
only after the lock is gone or provably no longer this holder's, so a release that
fails on a read-only directory can be retried once the cause is fixed.

Leaked takeover markers are deliberately not cleaned up by chat or run deletion.
Chat deletion holds the lock, so a concurrent takeover of it cannot be in
progress by the classification rules — but adding an unlink path for a file
another process may be holding trades a bounded piece of litter for a new way to
break mutual exclusion, which is the wrong direction for this slice.

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
  code `1`, asserted against a real `RunStateStore` rather than a returned
  value;
- an unreadable original checkout makes the apply gates unevaluable and is
  recorded as `apply-failed` rather than escaping the completion step;
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
- **D8 regression:** a user commits inside a retained worktree, then invokes
  `--discard-workspace`; the generated patch contains that committed change, and
  applying it to a fresh checkout of the base reproduces the committed content;
- an unanchored workspace `HEAD` is refused non-interactive removal, and the
  same workspace is removable once `git branch` anchors it;
- the interactive confirmation reports a commit count when `baseRevision` is an
  ancestor of `HEAD`, and reports divergence when it is not;
- removal refused for a run with no recorded `baseRevision`;
- **D9 end to end:** a resumed checkpoint with no `baseRevision` completes, both
  apply and discard are refused for that reason rather than proceeding against a
  revision derived at startup, and reloading the saved checkpoint afterwards
  shows `baseRevision` is still absent;
- a **fresh** run records the revision its workspace was created from, and its
  apply and discard paths are authorized by it;
- `workspaceFingerprint` changes when a commit is made inside the workspace,
  which it does not do today;
- after removal, both `workspace` and `agentCwd` are corrected;
- an interrupted patch or transcript write leaves no file at the final
  destination, and the three transcript artifacts are written atomically;
- `removeIsolatedWorktree` still refuses an unregistered path and the
  repository root itself;
- binary, executable-bit, symlink, deletion, and untracked-file patches survive
  a create-then-apply round trip;
- version 3 run-state fixture round-trips, and superseded version 1 and 2
  checkpoints refused by version number with their files left untouched;
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

1. D1 through D9 no longer reproduce, each with a test that fails against
   `8009945`.
2. `finishIsolatedRun` is driven entirely through injected input in tests.
3. Every completion outcome is reachable non-interactively except `ask`.
4. Once a run is recorded `completed`, no completion-step event can change that
   status, proven by reloading the checkpoint after injected failures.
5. No completion or run-management path removes a workspace without a fresh
   complete patch against the run's recorded base revision, or a fresh proof
   against that same base that the workspace holds no changes. Removal is
   refused when no base revision was recorded, and a revision derived at
   startup never satisfies that requirement.
6. No unattended path removes a workspace whose `HEAD` is contained by no
   branch or tag, and an anchored `HEAD` removes without extra ceremony.
7. Patch creation captures committed work inside a workspace, and no persisted
   run artifact — patch, transcript, or context manifest — can be observed
   partially written at its final path.
8. Interactive apply into a non-clean checkout discloses that state before
   asking and remains permitted; non-interactive apply into a non-clean
   checkout is refused.
9. Apply and removal failures name the artifact locations and the next step.
10. A lock is held by at most one process, is released only by its owner, and an
    unknown or foreign-host record is never removed automatically. Lock
    contention names the lock path and a recovery step.
11. Run state version 3 ships with type, validator, schema, superseded-version
    refusal, and fixtures changed together; every cross-field invariant is
    enforced at runtime; and version 1 and 2 checkpoints are refused with an
    actionable message that changes nothing on disk.
12. An impossible `--on-complete` is rejected before any provider call.
13. `artifacts.ts` line coverage above 90%; `file-lock.ts` branch coverage above
    80%.
14. `npm run check`, `npm run test:pty`, `npm run test:coverage`, and
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

**Revision 4** adds D8 and resolves the atomic-write scope.

D8 is Codex's finding and reproduces exactly as reported: patch creation seeds
its index from the workspace's current `HEAD` and diffs against that same
`HEAD`, so a commit made inside the worktree is invisible. Confirmed here that
the resulting commit is reachable from no branch or ref, meaning
`git worktree remove --force` drops the last reference to it — revision 3's
preservation rule would have authorized removing a workspace whose work it had
just failed to capture. Patch creation and fingerprinting now take an explicit
required baseline.

The transcript writes are routed through `writePrivateFileAtomic` rather than
narrowing invariant 8, since `AGENTS.md` already requires it and all three are
string writes matching the helper's signature. Invariant 8's scope is now
stated precisely: run-output artifacts are covered; process-owned `mkdtemp`
files consumed by a subprocess in the same process lifetime
([chat-workflow.ts:138](../src/chat-workflow.ts#L138),
[providers.ts:232](../src/providers.ts#L232)) are not.

One addition beyond the review, flagged for a ruling. Fixing the baseline
preserves committed _content_ but a patch cannot carry commit messages,
authorship, or history. Revision 4 therefore refuses non-interactive removal
when the workspace `HEAD` has moved past `baseRevision`, and requires an
interactive confirmation naming the commit count. This does not touch the
normal path, where the two are equal.

**Revision 5** narrows the committed-history rule and adds D9.

Codex approved revision 4's safeguard in principle but correctly rejected its
predicate. `HEAD !== baseRevision` never clears, so a user who anchored their
commits to a branch — the very remedy the refusal recommends — would stay
blocked forever. The rule now turns on whether any branch or tag contains the
workspace `HEAD`, verified with `git for-each-ref --contains` inside a real
detached worktree. Divergence is reported with `git merge-base --is-ancestor`
rather than assuming a linear count, and the interactive confirmation now
enumerates what a patch cannot carry: messages, authorship, signatures, and
topology.

D9 is Codex's finding and is an existing defect, not only an interaction with
this contract. `baseRevision ??= await currentCommit(repository)` gives a
resumed legacy run a fabricated baseline, which disables
`patchApplicationRefusalReason`'s "predates base-revision tracking" branch and
makes its revision comparison pass by construction — so a legacy run can already
auto-apply a patch whose true base is unknown. Recorded and derived baselines
are now separate fields, only the recorded one authorizes apply or discard, and
an end-to-end resume test enforces it.

**Revision 6** corrects the baseline-provenance wording.

Revision 5 said a derived revision "is never promoted into the recorded field",
which read as applying to every run and would have left fresh runs with no
authoritative baseline — refusing their apply and discard paths too. The rule
is scoped where it belongs: a fresh run records the revision its workspace was
created from, and only a _resumed_ run must never persist a derived fallback.
The D9 test also reloads the saved checkpoint and asserts `baseRevision` is
still absent, and a matching criterion covers the fresh-run path.

**Revision 7** drops run-state migration in favour of a version 3 baseline.

Requested by the maintainer during slice 2 and scoped by Codex to run
checkpoints only. The evidence behind it: no run checkpoint has ever been
written on the maintainer's machine, and the package is unpublished, so both
migrations existed for zero files. `SavedRunV1`, `SavedRunV2`, their validators,
both migrations, and the now-unreferenced `legacyDecision` are removed; older
versions are refused by version number with the checkpoint and its workspace
left untouched.

Chat migrations are deliberately untouched, and the reason is the same evidence
read the other way: the maintainer's saved chats are at version 2 against a
current format of version 4. Removing those would strand real data.

**Revision 8** widens `apply-failed` and states what the summary guarantee is.

Codex found during slice 3 review that `patchApplicationRefusalReason` can
throw — it shells out to `git rev-parse` and `git apply --check` against the
original checkout — so a completion could still escape without an outcome or a
final summary. `apply-failed` now covers gates that could not be evaluated, and
"`printCompletion` on every path" is stated precisely as every
completion-outcome path, with the residual unexpected-throw behavior named
rather than implied.

The boundary description carried the contradiction that made this easy to miss:
it promised the catch handler "records the corresponding failure outcome",
which was never true of an unexpected throw. Both places now say the same
thing — known operational failures become outcomes inside the completion step,
and an unexpected post-boundary throw fabricates nothing. Prompt construction
and use are named as inside the completion step, since "somewhere else" was
wrong.

**Revision 9** records D10 and two slice 4 boundary corrections.

Codex reproduced both against the slice 4 implementation. D10 is the workspace
baseline mismatch above. The second is that `planWorkspaceRemoval` guarded
patch creation but not the history inspection that follows it: a `baseRevision`
naming a tree object lets the patch succeed and then makes
`git merge-base --is-ancestor` exit 128, so the gate threw instead of returning
an outcome — and the persisted-state validator accepts that input, because
`baseRevision` is any string. Both history checks are inside the guard now and
return a bounded `discard-failed` that names the refreshed patch.

The fingerprint description was also wrong in the same direction as the fix.
Against a moving `HEAD` a commit returned the fingerprint to its clean value;
the property is that a fixed base keeps the edited value, not that the
fingerprint "moves when an agent commits". The test always asserted the correct
property.

**Revision 10** drops the shell-quoting claim from recovery guidance.

Slice 6's first attempt at making suggested commands runnable used POSIX single
quotes. Codex's review is correct that this is not portable: in `cmd.exe` single
quotes are ordinary characters and protect nothing, so a Windows path under
`Application Support` was no more runnable than before, only differently wrong —
and the test proving the quoting asserted zsh syntax on a tool that supports
Windows. The parent shell is not inferable from inside the process, so no single
quoting rule can be correct. Guidance now states paths exactly and names a
shell-neutral command, prints run ids unquoted under the `isSafeRunId` character
set, and the `shellQuote` helper is removed rather than kept as a
platform-specific trap.

**Revision 11** replaces token-checked stale removal with an atomic takeover.

Codex's stress finding is correct and was reproduced here before changing
anything: 32 concurrent acquirers against one stale record produced 4 to 6
winners across five iterations. The first slice 7 implementation authorized a
removal from an observation and then acted on it, so several contenders each held
a valid authorization to unlink — and the later ones deleted the lock the earlier
winner had just created. My own test for that case replaced the record before the
re-check rather than between the re-check and the unlink, so it proved the wrong
property, and both the design note and this contract described a narrowed window
as a closed one.

Removal is gone entirely. Takeover runs under an exclusively created
`<lock>.takeover` marker and overwrites the stale record in place; the same
stress now yields exactly one winner in 180 rounds at 2, 32, and 64 contenders,
with no surviving markers and the winner's record on disk. The residual
empty-lock case recorded in revision 2 is unchanged, and the leaked-marker case
is its exact analogue: no automatic recovery, named in the message.

Codex's second finding is also correct. `release` set its released flag before
unlinking, so a release that failed on a read-only directory could not be
retried; a second call returned without removing anything. The flag now moves
only after the lock is gone or is provably no longer this holder's.

**Revision 12** refuses lock paths that are not plain files.

Codex's finding, reproduced before changing anything: the in-place overwrite
opened the lock path with `r+`, which follows a symbolic link. A link pointing at
any file whose contents happen to parse as a stale record made acquisition
succeed and rewrote that file. This is the cost of moving from unlink to
overwrite, and revision 11 did not account for it — the existing symlink test
covered only a dangling link, which fails to resolve for an unrelated reason.

A lock path must now be a plain file with exactly one name. Classification
`lstat`s the path, so a link is seen as a link rather than as its target, and a
hard-linked file is refused too. The takeover additionally opens with
`O_NOFOLLOW`, checks the opened handle with `fstat`, and re-reads the record
through that same handle before writing to it, so the object verified is the
object overwritten.

Record writes now account for `bytesWritten` in a loop. Ignoring a short write
could have left a truncated record at a path this process then reported as owned —
an unreadable lock presented as a held one. The loop is tested against a writer
that reports one byte at a time and against one that never progresses.

The handle-level guards inside the takeover are deliberately unreachable from the
tests: path classification rejects a link before the takeover starts, so `fstat`,
the through-the-handle record confirmation, and the `O_NOFOLLOW` error mapping can
only fire if the path changes between classifying and opening it. They are the
defense for that race and are reported as uncovered rather than presented as
proven.

**Revision 13** refuses automatic takeover where links cannot be refused on open.

Revision 12 recorded the Windows window as a known residual while `docs/security.md`
promised that a link is never written through. Codex is right that those cannot
both stand, and that the resolution is the conservative one: `O_NOFOLLOW` does not
exist on Windows, so a lock path can turn into a link between being classified and
being opened, and the overwrite would land on whatever it points at.

Automatic takeover is now refused outright wherever that flag is unavailable,
before the takeover marker is even created, and the contention message says the
lock was left behind, that it is untouched, and to delete it. Losing automatic
recovery from a crashed run costs one deletion; overwriting an unrelated file
costs that file. The guarantee in `docs/security.md` now holds on every platform.

The capability is an injected parameter defaulting to the platform value, so the
refusal is tested everywhere rather than only where the flag is missing. Two
Windows-only tests assert the native behaviour in CI, which already runs
`windows-latest`: a stale record survives acquisition with a message naming the
recovery, and 32 concurrent contenders leave it byte-identical with no winner. The
tests that require takeover to succeed, and the two link tests — symbolic links
need a privilege Windows CI does not grant, and hard-link counts are not reported
the same way there — are skipped on that platform and say why.

Verified locally before handoff by forcing the flag to zero: the stale record was
preserved, the symlink-swap target was untouched, a free lock path still worked,
and the file was restored byte-identical afterwards.

**Revision 14** makes the lock a directory, and fixes eight portability defects.

The required Windows gate on PR #22 failed, and it was right to. Codex reduced the
lock failure correctly: `open(path, 'wx')` carries no no-follow guarantee on
Windows, which resolves a link at the path and creates its target. The Windows job
proved it by acquiring a lock through a dangling link and writing that link's
target. The refusal added in revision 13 covered only takeover, not initial
acquisition — and since acquisition cannot be refused without disabling the
product on Windows, the primitive itself had to change. An `lstat` before the open
would only narrow the window.

A lock is now a **directory**, and the record naming its owner is a file inside
it. Creating a directory is atomic and never resolves a link at the name being
created, on every platform and every filesystem, so publication is link-safe
everywhere without needing a flag Windows lacks. The classification, the ownership
token, the serialized in-place takeover, and the Windows takeover refusal are all
unchanged in substance; they now read `owner.json` inside the lock, and the
takeover marker moved inside it too, so it can no longer outlive its lock as loose
litter. A lock left by an older build is a plain file at the lock path, which is
recognised as such and reported for deletion rather than treated as corruption.

The record file inside a freshly created lock keeps one documented residual where
no no-follow open exists: exclusive create cannot overwrite anything, because it
fails when the resolved name exists, so the exposure is limited to creating a file
at a path that does not exist yet, and only for whoever can write into a directory
that did not exist a moment earlier. It is detected immediately afterwards and
refused rather than reported as a held lock.

The other eight Windows failures were test portability, fixed without weakening
any assertion:

- Four content assertions saw CRLF, because Git for Windows rewrites line endings
  on checkout by default. The fixture repositories now set `core.autocrlf=false`,
  so the tests compare the bytes they wrote rather than each assertion tolerating
  what the environment did.
- One assertion built a `RegExp` from a Windows path, whose separators are escape
  characters. It compares text now.
- Three assertions required mode `0600`, which Windows does not implement and
  reports as `0666`. They assert the mode only where the platform enforces it,
  which is what `docs/security.md` has always promised with "where supported".
  Every other assertion in those tests still runs on every platform.

**Revision 15** measures test capabilities, and states the record-creation
residual instead of implying it away.

Three corrections from Codex's review of the directory lock.

The first is mine to own. The Windows dangling-symlink regression test — the one
that exposed the original defect — was gated on `process.platform !== 'win32'`
when the link tests were grouped together, so it reported `# SKIP`, and it was
reported here as passing on Windows. It was not run. The earlier failing run is
itself the proof that the runner can create that link. Capabilities are now
probed rather than assumed: whether symbolic links can be created, whether hard
links are counted, and whether directory modes are enforced are each measured at
startup, so a test is skipped only where the operating system actually prevents
it. The takeover gate reads the exported capability from `file-lock.ts` instead of
repeating its platform reasoning.

The second is the record-creation window. `docs/security.md` promised that a link
in either position is never written through, while `publishOwnerRecord` admits a
link raced into a newly created lock directory could redirect the creation where
no no-follow open exists. Codex offered closing the window or narrowing the
documented model; the model is narrowed, because the claim was the inaccurate part.
Exclusive create cannot modify anything that exists, so the residual is confined
to creating a file at a path that does not exist yet, by someone who already has
write access to a directory created moments earlier inside the user's own
owner-only data directory. It is detected immediately and refused. An
unpredictable record name would close it and is recorded as the extension point.

The third is the red Windows gate. Every functional test passed — 345 passed, 0
failed, 17 skipped — and Node's coverage reporter then failed with
`Unexpected end of JSON input`, exiting 1. The cause is child coverage reports:
a Node process spawned by a test inherits `NODE_V8_COVERAGE` and writes its own
report into the same directory the reporter is reading. The four test files that
spawn Node children now clear that variable, which was verified not to affect
those files' own coverage, since V8 enabled it at startup. Whether this was the
whole cause is for the Windows job to confirm, not for this document to assert.

## Questions for review

None. Revision 7 records the migration decision, revision 6 adopted the scoping
correction, revision 5 adopted both earlier requested corrections, and the
remaining open items
are recorded as decisions: the empty-lock residual, accepted in exchange for
guaranteed mutual exclusion and mitigated by naming that case in the recovery
message; scoping `completion` to the run's own completion step, which follows
from the version 3 cross-field invariants; and the committed-history safeguard,
now keyed on anchoring per this review.
