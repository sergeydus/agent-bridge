# Workflow state machine

The workflow engine is deterministic. Provider adapters return structured
responses; they do not choose the next role or decide convergence.

## Interactive chat

```text
created or reopened
  → human message
  → first read-only agent response (checkpoint)
  → second read-only agent critique (checkpoint)
      ├─ either decision is continue → exchange open
      └─ both decisions are done → first agent confirmation (checkpoint)
  → human prompt
      ├─ another message
      ├─ /auto → bounded paired exchanges
      ├─ /review or editing command → existing child workflow → human prompt
      ├─ /pause → paused
      └─ /done → completed
```

The first speaker alternates. If interruption occurs between stages, the
checkpoint records either the pending peer or pending reciprocal confirmation;
resume calls only the missing provider. Chat presents none, pending peer,
pending confirmation, open, confirmed, abandoned, and a legacy-only
unconfirmed two-`done` state. Confirmation means the original first agent
accepted the exact saved peer response with no unresolved point. It is not
independent verification, implementation approval, or write authorization.
`/auto` stops only on confirmed and treats its conditional third call as part
of the same bounded exchange.

Complete input lines received during provider work wait in the readline queue
until the next human prompt. They cannot enter between the first and second
provider responses of an in-progress pair.

## Review-only

```text
created
  → discussion cycle 1
  → discussion cycle 2 ... limit
  → synthesizing
  → completed
```

Each cycle calls both providers read-only. In fixed-round mode the configured
number of cycles always runs. In agreement mode the engine can stop when both
agents return `done`.

## Editing

```text
created
  → planning round 1 (both read-only)
  → planning round 2 (both read-only)
  → implementation cycle N
      → writer edits
      → exact revision captured
      → protected paths checked
      → approved verification runs
      → other agent reviews read-only
      → same-cycle decisions evaluated
      → roles alternate or repeat
  → synthesizing
  → completed
```

Collaborative mode alternates writers. Fixed-role mode keeps one writer.

## Agreement rule

A cycle converges only when:

1. the writer returns a schema-valid `done` decision;
2. the reviewer returns a schema-valid `done` decision;
3. both decisions belong to the same captured cycle and revision.

Planning agreement does not complete implementation. A reviewer approving an
older revision does not approve a later edit. Human-readable text is retained
for context but never parsed for workflow control.

The cycle cap is always enforced. `--require-agreement` makes a cap without
agreement an exit-code failure; without it, the final outcome clearly states
that the cap was reached.

## Checkpoints

The coordinator checkpoints statuses such as `planning`, `implementing`,
`reviewing`, and `synthesizing`. Each saved run includes:

- workflow and provider settings;
- task and workspace paths;
- base and current revisions;
- completed rounds and structured decisions;
- trusted verification commands;
- protected-path fingerprints.

An exclusive lock prevents concurrent resume. A cancelled or failed run keeps
the isolated worktree so the user can inspect uncertain partial edits.

After a writer returns, a pending-review checkpoint records its structured
decision before verification or review begins. Interruption therefore resumes
at verification or the read-only review instead of repeating a completed
write. The saved workspace revision is checked before recovery.

The workspace is captured both before and after verification. If an approved
verification command changes the patch, the earlier writer decision is changed
to `continue`; the new revision cannot converge until an implementer explicitly
accepts it. A final capture also revokes agreement if anything changes after
the approving review.
