# Phase 4: completion and recovery hardening

Status: Proposed contract; awaiting Codex review before implementation

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
Reproduced in a PTY: the process exits with code 1 after printing the raw
abort stack.

The rejection propagates out of `finishIsolatedRun` into the `cli.ts` handler at
[cli.ts:672](../src/cli.ts#L672). The signal is not aborted and the error is not
a `ProcessAbortError`, so the run takes the failure branch:

- `saveState('failed', …)` is written;
- `saveState('completed')` at [cli.ts:662](../src/cli.ts#L662) never runs;
- `printCompletion` never runs, so the user is not told where anything landed;
- `--no-transcript` cleanup never runs.

The consequence outlives the process. `discardRunWorkspace` refuses any run whose
status is not `completed` or `cancelled`
([runs.ts:66](../src/runs.ts#L66)), so the isolated worktree created by a run
that finished successfully can no longer be discarded through run management.
The agents' work is intact on disk and the checkpoint describes it as a failure.

Pressing Ctrl+D at a menu is a normal way to decline. It must not be able to
invalidate a completed run.

### D2 — completion is unreachable without a TTY

`finishIsolatedRun` returns early when either stream is not a TTY
([artifacts.ts:74](../src/artifacts.ts#L74)). Every non-interactive run therefore
ends with the workspace kept, and there is no flag that selects any other
outcome. A CI job or script can produce a patch but can never ask Agent Bridge
to apply it, and cannot clean up after itself.

`AGENTS.md` requires preserving "both the novice wizard and complete
scriptability". The completion step is the one place where that does not hold.

### D3 — applying into a dirty checkout is silent

`patchApplicationRefusalReason` checks the base revision and `git apply --check`.
Neither observes unrelated uncommitted work in the target checkout. Reproduced:
with `b.txt` modified and `c.txt` untracked, a patch touching only `a.txt`
passes `--check` and applies. Afterwards the checkout holds the user's edits and
the agents' edits with nothing distinguishing them.

This is the documented action and must remain available. The defect is that the
user authorizes it without being told the state they are applying into. Agent
Bridge does not commit or stage, so there is no undo.

### D4 — application and removal failures name no corrective action

`applyPatch` and `removeIsolatedWorktree` surface raw process errors. A failed
apply does not say that the patch is still on disk, where, or that the checkout
was not modified. `AGENTS.md` requires that error messages explain the safest
corrective action.

### D5 — lock contention names no recovery

Both callers of `acquireFileLock` pass a message of the form
`Chat <id> is already open in another Agent Bridge process.`
([chat-state.ts:723](../src/chat-state.ts#L723),
[state.ts:417](../src/state.ts#L417)). Neither names the lock file or any way
forward.

`removeStaleLock` clears a lock only when `process.kill(pid, 0)` reports `ESRCH`.
Two reachable states leave a permanent lock with no documented recovery: an
unrelated live process inheriting the recorded PID, and `EPERM` from a live
process owned by another user. The lock record also carries no host identity, so
a PID written on one machine is meaningless if the data directory is synced or
shared.

## Non-goals

Phase 4 does not:

- change which agent may edit, or allow simultaneous writers;
- add automatic retry of any write call;
- commit, stage, reset, or stash anything in the target project;
- apply a patch without an explicit interactive answer or explicit flag;
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
5. The completion step cannot change the recorded outcome of the work that
   preceded it. A run whose agents finished is recorded as finished regardless
   of what happens at the prompt.
6. No completion path deletes the only remaining copy of agent work. Discarding
   a workspace requires a patch to exist on disk first.
7. Every completion path terminates: no path can leave a pending prompt that
   never settles.
8. Subprocesses keep `shell: false` and argument-array execution.
9. Error messages name the failed action, where the artifacts are, and the
   safest next step.

Invariants 4 through 7 are new. The rest restate existing project invariants
that this phase must not weaken.

## Design

### Completion outcomes

The completion step resolves to exactly one outcome, and each is reportable:

| Outcome         | Workspace | Patch   | Original checkout |
| --------------- | --------- | ------- | ----------------- |
| `kept`          | retained  | on disk | untouched         |
| `applied`       | retained  | on disk | patch applied     |
| `apply-refused` | retained  | on disk | untouched         |
| `discarded`     | removed   | on disk | untouched         |
| `no-changes`    | retained  | none    | untouched         |
| `declined`      | retained  | on disk | untouched         |

`declined` is the new outcome covering D1: the user ended input, cancelled, or
was never asked because no interactive terminal was available. It is
indistinguishable from `kept` in its effect on disk and is reported separately
only so the completion summary can be honest about whether a choice was made.

`apply-refused` is the existing behavior when a refusal reason is returned. It
is named here so it can be asserted rather than inferred from a warning string.

### Injectable prompt boundary

`finishIsolatedRun` takes its input source as a parameter rather than reading
`process.stdin`. The boundary is the smallest thing that satisfies the
function:

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

A `CompletionPrompt` is constructed only when both streams are TTYs. Otherwise
the non-interactive path runs without one.

### Scriptable completion

Add one option:

```text
--on-complete ask|keep|apply|discard
```

- `ask` is the default and preserves today's interactive menu.
- `keep` is the default when either stream is not a TTY, matching current
  non-interactive behavior exactly.
- `apply` runs the same base-revision and `git apply --check` gates. A refusal
  is reported and the outcome is `apply-refused`; it is never escalated.
- `discard` removes the worktree through `removeIsolatedWorktree` only if a
  patch was written. It skips the interactive confirmation because the flag is
  itself the explicit instruction, and it is rejected at parse time when
  combined with `--no-isolation`, where there is no isolated workspace to
  discard.

`--on-complete` is not persisted in run state, and run state stays at version 2.
Rationale: the value is consumed once, in the process that reaches completion,
and it is the non-interactive equivalent of typing an answer at the prompt.
Typed answers are not checkpointed either. Persisting it would mean a resumed
run could apply a patch because of a flag passed to an earlier, different
invocation, which is a worse outcome than requiring the flag again.

This is the decision in this contract most worth a second opinion, because
`--no-transcript` is persisted and is also consumed only at the end. The
difference claimed here is that `--no-transcript` governs what gets written
throughout the run, while `--on-complete` governs one terminal action. If Codex
reads that distinction as too thin, the alternative is run state version 3 with
validator, schema, migration, and fixture changes together, and this contract
should be revised before implementation rather than during it.

### Ordering

`saveState('completed')` moves ahead of `finishIsolatedRun`, and the completion
outcome is recorded by a second save afterwards. This is what makes invariant 5
enforceable: the run is durably marked finished before any interactive step can
fail, and the later save only refines `workspace` and the recorded outcome.

`printCompletion` runs on every path out of completion, including `declined`.

### Disclosure before applying

Before applying, and before the confirmation in `ask` mode, the completion step
reports the target checkout's status when it is not clean: how many tracked
files are modified and how many untracked files are present. It does not list
paths, because the compact status region does not expose project paths by
default.

Applying into a dirty checkout remains allowed. The user is told what they are
mixing into, which is what D3 lacks.

After a successful apply, the summary reports the number of files the patch
touched, so the user can tell agent changes from their own while the two are
still separable in memory.

### Lock recovery

`acquireFileLock` gains a caller-supplied recovery hint appended to
`activeMessage`, naming the lock path. `removeStaleLock` records the hostname
alongside the PID and treats a record from a different host as not-stale, since
the PID cannot be evaluated there — the current code would evaluate a foreign
PID against local processes, which is capable of clearing a lock that is
genuinely held.

Lock files written by earlier versions have no `host` field. They are treated
exactly as today, so this is backward compatible and needs no migration.

This slice is independent of the rest of the phase and can be dropped without
affecting the others.

## Migration impact

None. No persisted format changes.

- Run state stays at version 2; `--on-complete` is not checkpointed.
- Chat session state is untouched.
- Lock files gain an optional field that older readers ignore and that newer
  readers treat conservatively when absent.

If review overturns the `--on-complete` persistence decision, this section
changes to a full version-3 migration and the contract must be re-approved.

## Slices

Each slice leaves the tree releasable and is independently reviewable.

### Slice 1 — testable completion boundary, no behavior change

Introduce `CompletionPrompt`, inject it into `finishIsolatedRun`, and add
deterministic tests for every existing path against temporary repositories:
no-changes, keep, apply, apply refused for each of the three refusal reasons,
discard confirmed, discard declined, and invalid-then-valid menu input.

Acceptance: `artifacts.ts` line and function coverage above 90%, with the
observable behavior of every existing path unchanged.

### Slice 2 — completion cannot fail a finished run

Convert end-of-input and cancellation to `undefined`, add the `declined`
outcome, move `saveState('completed')` ahead of the completion step, record the
outcome in a following save, and make `printCompletion` run on every path.

Acceptance: D1 no longer reproduces, in a deterministic test and in the PTY
harness.

### Slice 3 — scriptable completion

Add `--on-complete`, its validation, help text, README coverage, and the
non-interactive defaults.

Acceptance: every outcome reachable without a TTY except `ask`; `--on-complete
discard` with `--no-isolation` rejected at parse time.

### Slice 4 — disclosure and error quality

Add the pre-apply dirty-checkout disclosure, the post-apply touched-file count,
and corrective-action messages for apply and worktree-removal failures.

Acceptance: D3 and D4 no longer reproduce.

### Slice 5 — lock recovery

Recovery hints in both lock messages, host recording, and cross-host
conservatism.

Acceptance: D5 no longer reproduces; `file-lock.ts` branch coverage above 80%.

## Test strategy

All tests use temporary Git repositories, temporary `AGENT_BRIDGE_HOME`, and
injected prompts. No network, no provider authentication, no dependency on this
repository.

### Deterministic

- every completion outcome, including each refusal reason separately;
- `ask(…)` resolving `undefined` produces `declined`, and the run's recorded
  status remains `completed`;
- a run left by a declined completion can still be discarded through
  `discardRunWorkspace`, which is the durable consequence of D1;
- `--on-complete` parsing, defaults, TTY interaction, and rejected combinations;
- apply into a clean checkout, into a checkout with unrelated modifications, and
  into a checkout with an untracked-file collision;
- apply refused when the base revision moved, when no base revision was
  recorded, and when `git apply --check` fails;
- discard refused when no patch exists on disk (invariant 6);
- `removeIsolatedWorktree` still refuses an unregistered path and the repository
  root itself;
- binary, executable-bit, symlink, deletion, and untracked-file patches survive
  a create-then-apply round trip;
- lock messages name the lock path; a foreign-host lock record is not cleared;
  a local record whose PID is gone is cleared.

### PTY

The existing harness gains one case: Ctrl+D at the completion prompt exits 0,
prints a completion summary naming the retained workspace and patch, and leaves
a checkpoint whose status is `completed`. This case belongs in the PTY suite
rather than the deterministic suite because the `ABORT_ERR` rejection in D1
only occurs on a real terminal driver.

### Required project checks

`npm run check`, `npm run test:pty`, `npm run test:coverage`, and
`npm pack --dry-run` before each handoff.

Coverage thresholds rise with the phase: functions from 65 to 70 in slice 1,
lines from 60 to 65 in slice 5. Thresholds are raised only after the covering
tests land, never in the same commit that would otherwise fail them.

## Acceptance criteria

Phase 4 is complete when:

1. D1 through D5 no longer reproduce, each with a test that fails against
   `8009945`.
2. `finishIsolatedRun` is driven entirely through injected input in tests.
3. Every completion outcome is reachable non-interactively except `ask`.
4. No completion path can change the recorded outcome of the preceding work.
5. No completion path removes the only copy of agent work.
6. Applying into a non-clean checkout discloses that state first and remains
   permitted.
7. Apply and removal failures name the artifact locations and the next step.
8. Lock contention names the lock path and a recovery step, and a foreign-host
   lock record is never cleared automatically.
9. No persisted format changed, or the contract was revised and re-approved
   before it did.
10. `artifacts.ts` line coverage above 90%; `file-lock.ts` branch coverage above
    80%.
11. `npm run check`, `npm run test:pty`, `npm run test:coverage`, and
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

## Questions for review

1. The `--on-complete` persistence decision above, against the `--no-transcript`
   precedent. This is the only decision that would change the migration section.
2. Whether `--on-complete discard` should require an additional explicit
   acknowledgement flag, given that it is the one non-interactive path that
   permanently removes a worktree. This contract argues the flag is sufficient
   because a patch is required to exist first, but it is a destructive default
   worth challenging.
3. Whether slice 5 belongs in this phase at all, or is better handled as an
   independent fix. It shares the recovery theme but touches none of the same
   code.
4. Whether the coverage thresholds should rise at all, given that a threshold
   is a floor rather than evidence.
