# Phase 2: reciprocal chat agreement

Status: implemented across all four slices and verified with the project check,
coverage thresholds, package dry run, and whitespace check.

## Objective

Make an interactive-chat agreement reciprocal without weakening recovery,
read-only permissions, bounded automation, or honest presentation.

The current paired exchange calls two providers:

```text
human -> first agent -> second agent -> human
```

The second agent sees the first agent's current response. The first agent does
not see the second agent's current response, so two `done` decisions currently
mean only that both agents marked the pair done. They are not a reciprocal
acceptance of the same final reasoning.

Phase 2 adds a conditional confirmation call:

```text
human -> first agent -> second agent
                            |
                            +-- either initial decision is continue
                            |      -> exchange is open
                            |
                            +-- both initial decisions are done
                                   -> first agent confirms the exact second response
                                          |
                                          +-- done -> reciprocally confirmed
                                          +-- continue -> exchange is open
```

The third call occurs only after two provisional `done` decisions. Ordinary
open exchanges remain two provider calls.

## Non-goals

Phase 2 does not:

- add write access to chat turns;
- change the shared provider response schema;
- claim independent verification or implementation approval;
- introduce provider-native persistent sessions;
- add rolling summaries or per-message token telemetry;
- solve partial TTY echo or the remaining low-level terminal test gaps;
- allow human input to enter between steps of one paired exchange.

## Terminology

- **First response**: the first agent's response in a paired exchange.
- **Peer response**: the second agent's critique of the first response.
- **Provisional done**: both initial responses have decision `done`, but the
  first agent has not yet evaluated the current peer response.
- **Confirmation**: the first agent's response to the exact peer response.
- **Reciprocally confirmed**: the first response, peer response, and
  confirmation all have decision `done` and belong to the same checkpointed
  exchange.
- **Open**: at least one required decision is `continue`.
- **Abandoned**: the human explicitly completes the chat while a peer or
  confirmation response is still pending. Saved responses remain in history,
  but the exchange is never presented as open or confirmed.

Reciprocal confirmation remains a conversational result. It never authorizes
editing, proves correctness independently, or replaces a review workflow.

## Persisted contract

The chat session format advances from version 3 to version 4.

### Pending exchange

`pendingExchange` becomes a discriminated union:

```ts
type PendingChatExchange =
  | {
      stage: 'awaiting-peer';
      firstAgent: AgentName;
      secondAgent: AgentName;
      firstMessageSequence: number;
    }
  | {
      stage: 'awaiting-confirmation';
      firstAgent: AgentName;
      secondAgent: AgentName;
      firstMessageSequence: number;
      secondMessageSequence: number;
    };
```

The union records only missing work. It is cleared only after the logical
exchange has reached an open or confirmed terminal state, or after the human
explicitly abandons it while completing the session.

### Latest recorded paired exchange

Version 4 adds an optional record for the most recently settled or explicitly
abandoned paired exchange:

```ts
interface SettledChatExchange {
  firstAgent: AgentName;
  secondAgent: AgentName;
  firstMessageSequence: number;
  secondMessageSequence: number;
  confirmationMessageSequence?: number;
  outcome: 'open' | 'confirmed';
}

interface AbandonedChatExchange {
  firstAgent: AgentName;
  secondAgent: AgentName;
  firstMessageSequence: number;
  secondMessageSequence?: number;
  outcome: 'abandoned';
}

type RecordedChatExchange = SettledChatExchange | AbandonedChatExchange;

interface ChatSession {
  version: 4;
  // existing fields remain unchanged
  pendingExchange?: PendingChatExchange;
  latestPairedExchange?: RecordedChatExchange;
}
```

`latestPairedExchange` avoids inferring a confirmation from arbitrary adjacent
messages. It is historical evidence, not a lock. A newer user, system, or
targeted-agent message makes the presented current-exchange state `none` until
a new paired exchange begins.

Targeted `/ask` turns never create or replace `latestPairedExchange` and never
change `nextFirstAgent`.

### Runtime validation invariants

Validation must reject a version 4 session unless all of these hold:

1. `firstAgent` and `secondAgent` are distinct known agents.
2. Every referenced sequence exists and exactly matches its message's stored
   `sequence`.
3. The first referenced message has role `firstAgent`; the second has role
   `secondAgent`; the confirmation, when present, has role `firstAgent`.
4. Present first, second, and confirmation responses are adjacent in that
   order.
5. An `awaiting-peer` record points to the final saved message.
6. An `awaiting-confirmation` record points to two final adjacent messages,
   both with decision `done`.
7. A settled exchange has a confirmation sequence only when both initial
   decisions are `done`.
8. A settled `confirmed` exchange has a confirmation sequence and all three
   referenced decisions are `done`.
9. A settled `open` exchange without confirmation has at least one initial
   `continue` decision. An open exchange with confirmation has two initial
   `done` decisions and a `continue` confirmation.
10. An `abandoned` exchange has no confirmation sequence. If it has a second
    response, both initial decisions are `done`; otherwise it corresponds to
    abandonment at the `awaiting-peer` stage.
11. A completed session never carries `pendingExchange`.
12. `pendingExchange` and `latestPairedExchange` may coexist only because the
    recorded exchange is older. The pending exchange's first
    sequence must be strictly later than the completed record's final sequence.
13. The final sequence of a recorded exchange is its confirmation sequence
    when present, otherwise its second sequence when present, otherwise its
    first sequence.
14. Sequence references, message counts, and all existing file-size bounds
    remain enforced.

The TypeScript types, runtime validator, JSON Schema, migrations, and fixture
tests must change together.

The JSON Schema documents the persisted structure: allowed properties,
required fields, discriminated union shapes, and scalar bounds. The runtime
validator is authoritative for semantic relationships that JSON Schema cannot
express, including message-role references, adjacency, decision consistency,
and ordering between pending and recorded exchanges. Tests cover these two
boundaries separately; the project does not add a JSON Schema execution engine
to imply cross-validation of semantics the schema cannot encode.

## State transitions

### Atomic checkpoint rule

For every successful provider call, appending the validated response and
updating all exchange fields form one indivisible checkpoint transition.
`pendingExchange`, `latestPairedExchange`, and `nextFirstAgent` are mutated in
memory before one `store.save` call. No valid checkpoint may contain the new
message with the old exchange state, or the new exchange state without its
message. Provider-response presentation events occur only after that save
succeeds. This rule does not change the existing presentation timing for user
input.

The same rule applies when `/done` abandons pending work: clearing the pending
record, recording the abandonment, advancing `nextFirstAgent`, and completing
the session are persisted by one atomic save.

### Starting a paired exchange

1. Select `firstAgent` from `nextFirstAgent`, falling back to the existing
   legacy calculation only when necessary.
2. Set `secondAgent` to the other provider.
3. Call the first agent read-only.
4. Append its response and set
   `pendingExchange.stage = 'awaiting-peer'` in memory.
5. Persist both changes with one atomic checkpoint save.

If the first call is cancelled before a response is checkpointed, no pending
exchange exists and no turn is recorded.

### Receiving the peer response

1. Call only `secondAgent`, passing the exact saved first response as the
   current peer response.
2. Append the peer response in memory.
3. If either initial decision is `continue`, prepare the same checkpoint to:
   - clear `pendingExchange`;
   - save `latestPairedExchange.outcome = 'open'` without a confirmation;
   - advance `nextFirstAgent` to the previous `secondAgent`.
4. If both initial decisions are `done`, prepare the same checkpoint to:
   - replace the pending record with
     `stage = 'awaiting-confirmation'`;
   - include both exact message sequences;
   - leave `nextFirstAgent` unchanged.
5. Persist the appended peer response and the selected state transition with
   one atomic checkpoint save.
6. Return control for an open exchange, or begin confirmation for provisional
   `done`.

### Receiving confirmation

1. Call only the original `firstAgent` with a dedicated confirmation prompt.
2. Pass both exact saved responses separately from the bounded history.
3. Append the confirmation response, clear `pendingExchange`, and prepare
   `latestPairedExchange` with all three sequences in memory.
4. Set the outcome to `confirmed` only when the confirmation decision is
   `done`; otherwise set it to `open`.
5. Advance `nextFirstAgent` to the previous `secondAgent`, regardless of the
   confirmation decision.
6. Persist the appended confirmation and every state change with one atomic
   checkpoint save.

A `continue` confirmation may contain new reasoning. It remains a real chat
message, and the previous second agent leads the next paired exchange so it can
respond to that reasoning.

## Confirmation prompt contract

The confirmation prompt belongs in `prompts.ts`. It must:

- identify the call as confirmation, not a new independent answer;
- include the first agent's saved response and the peer's saved response as
  separately JSON-encoded data;
- state that `done` means the agent accepts the exact peer response and sees no
  unresolved disagreement or action;
- require `continue` when correction, qualification, or further discussion is
  needed;
- require a concise `done` response to be acceptance rationale only, without a
  material new claim, recommendation, or action that the peer has not seen;
- retain the existing read-only and project-inspection rules;
- use the existing turn response schema.

No `acceptsPeerSequence` provider field is needed. The coordinator already
controls which exact checkpointed message is placed in the confirmation slot.

This terminates reciprocity by explicit prompt convention rather than by a
structural restriction on response text. The schema still permits a `done`
confirmation to contain substantive text the peer has not seen. Adding another
confirmation call would only move that residual forward indefinitely. Phase 2
accepts this bounded asymmetry, instructs the agent not to exploit it, and
continues to treat the structured decision as authoritative.

## Interruption and resume

The latest successful atomic checkpoint is authoritative.

| Saved state             | Resume action                              |
| ----------------------- | ------------------------------------------ |
| no pending exchange     | wait for human input                       |
| `awaiting-peer`         | call only `secondAgent`                    |
| `awaiting-confirmation` | call only `firstAgent` with the saved pair |

Resume must never repeat a response already present in the checkpoint.

If a provider returns but saving its response fails, the response is not
authoritative. The process stops with the last valid checkpoint intact. A
later resume may repeat that uncheckpointed read-only call; the error must say
that clearly.

While work is pending:

- complete queued input lines remain queued;
- a new ordinary or targeted message cannot be persisted;
- `/auto` continues the pending logical exchange as its first requested
  exchange;
- a linked workflow cannot start until the pending exchange settles;
- `/status`, `/history`, `/help`, and `/pause` remain safe;
- `/done` asks whether to complete the session with the exchange unfinished,
  defaulting to no.

If the human confirms `/done`, Agent Bridge atomically:

1. records `latestPairedExchange.outcome = 'abandoned'` with every response
   sequence already present, whose final recorded sequence equals the final
   saved message at this transition;
2. clears `pendingExchange`;
3. advances `nextFirstAgent` to the abandoned exchange's `secondAgent`, so a
   later reopening does not let the original first agent lead twice;
4. marks the session completed.

The prompt names the missing stage: peer response or reciprocal confirmation.
Declining it leaves the checkpoint unchanged. This escape remains available
after authentication errors, rate limits, invalid responses, or exhausted
retries, so recovery rigor never traps the human in a permanently
uncompletable chat.

Ctrl+C cancellation leaves the current saved pending stage intact. Repeated
cancellation never drops or rewrites the already checkpointed responses.

An authentication error, rate limit, invalid final response, timeout, or other
provider failure after retries also leaves the saved stage intact and stops the
current automatic operation. When the terminal and chat store remain usable,
the error is reported and control returns to the human prompt instead of
unwinding into an automatic resume-fail loop. The human can retry by starting
work that first settles the pending exchange, `/pause`, or use the
human-confirmed `/done` abandonment path. Storage,
validation-of-persisted-state, and fatal terminal failures remain fatal because
continuing could weaken checkpoint integrity.

## Automatic conversation

One `/auto` round means one logical paired exchange, including its conditional
confirmation.

The worst-case provider-call preview is:

| Starting state          | Maximum calls for `N` exchanges |
| ----------------------- | ------------------------------: |
| no pending exchange     |                            `3N` |
| `awaiting-peer`         |                        `3N - 1` |
| `awaiting-confirmation` |                        `3N - 2` |

These are honest upper bounds. Most open exchanges still use two calls.

`/auto` stops early only on `confirmed`. Two provisional `done` decisions do
not stop it before confirmation. If confirmation returns `continue`, that
round is open and automation may begin the next exchange within the existing
exchange cap.

Cancellation or an exhausted provider failure at any provider stage
immediately breaks the `/auto` loop and leaves the corresponding pending
checkpoint for explicit retry, pause, or human-confirmed abandonment. It never
consumes additional rounds afterward.

If the latest current exchange is already confirmed, `/auto` keeps the Phase 1
behavior of warning that proceeding deliberately opens another exchange and
requires confirmation from the human.

A legacy version 3 pair with two `done` decisions is not a stop condition. The
preview identifies it as unconfirmed and explains that starting `/auto` opens
a version 4 exchange that can reach reciprocal confirmation.

Confirmation adds a third persisted message to converging exchanges. The
existing bounded valid-JSON history algorithm remains authoritative, and the
confirmation prompt receives the exact first and peer responses separately
even if older history is omitted. Confirmation prompts request concise
acceptance rationale to reduce memory and provider cost, but no correctness
claim depends on that request being followed.

## Presentation contract

The renderer-neutral model gains these current paired-exchange states:

- `none`
- `pending-peer`
- `pending-confirmation`
- `open`
- `both-done` for unconfirmed version 3 history only
- `confirmed`
- `abandoned`

Required user-facing language:

- `pending-peer`: "waiting for peer response"
- `pending-confirmation`: "waiting for reciprocal confirmation"
- `open`: "open; another exchange may help"
- `both-done`: "both agents marked the legacy pair done; not reciprocally confirmed"
- `confirmed`: "both agents reciprocally marked this exchange done"
- `abandoned`: "exchange left unfinished when the session was completed"

Plain and enhanced rendering, `/status`, `/auto` previews, screen-reader
announcements, completion messages, and documentation must use the same
meaning. No surface may shorten `confirmed` to "verified" or imply that it
authorizes edits.

During the third call, live activity identifies the original first agent and
the phase as confirmation. Streamed text remains supplemental; only the
validated final response and saved transition drive state.

## Version 3 migration

Migration from version 3 to version 4 is conservative:

1. Validate version-specific legacy fields before transforming them.
2. Change `version` to 4.
3. When a version 3 pending record references the final saved message:
   - for an active or paused session, convert it to
     `stage = 'awaiting-peer'` without changing its agents or sequence;
   - for a completed session, migrate it to
     `latestPairedExchange.outcome = 'abandoned'`, retain its first-response
     sequence, and clear `pendingExchange`.
4. Version 3 validation did not require the pending first response to be the
   final message. If later messages exist, the record was valid version 3 data
   but its recovery provenance is ambiguous under version 4. Drop only the
   pending record, preserve every message and the session status, leave
   `latestPairedExchange` absent, and keep the session loadable. Do not guess
   an exchange outcome or silently discard message history. Emit a bounded
   warning through the store's existing warning channel:
   "An unfinished exchange from an older version was discarded; send a
   message to start a new one."
5. Do not otherwise synthesize `latestPairedExchange` from old messages.
   Version 3 did not record confirmation provenance, so old `done` pairs
   cannot become reciprocally confirmed retroactively.
6. Presentation uses the existing adjacent-pair derivation as a legacy
   fallback only when `pendingExchange` and `latestPairedExchange` are both
   absent. It must label two old `done` decisions as unconfirmed.
7. Existing version 1 and 2 migrations continue through version 3 and then
   version 4.

Migration must be idempotent in behavior: after a migrated session is saved as
version 4, loading it again produces the same validated state.

## Deterministic acceptance tests

### State and migration

- Valid version 3 sessions migrate to version 4.
- Every valid active or paused version 3 pending exchange becomes
  `awaiting-peer`.
- A completed version 3 session with a final pending first response migrates
  to an abandoned exchange with no pending state.
- A valid legacy pending record that does not reference the final message is
  dropped without losing messages, synthesizing provenance, or making the
  session unloadable.
- Dropping ambiguous legacy pending metadata emits the migration warning once
  per load operation while the recovered session remains available to direct
  load, listing, and `latest` selection.
- Old two-message `done` pairs are never marked `confirmed`.
- Invalid agents, stages, sequence references, roles, adjacency, decisions,
  and outcomes are rejected.
- A completed session carrying `pendingExchange` is rejected.
- Abandoned peer and confirmation stages validate only with their permitted
  message sequences.
- A completed abandoned session can be reopened as active and saved without
  changing or losing the historical abandoned record.
- New messages and exchanges may follow an abandoned record after reopening;
  their sequence references must remain strictly later.
- Version 1 and 2 fixtures still migrate successfully through version 4.
- JSON Schema wiring and runtime semantic fixtures are tested at their
  respective boundaries.

### Exchange behavior

- An open two-response pair makes exactly two provider calls.
- Two provisional `done` decisions make exactly one confirmation call.
- A `done` confirmation produces `confirmed`.
- A `continue` confirmation produces `open`.
- Confirmation receives the exact checkpointed first and peer responses.
- The next first agent alternates only after the logical exchange settles.
- Targeted turns remain single-call and do not affect paired-exchange state.

### Recovery

- Cancelling the first call records no response and no pending state.
- Cancelling the peer call resumes only the peer.
- Cancelling confirmation resumes only confirmation.
- An exhausted provider failure while settling pending work reports the error
  and returns control to the prompt with the checkpoint unchanged.
- Resuming either pending stage does not duplicate saved messages.
- Startup `--task` input and queued terminal lines cannot enter a pending
  exchange.
- Linked workflows cannot launch before pending work settles.
- `/pause` preserves either pending stage.
- `/done` defaults to preserving pending work when confirmation is declined.
- Confirmed `/done` atomically records abandonment, clears pending work, and
  completes the session for either pending stage.

### Automation and presentation

- `/auto` call previews match `3N`, `3N - 1`, and `3N - 2`.
- `/auto` stops only after a saved confirmed exchange.
- A `continue` confirmation consumes one exchange and permits the next round.
- Cancellation stops `/auto` immediately at every provider stage.
- Exhausted provider failures stop `/auto` immediately without discarding the
  pending checkpoint.
- A legacy both-done pair is identified as unconfirmed and does not stop a new
  `/auto` run.
- Existing exchange caps remain enforced.
- Repeated long and short confirmation messages preserve valid JSON and the
  existing history-size bound.
- Plain and enhanced renderers expose identical semantic states.
- No UI or transcript text calls reciprocal confirmation independent
  verification or editing approval.

### Required project checks

After implementation:

```text
npm run check
npm run test:coverage
npm pack --dry-run
git diff --check
```

Tests must use fake providers, temporary chat stores, and injected terminals.
They must not require provider authentication, network access, or a global
Agent Bridge installation.

## Proposed implementation slices

0. **Phase 1 prerequisite cleanup**: before any linked `/review`, `/edit`, or
   implementation workflow can run, settle `pendingExchange` using the same
   gate as ordinary and pasted messages. If settlement is cancelled or fails,
   do not inspect, confirm, or launch the workflow and do not append its system
   completion message. Add a deterministic regression test. This stops current
   version 3 code from creating new non-final pending references while Phase 2
   is being implemented.

1. **Persisted model**: version 4 types, validator, schema, migration, fixtures,
   pure state helpers, and the bounded migration warning. No provider calls
   change in this slice.
2. **Coordinator**: conditional confirmation prompt and the three-stage
   checkpointed exchange flow, including resume and command gating.
3. **Automation and presentation**: `/auto` accounting, renderer-neutral
   states, plain/enhanced wording, status, transcript, and documentation.
4. **Hardening**: cancellation matrices, save-failure behavior, full checks,
   and package inspection.

Each slice must keep the repository passing before the next begins. Provider
flags remain outside orchestration, and no write-capable workflow behavior
changes.

User-facing documentation in slice 3 must state that an ordinary message uses
two provider calls when the exchange remains open and three when two
provisional `done` decisions trigger confirmation. `/auto` continues to show
its worst-case call count before starting.

## Second-review questions

Claude's second state-machine review should answer these questions before
implementation:

1. Does every provider response now enter one atomic checkpoint with its full
   exchange-state transition, leaving no validator-invalid crash window?
2. Does human-confirmed abandonment cover both pending stages, survive
   completed-chat reopening, and prevent completed sessions from retaining
   `pendingExchange`?
3. Does migration recover valid Phase 1 completed-plus-pending and ambiguous
   non-final pending records without inventing provenance or hiding chats?
4. Can an exhausted provider failure always return to a usable prompt when
   checkpoint and terminal integrity remain intact?
5. Is the residual asymmetry of arbitrary text in a `done` confirmation named
   and bounded honestly enough?
6. Are `/auto` cancellation, legacy fallback, sequence ordering, history
   pressure, and user-facing call cost now specified completely?
