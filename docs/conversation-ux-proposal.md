# Proposal: conversation UX and a local browser interface

Status: Suggestions for review; not an approved implementation specification.

Date: 2026-10-31

## Recommended direction

Offer a local browser window as an opt-in companion to `agent-bridge chat`.
Aim for the simplest conversation experience possible, modeled on the
ChatGPT/Codex and Claude desktop apps: one conversation column, one composer,
Send and Stop, with other controls revealed when needed. Whether this becomes
the default entry point is a later product decision.

The chat process owns execution, permissions, persistence, locks, and workflow
decisions. The browser is another renderer and input source. The CLI,
screen-reader mode, and scriptability remain complete.

Help users follow what Codex proposed, what Claude challenged, what changed,
and what evidence supports the result. A dedicated terminal conversation UI
would require substantial navigation, Markdown, and input work. Explore the
browser direction first, with diffs and evidence available on demand.

The browser interface described here does not exist yet. Browser and desktop
interfaces are explicitly outside the scope of the existing
[Phase 3 terminal specification](phase-3-interactive-terminal.md); this would
need its own scope and specification. No release number is proposed here.

## What already exists

- Persistent chat, bounded history, resumable turns, targeted and paired
  exchanges, transcripts, checkpoints, public streaming, and safe activity.
- Enhanced terminal and accessible plain interfaces, shared preflight, isolated
  editing, structured agreement, and apply/keep/discard completion choices.

## Findings from the current implementation

| Observation                                                                                               | Effect on the user                                                                          | Suggested improvement                                                                             |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Workflow responses use short summaries; complete final responses require verbose mode.                    | Reading the conversation is coupled to diagnostic output, and useful details can be missed. | Separate conversation detail from diagnostics, with Highlights and Full conversation views.       |
| The enhanced terminal prioritizes the newest streaming text and has no dedicated conversation navigation. | A long live response displaces the preceding message that explains what it is answering.    | Allow browsing earlier messages, with an explicit Follow live action and a new-message indicator. |
| Linked workflows return an exit code without a structured link to the completed run and its artifacts.    | Returning to chat loses much of the context needed to discuss the result.                   | Bring a structured workflow result back into the conversation.                                    |
| Messages identify their speaker but have limited visible relationship metadata.                           | Users must reconstruct which proposal a critique addresses and which revision was reviewed. | Show roles, exchange or cycle, reply targets, and revision references where applicable.           |
| Bounded history can omit earlier messages from provider prompts.                                          | The saved conversation can appear to be the same as the context an agent actually received. | Offer an inspectable context receipt for each call.                                               |
| The wide terminal layout reserves roughly one third of its body for activity.                             | Sparse status information competes with the conversation for space.                         | Prefer a compact status strip and reveal detailed activity on demand.                             |

Relevant implementation references:
[workflow output](../src/orchestrator.ts), [terminal layout](../src/enhanced-terminal.ts),
[presentation model](../src/presentation-model.ts), [chat handoff](../src/chat.ts),
[chat records](../src/chat-state.ts), [bounded context](../src/prompts.ts), and
[safe provider events](../src/provider-events.ts).

## Proposed browser experience

### Entry and project selection

A collapsible left sidebar contains New chat, saved chat sessions grouped by
date, and run history. Load sessions through the existing chat store in the
application-data chats directory, and run history through run-management
boundaries.

New chat asks for a project, using the wizard's recent-project list, and an
intent: Discuss, Make changes, or Review. Allow selecting another project
without inferring it from the installation directory. The header shows the
project name, current mode, and scope: read-only or isolated editing.

History can be browsed read-only during work. New chat and session activation
follow the idle-only switching model in Architecture below.

### Simple layout

```text
+--------------------+--------------------------------------------------+
| New chat           | example-project · Discuss · Read-only            |
|                    +--------------------------------------------------+
| Today              | You                                              |
|   Retry behavior   | How should cancellation work?                    |
| Yesterday          |                                                  |
|   Review changes   | Codex                                            |
|                    | Response with Markdown and copyable code         |
| Run history        |                                                  |
|   Review run       | Claude · replying to Codex                       |
|                    | Review response                                  |
|                    | [Workflow result, when relevant]                 |
|                    +--------------------------------------------------+
|                    | [Discuss] [Make changes] [Review]                |
|                    | [Both v] Write a message...         [Send/Stop]  |
+--------------------+--------------------------------------------------+
```

On narrow windows the sidebar collapses. Evidence, advanced settings, and
workflow controls expand from the relevant message or result card.

### Conversation as the main area

Use one chronological timeline. Messages show:

- User, Codex, or Claude identity and the agent's current role.
- Exchange or cycle, with a replying-to link where relevant.
- Live preview, saved response, interrupted, or failed status.
- Reviewed revision when the message belongs to an editing review.
- Live text while writing, rendered Markdown, and code blocks with copy buttons.

Full messages should be easy to read by default. Highlights, search, and
exchange navigation can be secondary controls. Reading older content suspends
automatic following without stopping the agents. A new-message count and
Follow live action bring the user back to the active turn.

Public messages and bridge-managed handoffs are the conversation being exposed.
Provider-native sessions remain ephemeral. Provider reasoning, thinking events,
and raw tool payloads remain excluded.

### Status and evidence alongside the conversation

Keep a compact summary of the active agent, role, model, phase, elapsed time,
scope, and next step, with secondary metadata on demand. Show token usage only
when available; do not present a guessed subscription charge as a cost.

Reveal code changes and coordinator-run checks without losing the conversation
position. Link evidence to its captured revision; expose artifacts and paths
through bounded coordinator capabilities, never raw provider events.

Keep these states visibly separate:

- Live text is an informational preview.
- A saved response passed the response contract and was checkpointed.
- Conversational confirmation concerns the exact saved exchange.
- Implementation agreement concerns the same captured cycle and revision.
- Passing checks describe the actual verification commands that ran.
- Applying changes is a separate completion action.

### Human input and control

Provide a stable multiline composer with a Both / Codex / Claude target
selector. Typing `@codex` or `@claude` has the same targeting behavior. Show
Discuss, Make changes, and Review intent buttons. Slash commands still work,
but users never need to memorize them to complete these flows.

The Stop button maps to today's Ctrl+C behavior during active provider work:
cancel that operation, preserve the saved checkpoint, and return to the chat.
It does not mean complete or delete the session. Child-workflow cancellation
must use its existing process-tree cancellation and recovery behavior.

Let users reply to a message without copying it manually. Unsaved drafts stay
editable; submitted input is visibly queued until the next prompt, never
inserted between agents in a paired exchange or into an active write call.
Queue text belongs to the local input view; the shared model exposes only a count.

`/pause` already saves a resumable session and leaves while idle. A future
"pause after this exchange" control needs a different name or defined
relationship to `/pause`; it is outside the initial Send and Stop experience.

Confirmations appear as cards with buttons, using the same preflight,
explanations, choices, and defaults as terminal prompts. Editing still starts
through the established workflow. End of input or a browser disconnect is
never consent; unrecognized answers are asked again.

Mid-exchange interjection is out of scope. Inserting a human note between the
first and second agent would change exchange history and reciprocal
confirmation rules, so it can only be a separate future decision.

### Workflow return and completion

Show a workflow result card with isolated or applied status, files changed,
checks and their results, and View diff. Expand for run id, status, captured
revision, workspace, patch, and completion outcome. The next conversation must
know whether it is inspecting an isolated result or the source checkout.

Apply / Keep / Discard buttons answer the existing completion flow, preserving
its base-revision and patch checks. They are not independent browser-side Git
operations. Their availability follows the current completion state; a saved
result card must not replay a previously authorized completion action.

The card depends on structured child results and completion-question transport
(Phase 0 items 2–3); the current exit-code-only return is insufficient.

## Architecture: attach to the chat process

`agent-bridge chat` hosts a local HTTP server using Node's built-in `http`
module. It serves packaged static files, streams safe updates through
server-sent events, and accepts input through authenticated POST requests. This
adds no server runtime dependency and no separate background service.

One chat process holds one session lock and runs one coordinator at a time.
New chat or switching sessions is allowed only when no provider or workflow
work is active. Pause the current session by default, or complete it only on an
explicit user request; save its checkpoint and release its lock before
acquiring the next session's lock. Preserve pending exchange state. If the next
lock is unavailable, show a recoverable selection error. Never run two
coordinators, discard queued input silently, or switch halfway through a call.

There are useful existing seams:

- **Input:** [`ChatTerminal`](../src/chat-input.ts) provides prompt, write,
  pause, resume, queue observation, and lifecycle operations. Adapt browser
  input to the shared command parser and queue, adding structured questions.
- **Display:** [`TerminalRenderer`](../src/presentation.ts),
  [`TerminalViewModel` and `PresentationModelEvent`](../src/presentation-model.ts)
  separate presentation from decisions. Add a web adapter or shared event sink
  for safe JSON snapshots and events; current renderer methods return terminal
  strings, not JSON transport.

On connection or refresh, send a current snapshot and then ordered updates.
Define event identifiers and snapshot resynchronization so reconnecting does
not duplicate saved messages or invent lost live text. Live previews remain
informational and need not all be persisted. Scope requests and subscriptions
to session identifiers so stale tabs cannot send commands into the next chat.

Closing the browser never cancels work. The terminal process stays in charge;
exiting that process follows its existing shutdown and checkpoint behavior.
Allow one controlling browser tab and make additional tabs read-only initially.
Terminal input remains available through the same queue. Question identifiers
ensure that the first valid answer consumes a confirmation once; stale or
duplicate answers cannot start another workflow.

Keep the existing safety model: one writer, read-only reviewers and judge,
ordinary read-only chat, isolated editing defaults, no automatic write retries,
and agreement based only on validated decisions for the same captured cycle
and revision. Preserve verification trust, checkpointed resume settings,
protected-path checks, recovery, and artifact checks; never automatically stage
or commit. Browser and terminal actions share commands and validation. Version
new persisted fields with types, validators, schemas, and migrations.

The first window can use Edge or Chrome `--app=<local-url>` when available for
an app-like window without a browser toolbar. Provide a normal browser URL as
a fallback. Launchers still use argument arrays and `shell: false`. Electron
or Tauri packaging is a later optional step, not a prerequisite.

## Phase 0: interface-independent fixes

These proposed fixes improve the terminal too. Item 1 and the web renderer
adapter unblock the read-only window; items 2–3 gate stage 3 workflow controls.
The read-only window can proceed alongside the remaining Phase 0 work.

1. **Show complete responses without `--verbose`.**
   [`orchestrator.ts`](../src/orchestrator.ts) gates full responses on
   `reporter.verbose`; [`providers.ts`](../src/providers.ts) also uses it for
   provider stderr. Separate conversation visibility from diagnostics, label
   concurrent output by speaker, and avoid duplicate live/final responses.
2. **Return structured linked-workflow results and progress.**
   [`launchBridgeWorkflow`](../src/chat-workflow.ts) inherits terminal stdio and
   returns an exit code; [`ChatWorkflowEvent`](../src/chat-state.ts) stores only
   sequence, timestamps, mode, optional first agent, and exit code.
   Add a versioned, validated result record and bounded progress events: run id,
   status, captured revision, workspace or patch, files changed, verification,
   and completion outcome. Publish durable records through `filesystem.ts`.
   Relay child completion questions and answers while the child retains
   authority; do not parse terminal output or forward raw provider events.
3. **Represent confirmations as structured questions.**
   Give [`chat.ts`](../src/chat.ts) confirmations id, text, default, and choices:
   y/n in the terminal, buttons in the browser. Preserve unfinished-work, auto,
   dirty-source, verification-trust, and launch semantics, including invalid
   answers and end of input. Apply the same model to child completion questions.
4. **Show a minimal context receipt.**
   Expose the omitted-messages record and truncation information that
   [`prompts.ts`](../src/prompts.ts) already sends to providers. Begin with
   retained and omitted message counts rather than a new summarization call.
5. **Update one-shot transcripts as the run progresses.**
   [`cli.ts`](../src/cli.ts) writes derived transcripts after orchestration.
   Project saved turns atomically during the run; checkpoints stay authoritative.
   Preserve `--no-transcript`, privacy, and bounds without an extra live log.

## Architectural cost

The main cost is separating [`chat.ts`](../src/chat.ts) from readline-dependent
input and presentation, replacing one-shot console output with events, and
relaying child confirmations. These boundary changes go beyond
[Phase 3](phase-3-interactive-terminal.md), which excluded "redesign the one-shot
workflow engine"; retain its state machine and safety decisions.

Attaching to chat avoids a new daemon lifecycle, independent job owner, and
service-to-CLI lock handoff. Structured commands, ordered updates, reconnects,
and child transport still need implementation.

## Front-end technology

Keep the choice open, with React + Vite + TypeScript recommended initially.
Compile a TypeScript SPA into static files at package time using
[Vite's production build](https://vite.dev/guide/build). Bundle browser runtime
code and keep build tools as development dependencies; the installed package
can retain `cross-spawn` as its single npm runtime dependency. Users need no
development server, but the front end still has bundled dependencies.

Share presentation-model types through type-only imports, exclude Node-specific
modules from browser bundles, and validate JSON at the transport boundary.
These fit assessments are project recommendations, not performance rankings:

| Option                                                           | Strengths                                                                                               | Tradeoff for this interface                                                                                                                                                | Suggested fit                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| React + Vite + TypeScript                                        | Component model with many choices for accessible controls, Markdown, code highlighting, and diff views. | Introduces front-end build tooling and requires choosing and validating those components.                                                                                  | Recommended starting point for delivering a polished interface. |
| [Preact](https://preactjs.com/guide/v10/differences-to-react/)   | A smaller implementation with a similar model and a React compatibility layer.                          | Test compatibility with the specific accessibility and diff libraries selected.                                                                                            | Strong alternative if minimizing browser code is a priority.    |
| [Svelte](https://svelte.dev/docs/svelte/overview)                | Compiled components with concise state and template syntax.                                             | A different authoring model; validate required components before committing.                                                                                               | Reasonable if maintainers prefer it.                            |
| [SolidJS](https://docs.solidjs.com/concepts/intro-to-reactivity) | Fine-grained reactivity can suit frequent live-text updates.                                            | A different reactivity model and component choices to evaluate.                                                                                                            | Reasonable with relevant maintainer experience.                 |
| [HTMX](https://htmx.org/docs/) with server-rendered fragments    | Keeps rendering close to the server and simplifies request-driven updates.                              | This UI holds substantial client state: live text, drafts, queue display, expanded cards, and scroll position. Preserving that across fragment swaps adds custom behavior. | Poor default for this interaction model, although feasible.     |
| Plain TypeScript or web components                               | Direct browser APIs and little framework machinery.                                                     | More manual work for state synchronization, lists, focus, and accessible interactions as the UI grows.                                                                     | Suitable for a very small viewer.                               |

Next.js, including static export, remains possible if framework familiarity
justifies it; the proposed HTTP host needs no additional server framework or
server rendering. Keep coordinator authority independent of this choice.

An Ink-style full-screen alternative could improve terminal conversations but
retains terminal layout, input, and scrolling conventions. It is a separate
direction from the desktop-app window goal, not a prerequisite.

## Security analysis

A local endpoint that can start writers is a new control surface reachable by
unrelated websites. Before enabling input, update [security.md](security.md)
with its threat model and implemented protections.

Listen only on loopback. A launch URL passed to `--app=` exposes its token in
the browser command line, potentially visible to other local users. Use a
short-lived, single-use random bootstrap token: on first load, atomically
exchange it for an authenticated, host-only session cookie with `HttpOnly` and
`SameSite=Strict`, then reject further use of that URL token. Remove the token
from the visible URL and exclude it from logs, referrers, provider prompts, and
rendered content. Reopening uses the cookie or a fresh bootstrap token.
Single use limits replay after redemption; it does not eliminate an initial
redemption race with a local observer. See the
[cookie attributes](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).

Validate Host headers against the bound local addresses to resist DNS rebinding.
Check origins and apply CSRF protection to every state-changing request,
including input, Stop, confirmations, session switching, and completion.
Cookie settings supplement these checks, session locks, and coordinator
permissions; they do not replace them.

Repository-influenced agent messages are untrusted. Disable raw Markdown HTML,
restrict link schemes, and sanitize generated HTML, for example with
[DOMPurify](https://github.com/cure53/DOMPurify). Rendered content and links must
never trigger privileged actions. Terminal sanitization does not secure HTML.

Serve only bounded coordinator data and explicitly authorized artifacts.
Provide no arbitrary filesystem-read or command-execution endpoint. Historical
sessions can contain sensitive local data, so read access needs authentication
too. All remote content and output remain untrusted.

The read-only stage cannot start agents, answer questions, or apply changes;
it still needs authentication, safe rendering, and bounded access. Enable
actions only after testing authorization and duplicate-request handling.

## Testing approach

Follow [AGENTS.md](../AGENTS.md): deterministic tests with temporary projects,
temporary application-data directories, fake providers, and no external network
access, global authentication, or real provider calls.

- **Component tests:** consider Vitest with jsdom or happy-dom, which are
  supported [test environments](https://vitest.dev/guide/environment.html).
  Test streaming updates, drafts, queue ordering, target selection, copy
  controls, confirmation cards, and preservation of expansion and scroll state.
  Mock clipboard access and clocks rather than requiring a desktop session.
- **Server tests:** use an in-process loopback server on a temporary port with
  fake providers. Test atomic token redemption, cookie attributes, Host and
  origin checks, CSRF, read-only secondary tabs, stale answers, duplicate POSTs,
  ordered SSE updates, reconnection, and bounded artifact access. Loopback is
  local test infrastructure, not external network access.
- **Shared behavior tests:** cover matching terminal and browser confirmation
  semantics, pending-peer and confirmation recovery, child result validation,
  completion failures, atomic partial transcripts, and idle-only switching:
  save and release the old lock before acquiring the next, including when
  acquisition fails. Disconnects must not cancel work or confer consent.
- **Optional browser end-to-end suite:** keep real-browser tests separate from
  the deterministic default suite, as `npm run test:pty` is today. Exercise
  keyboard navigation, responsive layout, focus, live following, and the full
  discussion and make-changes flows with fake providers.

Implementations must also pass `npm run check`, `npm run test:pty`,
`npm run test:coverage`, and `npm pack --dry-run`. This document adds no test
dependencies or scripts.

## Creative features to explore

### Unresolved-points inbox

Collect objections such as "cancellation still needs a test" and link each to
the messages that raised and addressed it. Let users navigate by outstanding
work rather than reading every response from the beginning.

Initially, treat these as attributed navigation summaries. Do not let an
inferred resolved label change workflow agreement. Reliable machine-readable
issue tracking may eventually need a versioned response contract.

### What changed after review?

Summarize a cycle as proposal, objection, change, and supporting evidence:

> Codex added a retry limit. Claude requested cancellation coverage. The next
> implementation added the missing test, and the configured check passed.

This is illustrative content, not a claim about a completed project run. Real
summaries should link to saved source messages and actual check results.

### Context receipt

Let users inspect what a call received: retained conversation messages,
omissions, task instructions, and supplied evidence. Clearly distinguish saved
history from the subset sent to a provider. Pinning constraints for future
calls is a separate idea that needs explicit context-budget and privacy rules.

### Decision trail

Provide an optional topic view of accepted proposals, challenges, missing
evidence, and resolutions. Every item should lead back to the chronological
conversation. Topic summaries help users understand the discussion without
becoming a second source of workflow authority.

### Conversation replay

Allow browsing saved exchanges or cycles in order, including roles, decisions,
and reviewed revisions. Start with checkpointed responses. A historical replay
of every activity event would require a separate retention decision; it should
not imply that current checkpoints contain a complete stream recording.

## Suggested delivery sequence

0. **Phase 0 fixes.** Work through the shared improvements above. Item 1 and the
   web renderer adapter are the feature prerequisites for stage 1; the other
   items can continue in parallel with it.
1. **Read-only window.** Add the sidebar, live timeline, Markdown, and copy
   buttons with authentication, safe rendering, read-only secondary tabs, and
   snapshot resynchronization. Browse history read-only; active session changes
   still use the terminal. Do not wait for Phase 0 items 2–3.
2. **Composer, targeting, and Stop.** Add messages, mentions, queuing, and
   cancellation through shared commands. Enable New chat and saved-session
   activation only while idle, using the save/release/acquire sequence in
   Architecture. Commands needing browser confirmations remain terminal-only
   until stage 3.
3. **Make changes and Review.** Phase 0 items 2–3 gate confirmation cards,
   structured child progress and completion questions, result cards, diffs,
   and Apply / Keep / Discard. Keep completion authority in the existing flow.
4. **Optional desktop packaging.** Evaluate Electron or Tauri for installers or
   deeper integration, preserving the chat process's lifecycle and ownership.

Validate the simple layout with users throughout. Creative features are
follow-on explorations after source links and revision provenance are reliable;
they should not delay the basic conversation experience. Whether the browser
becomes the default remains a later decision informed by those evaluations.

## Remaining specification questions

1. Which opt-in flag and platform browser-discovery rules should be used?
2. What are the precise transport schemas, stable identifiers, migrations,
   resynchronization rules, and child interruption behavior?
3. How does a new tab regain control after the controlling tab closes? How are
   bootstrap tokens renewed and cookie authorization expired or revoked?
4. Before an idle-only switch, how should queued input and unsent drafts be
   presented? What survives reload, `--no-transcript`, and interruption?
5. Which front-end components should be selected, which creative summaries need
   provider calls or new response fields, and what user evidence would justify
   making the browser the default later?

## Suggested evaluation tasks

Ask first-time users to complete these tasks without reading documentation:

- Start a discussion by selecting a recent project, send a message to both
  agents, then address one agent and find its reply.
- Start Make changes, answer preflight cards, inspect the isolated result,
  checks, and diff, then apply. Explain whether the source checkout changed.
- Find who is acting, whether it can edit, the latest objection, the reviewed
  revision, and the checks that actually ran without reading the whole history.
- Read an earlier response during streaming, return to live output, and submit
  a follow-up that visibly waits until the paired exchange finishes.
- Use Stop and resume the saved stage without repeating a writer.
- Close and reopen the window, open a second read-only tab, and verify that work
  continues and no confirmation is accidentally accepted.
- Browse history during work, verify switching is unavailable, then switch
  while idle and confirm the old checkpoint was saved before the next session
  lock was acquired. Check a locked destination produces a recoverable error.

Repeat the relevant flows with keyboard-only and screen-reader navigation,
including the complete terminal interface. Record confusion about targeting,
queuing, confirmation defaults, scope, and completion outcomes before expanding
the UI with creative features.
