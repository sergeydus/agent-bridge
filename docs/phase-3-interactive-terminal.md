# Phase 3 specification: enhanced interactive terminal

Status: In progress — Slices 1 and 2 implemented

Target release: 0.6.0

Scope owner: Agent Bridge presentation and interactive-chat layers

## Summary

Phase 3 adds an optional enhanced terminal interface for Agent Bridge. It gives
users a stable view of the conversation, current agent activity, workflow
status, and available controls while preserving the existing plain,
append-only interface as a complete and accessible experience.

This phase is a presentation and interaction project. It does not create a new
orchestrator, provider session, permission model, agreement rule, or editing
path. Both interfaces consume the same application state and invoke the same
commands.

## Why this phase exists

Agent Bridge now supports durable chat, targeted agents, editing handoffs, and
safe provider streaming. The remaining usability problem is that these
capabilities are spread through an append-only terminal transcript. A new user
can lose track of:

- which agent is active;
- whether the agent is discussing, implementing, or reviewing;
- which model is in use;
- whether the latest exchange reached agreement;
- whether an editing workflow is operating in isolation;
- which controls are currently safe and available.

The enhanced interface should make those facts continuously visible without
making Agent Bridge less scriptable, less accessible, or less reliable.

## Goals

1. Make active work understandable at a glance.
2. Make common commands discoverable without requiring users to memorize them.
3. Preserve the conversational feel of the Codex and Claude terminals.
4. Keep keyboard-only operation complete and efficient.
5. Provide a first-class screen-reader and plain-terminal experience.
6. Restore the terminal correctly after normal exit, cancellation, failure,
   suspension, or an unexpected rendering error.
7. Keep all workflow authority in the existing state machines and validated
   provider responses.
8. Preserve Agent Bridge's zero-production-dependency distribution.

## Non-goals

Phase 3 does not:

- change which agent may edit;
- allow simultaneous writers;
- retry a write call automatically;
- infer agreement from streamed text;
- expose provider reasoning, raw commands, tool inputs, or file paths;
- add mouse-only actions;
- replace provider-native Codex or Claude sessions;
- add a browser or desktop GUI;
- add remote collaboration or cloud synchronization;
- persist a second copy of live provider output;
- redesign the one-shot workflow engine.

## Product principles

### One application, two renderers

The enhanced and plain interfaces are views over the same application state.
They must not contain separate command handlers or workflow decisions.

### Plain mode is a complete product

Plain mode is not an error fallback with reduced functionality. Every action
available in the enhanced interface must have a command or prompt equivalent
in plain mode.

### Accessibility is explicit and durable

`--screen-reader` always selects semantic, append-only output. That preference
is restored with a saved chat and forwarded to child workflows. The enhanced
renderer must never override it based on terminal detection.

### Final responses remain authoritative

Live text and activity are informational previews. Only schema-validated final
responses may be checkpointed as agent decisions or used for convergence.

### Safety before convenience

The interface may expose existing safe actions more clearly, but it must not
skip confirmations, broaden write access, weaken isolation, or create a
generic retry action for uncertain write turns.

## User-facing modes

Add a presentation option:

```text
--ui plain|enhanced|auto
```

Behavior:

- `plain` uses the existing append-only presentation.
- `enhanced` requests the Phase 3 interface and fails back to plain mode with a
  short explanation if the terminal cannot support it.
- `auto` selects enhanced mode only when capability checks pass.
- `--screen-reader` always takes precedence and selects plain mode.
- redirected stdin or stdout selects plain mode.
- `TERM=dumb` selects plain mode.
- `--no-color` and `NO_COLOR` remove color but do not otherwise disable the
  enhanced layout.

The CLI default is `auto`: capable interactive terminals use enhanced mode and
all unsupported, redirected, or accessible contexts retain the complete plain
interface. Explicit, saved, and resumed presentation preferences take
precedence over this release default.

Presentation preference precedence, from strongest to weakest:

1. explicit command-line flags;
2. resumed chat settings;
3. saved user preference;
4. release default.

When `--screen-reader` is combined with `--ui enhanced`, screen-reader safety
wins and the CLI explains that it selected plain mode.

## Enhanced interface

### Layout

The default layout contains four semantic regions:

```text
┌ Agent Bridge · project · session status ──────────────────────┐
│ Conversation                                                   │
│ Codex and Claude messages, human messages, final decisions     │
│                                                                │
├ Activity / workflow status ────────────────────────────────────┤
│ Active agent · model · role · phase · elapsed time · safety    │
├────────────────────────────────────────────────────────────────┤
│ Input                                                          │
│ command hints                                                  │
└────────────────────────────────────────────────────────────────┘
```

The exact border characters are decorative. Text labels carry all meaning.

The header shows:

- `Agent Bridge`;
- target project basename, not its full path;
- chat or run identifier in a shortened display form;
- session state such as `Ready`, `Codex responding`, `Reviewing`, `Paused`, or
  `Needs attention`.

The conversation region shows:

- human messages;
- speaker-labeled provider responses;
- safe live response previews;
- structured decisions;
- workflow handoff and completion summaries.

The activity region shows:

- active agent and model;
- current role and workflow phase;
- elapsed time;
- the most recent allowlisted activity;
- agreement progress;
- isolation or read-only status when relevant.

The input region shows:

- the editable input;
- completion candidates or contextual help;
- the primary cancellation or exit hint when work is active.

### Responsive layouts

The renderer must calculate width using printable terminal columns rather than
JavaScript string length.

- At 100 columns or wider, conversation and activity may use separate columns.
- From 60 to 99 columns, regions stack vertically.
- Below 60 columns, borders and secondary metadata are removed.
- No supported width may require horizontal scrolling.
- Long unbroken text is safely clipped or wrapped without corrupting ANSI
  state.
- A resize redraws from the in-memory view model and does not call a provider
  or mutate a checkpoint.

Exact breakpoints may be adjusted during implementation if deterministic tests
show a clearer result, but all three layout classes are required.

### Conversation behavior

- Completed messages remain scrollable within the current process.
- Agent identity is always written as text; color is supplemental.
- A live preview is visibly labeled `Live` and becomes `Final` only after the
  structured response is accepted.
- The final response must not be visually mistaken for agreement.
- A decision badge always includes text: `continue` or `done`.
- Concurrent provider output is never interleaved inside one visual message.
- Streaming redraws are bounded and activity animation uses presentation-only
  ticks, so neither provider events nor semantic heartbeats flood the terminal.
- Reopening a session reconstructs completed conversation from the existing
  checkpoint. Ephemeral activity and partial live text are not restored.

### Keyboard interaction

All functionality must be reachable without a mouse.

Required controls:

| Action                    | Enhanced interface                              | Plain equivalent    |
| ------------------------- | ----------------------------------------------- | ------------------- |
| Send message              | Enter                                           | Enter               |
| Enter multiline input     | `/paste`; Alt+Enter may be added where reliable | `/paste`            |
| Complete command or agent | Tab                                             | Tab                 |
| Previous/next local input | Up/Down                                         | Up/Down             |
| Scroll conversation       | Page Up/Page Down                               | Terminal scrollback |
| Jump to newest message    | End                                             | Terminal scrollback |
| Open/close help           | F1 or `?` at empty input / Escape               | `/help`             |
| Cancel active operation   | Ctrl+C, with existing recovery semantics        | Ctrl+C              |
| Save and leave when idle  | Ctrl+D or `/pause`                              | Ctrl+D or `/pause`  |

Terminal key support differs across platforms. Every shortcut other than
Enter, Tab, Ctrl+C, and Ctrl+D is a convenience; the corresponding slash
command remains authoritative.

The renderer must not enable terminal mouse capture by default because it
interferes with text selection and some assistive technology.

### Command discovery

The enhanced interface provides:

- completion for all existing slash commands and agent mentions;
- a searchable or filterable help overlay;
- one-line descriptions beside completion candidates;
- context-sensitive disabling with a reason, such as
  `Implementation requires a Git project`;
- confirmation prompts for consequential workflow transitions.

Phase 3 does not invent a second command grammar. It reuses
`parseChatInput()` and the existing workflow option validators.

### Status and notifications

The interface announces important transitions in the conversation as well as
the status region:

- provider started and finished;
- provider failed or was cancelled;
- workflow entered planning, implementation, verification, review, or
  synthesis;
- both agents agreed on the same revision;
- the cycle cap was reached without agreement;
- a checkpoint was saved for recovery;
- a patch is ready for the user's completion choice.

Optional terminal notifications may be considered after Phase 3, but audible
bells, operating-system notifications, and escape-sequence hyperlinks are not
required by this specification.

## Plain and screen-reader behavior

Plain mode retains the existing append-only renderer and gains any new
commands introduced for enhanced-mode parity.

Screen-reader mode additionally requires:

- complete semantic sentences for status transitions;
- no live-region-style character streaming;
- no cursor-addressed screen rewrites;
- no dependence on color, borders, icons, spatial grouping, or animation;
- explicit speaker, role, decision, error, and elapsed-time labels;
- no unsolicited status line more frequently than the existing heartbeat
  policy;
- restoration of the saved preference on resume.

The implementation must document manual checks for VoiceOver on macOS, NVDA
on Windows, and Orca on Linux. Lack of access to one platform does not permit
removing its expected test procedure.

## Architecture

### Presentation-neutral view model

Add a small in-memory view model between coordinators and renderers. It holds
only information already safe to present:

```ts
interface TerminalViewModel {
  session: SessionSummary;
  messages: readonly PresentedMessage[];
  activity?: PresentedActivity;
  input: InputState;
  notice?: PresentedNotice;
}
```

Names are illustrative, not prescribed. The implementation should prefer the
smallest types that satisfy both renderers.

The view model:

- is derived from validated chat/run state and normalized provider events;
- does not parse provider prose;
- does not decide workflow transitions;
- does not grant permissions;
- does not become a new persisted source of truth;
- bounds retained live text and in-process scrollback;
- contains no private reasoning or raw provider tool payloads.

### Renderer contract

Introduce a renderer contract owned by the presentation layer:

```ts
interface TerminalRenderer {
  start(initial: TerminalViewModel): void;
  render(next: TerminalViewModel): void;
  suspend(): void;
  resume(): void;
  stop(): void;
}
```

Again, method names may change. Required semantics:

- `start` acquires only presentation-related terminal capabilities.
- `render` is deterministic for a view model and terminal size.
- `suspend` restores normal terminal behavior before a child workflow inherits
  the terminal.
- `resume` redraws from authoritative state after the child exits.
- `stop` is idempotent and restores the cursor, input mode, and screen.

Renderer failure must stop enhanced rendering, restore the terminal, emit a
plain-language warning, and continue in plain mode when application state is
still safe.

### Input ownership

One component owns stdin at a time.

- Enhanced mode may use raw input only while it owns the interactive prompt.
- Raw mode is disabled before spawning a child workflow.
- Child workflows inherit a normal terminal.
- After the child exits, ownership returns to chat and the view is rebuilt.
- No background listener may consume keys intended for a provider CLI or
  completion prompt.

Slash-command parsing remains in `chat-input.ts`. Workflow launching remains in
`chat-workflow.ts`. Input is sent through the existing parser and coordinator;
the renderer does not invoke providers directly.

### Event flow

```text
validated chat/run state ─┐
                          ├─► presentation view model ─► renderer
normalized safe events ───┘

user input ─► existing parser ─► chat/orchestrator ─► checkpoint
```

There is deliberately no arrow from the renderer or live events directly to a
workflow decision.

### Persistence

The selected UI mode may be stored in user preferences and chat presentation
settings. If it is added to persisted chat state, implementation must update
the TypeScript type, runtime validator, JSON Schema, migration, and fixture
tests together.

Do not persist:

- terminal dimensions;
- scroll position;
- open overlays;
- completion selection;
- transient activity;
- partial live text;
- alternate-screen contents.

## Terminal lifecycle

The enhanced renderer must restore:

- cursor visibility;
- canonical input mode;
- echo;
- alternate-screen state;
- bracketed-paste state if enabled;
- any signal handlers it installed.

Restoration is required after:

- `/pause` and `/done`;
- Ctrl+C and Ctrl+D;
- provider timeout or failure;
- validation error;
- child workflow launch;
- normal process exit;
- handled `SIGINT`, `SIGTERM`, and `SIGHUP`;
- renderer exception.

Fatal runtime failures must make a best-effort restoration before writing the
error to stderr. Tests must not depend solely on process exit to reset the
terminal.

## Security and privacy requirements

1. Renderers consume only the existing allowlisted `ProviderEvent` contract or
   a stricter presentation event derived from it.
2. Unknown provider events are ignored or fail at the provider boundary; they
   are never rendered generically.
3. Live output remains bounded.
4. Terminal control characters originating in provider or user text are
   escaped or rendered inert.
5. Project paths are not exposed in compact status by default. Full paths may
   appear only in explicit status/details output that already exposes them.
6. OSC sequences from untrusted text must never reach the terminal.
7. UI controls call existing confirmation and permission paths.
8. There is no automatic write retry.
9. Renderer crashes cannot mark a turn complete or change agreement.
10. Logs and crash messages must not dump the entire conversation.

## Performance requirements

- Input remains responsive while provider events arrive.
- Rendering is coalesced to a bounded refresh rate; one token must not force
  one full-screen redraw.
- A redraw must be proportional to visible content, not total persisted chat
  history.
- In-process scrollback and live previews have explicit memory bounds.
- Resize storms are debounced or coalesced.
- Plain mode adds no meaningful startup overhead.
- Enhanced-mode capability detection does not spawn external commands.

Initial implementation targets:

- no more than 30 visual refreshes per second during text streaming;
- no more than 500 retained rendered conversation entries;
- no more than the existing live-text character limit per provider response;
- terminal restoration within the current cancellation path, without an
  additional blocking timeout.

These are safety bounds, not promises that every terminal refreshes at the
maximum rate.

## Error handling

Errors must name the failed action and the safest next step.

Examples:

- `Enhanced terminal unavailable; continuing in plain mode.`
- `The terminal was resized too small for the enhanced layout. Continuing in compact mode.`
- `The active write turn was interrupted. It was not retried; resume the saved run to inspect its checkpoint.`

An inability to draw enhanced output is not itself a workflow failure. An
inability to restore terminal ownership safely is a fatal error.

## Delivery plan

### Slice 1: shared presentation model

- Introduce renderer-independent presentation state.
- Adapt the current plain presentation without changing its output.
- Add snapshot and behavior tests proving no regression.

### Slice 2: terminal lifecycle and static layout

- Add capability detection and `--ui`.
- Implement start, resize, suspend, resume, stop, and plain fallback.
- Render saved conversation and idle status without provider streaming.

### Slice 3: interactive input

- Add input editing, completion, help, history, paste, and scrolling.
- Reuse the existing parser and command handlers.
- Suspend and restore correctly around child workflows.

### Slice 4: live activity

- Connect normalized provider events to bounded, coalesced presentation state.
- Show active agent, model, role, elapsed time, and safe activity.
- Reconcile live previews with authoritative final responses.

### Slice 5: hardening and release

- Complete cross-platform PTY, resize, cancellation, and restoration tests.
- Perform screen-reader and narrow-terminal manual checks.
- Update the wizard, README, `--help`, architecture, security notes, and
  changelog.
- Default new chats to automatic capability-based enhanced presentation.

Each slice must leave plain mode working and may be merged independently.

## Test strategy

### Unit tests

- capability and mode resolution;
- precedence of flags, resumed state, and preferences;
- view-model reduction from safe events;
- text wrapping, clipping, Unicode width, and ANSI sanitization;
- layout selection at narrow, stacked, and wide widths;
- completion and keyboard-command mapping;
- render coalescing;
- live-preview finalization;
- bounded scrollback;
- idempotent terminal cleanup.

### Integration and PTY tests

- standard interactive conversation;
- targeted Codex and Claude turns;
- paired streaming without interleaving;
- Ctrl+C during a read-only provider call;
- Ctrl+C during an uncertain write turn, proving no retry;
- pause and resume;
- child workflow suspend and return;
- terminal resize while idle and while streaming;
- renderer failure followed by plain fallback;
- stdin/stdout redirection;
- `TERM=dumb`, `NO_COLOR`, and `--screen-reader`;
- process signals and cursor/input restoration;
- macOS, Linux, and Windows terminal behavior.

Tests use fake providers, temporary projects, and temporary
`AGENT_BRIDGE_HOME`. They must not require network access or real provider
authentication.

### Manual acceptance matrix

At minimum:

- macOS Terminal or iTerm2;
- Windows Terminal with PowerShell;
- a common Linux terminal;
- VS Code's integrated terminal;
- a 40-column terminal;
- a terminal resized repeatedly during streaming;
- VoiceOver plain mode;
- NVDA plain mode;
- Orca plain mode.

## Acceptance criteria

Phase 3 is complete when:

1. A capable interactive terminal selects the enhanced interface automatically,
   and users can override it from the CLI or novice wizard.
2. The interface continuously identifies the active agent, model, role, phase,
   elapsed time, and safety mode.
3. Existing chat commands and workflow handoffs work through the same parser
   and coordinator as plain mode.
4. Provider streaming remains safe, bounded, and non-authoritative.
5. Narrow terminals and resizing do not corrupt output or lose input.
6. Child workflows receive a normal terminal and return cleanly to chat.
7. Every exit and handled failure path restores terminal state.
8. `--screen-reader`, redirected streams, and unsupported terminals receive a
   complete plain experience.
9. No action is available only through color, position, animation, or a mouse.
10. Editing permissions, isolation, confirmation, checkpoint, and agreement
    invariants are unchanged.
11. Deterministic tests cover both renderers, lifecycle, cancellation, and
    fallback behavior on supported CI platforms.
12. `npm run check`, `npm run test:coverage`, and `npm pack --dry-run` pass.

## Release safeguards

Automatic mode remains the default while the release safeguards below hold:

- terminal restoration tests are stable across supported CI platforms;
- no high-severity accessibility issue remains;
- at least one manual pass succeeds in VS Code, macOS, Windows, and Linux
  terminals;
- fallback telemetry is not required, because Agent Bridge does not add usage
  tracking for this feature.

If the enhanced renderer proves unreliable on a terminal, users can always
select `--ui plain`; saved sessions remain readable because conversation state
is renderer-independent.

## Open implementation decisions

The implementation may decide:

- whether the enhanced renderer uses the alternate screen or a bounded inline
  region;
- the exact border style and color palette;
- whether wide mode uses a side column or a larger stacked activity region;
- the internal names of presentation events and view-model types;
- which Unicode width implementation is small and reliable enough while
  preserving the zero-production-dependency goal.

These decisions must not weaken any normative requirement above.
