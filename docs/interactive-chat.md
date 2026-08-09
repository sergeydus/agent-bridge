# Interactive chat

Interactive chat is a durable, human-guided layer over the existing provider
and workflow contracts. It does not create a shared native Codex or Claude
session.

## Turn model

For each human message:

1. Agent Bridge stores the message.
2. One provider receives the bounded conversation and current project
   instructions in read-only mode.
3. Its schema-valid response is checkpointed.
4. The other provider receives the updated history and explicitly critiques
   that current response.
5. Its response is checkpointed. If either response says `continue`, control
   returns to the human.
6. If both responses say `done`, the original first provider receives the
   exact saved pair in a dedicated reciprocal-confirmation prompt.
7. The confirmation response and settled exchange record are checkpointed
   together, then control returns to the human.

The first speaker alternates between exchanges. This prevents either provider
from permanently anchoring the discussion.

`/ask codex <message>` and `/ask claude <message>` request a single read-only
response. The equivalent short forms are `@codex <message>` and
`@claude <message>`. `/both <message>` and `@both <message>` explicitly use the
normal paired exchange. Targeted turns are checkpointed in the same bounded
history but do not create a pending peer response or claim two-agent
agreement. They also do not change which provider leads the next paired
exchange.

Normal input sends one line. `/paste` accepts a multiline message and sends it
when a line containing only `.` is entered.

The terminal completes slash commands and agent mentions with Tab. Its
in-process input history is capped and deduplicated; Agent Bridge does not
create a second persistent command-history file. If a complete line arrives
while provider work is active, readline queues it for the next prompt. It is
never inserted between the two agents in the current paired exchange. The
presentation model exposes only the queued count, not the queued text, and both
plain and enhanced modes explain that behavior. This guarantee begins when
readline receives a complete submitted line. In an enhanced TTY, partial input
before Enter can still be echoed and repainted by live redraws; PTY-level input
coordination remains separate hardening work.

If interruption occurs after the first response, the checkpoint records the
pending peer and exact saved message. If it occurs after two provisional
`done` responses, the checkpoint instead records the pending reciprocal
confirmation and both exact messages. Resume calls only the saved stage's
missing provider; it does not repeat completed calls.

A linked `/review`, `/edit`, `/implement`, or `/collaborate` command first runs
the free project-type and initial-commit eligibility checks. If the command is
eligible, it finishes that pending peer response before workflow preflight or
launch confirmation. A rejected command spends no provider call; cancelling
the pending response leaves the workflow unstarted and appends no
workflow-completion message.

`/auto N` first previews its maximum exchanges and provider calls, then repeats
paired exchanges until one is reciprocally confirmed or the requested limit
is reached. One round includes its conditional confirmation. The worst case is
`3N` calls with no pending work, `3N - 1` while awaiting a peer, and `3N - 2`
while awaiting confirmation; most open exchanges still use two calls.
Confirmation applies only to the current answer, is not independent
verification, never authorizes edits, and never prevents a later human
follow-up. If `/auto` starts when the latest exchange is already confirmed,
the preview says that continuing deliberately opens another exchange. A
migrated legacy pair with two `done` decisions is identified as unconfirmed
and starts a version 4 exchange that can reach reciprocal confirmation.

Authentication errors, rate limits, invalid responses, timeouts, and exhausted
retries leave the latest saved stage intact and return control to the prompt
when storage and terminal state remain usable. `/done` then names the missing
peer or confirmation stage and defaults to keeping the chat open. If the human
confirms completion, the saved responses are recorded as an abandoned
exchange, the lead rotates, and the session completes atomically.

## Conversation memory

Provider-native persistence is disabled. Agent Bridge stores ordered messages
locally and embeds a bounded JSON representation in each new prompt and linked
workflow task. The serialized value always remains valid JSON. Recent complete
messages are preferred; the opening message is also retained when it fits, and
an explicit record gives the number of omitted messages. If one saved message
is itself too large, its text carries a visible omission marker and a
`truncatedCharacters` count instead of clipping the JSON syntax. New user
messages are capped at 32,000 characters so one normal turn fits coherently
within the history budget. Providers may always inspect the selected project
directly.

Every active session has:

- a versioned, runtime-validated JSON checkpoint;
- an owner-only Markdown transcript;
- an exclusive lock;
- saved project type, provider settings, retry limit, and timeout;
- saved screen-reader, color, and interface preferences;
- independent automatic-chat and editing-workflow limits;
- linked workflow results.

Chat checkpoints use format version 4, whose exchange records distinguish
pending peer work, pending confirmation work, settled results, and explicit
abandonment. Versions 1 through 3 migrate on load. If a valid version 3 pending
record points behind later saved messages, migration preserves every message
and the session status, discards only that ambiguous pending pointer, and emits
a warning inviting the user to start a new exchange.

Live presentation and `/status` describe the current conversational context.
After a newer user, system, or targeted-agent message, they show no current
paired result until another pair begins. The transcript's latest-pair field is
historical and continues to report the stored completed or abandoned record.

Completed sessions remain reopenable. `/pause`, Ctrl+D, and idle interruption
leave the session resumable. Ctrl+C during active provider work cancels that
operation and returns to the saved chat; a second idle Ctrl+C pauses it.
`/done` marks it complete. With unfinished provider work it first asks whether
to record the exchange as abandoned, defaulting to no. With `--no-transcript`,
the active checkpoint still exists for recovery but both files are deleted
after successful completion.

## Editing and review commands

Interactive turns are always read-only. These commands launch a normal Agent
Bridge child workflow using the bounded conversation as its task:

- `/implement codex|claude` — fixed implementer and reviewer;
- `/collaborate codex|claude` — planning followed by alternating writers;
- `/review` — read-only agreement workflow.

`/edit` is the recommended path: it selects collaborative alternating edits
with Claude first. `/edit codex` overrides the first writer. Every workflow
command uses one shared preflight with the direct wizard. It handles dirty
repositories and project verification trust, shows roles, isolation, cycle and
provider-call limits, states that agents do not commit/stage/push, and requires
confirmation before an editing child process starts.

The child receives the existing options for models, effort, timeouts, output,
privacy, presentation, and trusted project configuration. Editing still
requires Git with an initial commit, defaults to a detached worktree, and uses
the standard completion choices. `/edit` reports a missing repository or
initial commit before preflight; it never initializes, stages, or commits from
inside chat. The temporary task file is owner-only and removed when the
workflow exits.

After the child exits, the chat records its mode and exit code and stays open.
Later agents are told to inspect the actual project state rather than assuming
that a successful child exit means a patch was applied.

## Management

```sh
agent-bridge chat --resume latest
agent-bridge chat --resume <chat-id>
agent-bridge chat --list-chats
agent-bridge chat --delete-chat <chat-id>
```

Deletion acquires the session lock first, so an active chat cannot be deleted
from another process. Resuming likewise acquires the session lock before the
provider-availability preflight, so a chat already open elsewhere reports that
conflict rather than an unrelated provider error.

## Presentation

`--screen-reader` selects semantic, append-only output without color or
decorative separators. It uses descriptive prompt labels and forwards
Claude's native accessibility flag. `--no-color` disables bridge color without
changing the rest of the standard layout, and `--color` turns it back on; the
two are mutually exclusive.

Color is resolved by precedence, most specific source first: an explicit
`--color` or `--no-color` on this command line, then the presentation saved
with the resumed chat, then the wizard's stored preference, then automatic
detection, which honors `NO_COLOR` and requires an interactive terminal.

A resumed chat therefore reopens looking the way it was left, but the saved
choice is a default rather than a lock: a chat saved with `--no-color` reopens
in color when `--color` is passed, and the reversal is saved in turn. A chat
that never stated a choice falls through to the global preference rather than
skipping that layer. The same chain runs in the wizard, so neither entry point
can strand a choice. A chat-launched workflow inherits the parent's
already-resolved choice as an explicit flag, so the child cannot decide
differently. Screen-reader mode and a redirected stream still override
everything above.

The stored choice is genuinely three-valued: `true` chose color, `false` chose
no color, and an absent value means nobody chose. Only `--color` and
`--no-color` record one. Selecting a presentation style in the wizard picks a
layout and leaves color unstated, and screen-reader mode suppresses color when
the presentation is resolved rather than recording a preference that would
outlive the mode.

Chat sessions are version 4 and user configuration is version 3. Both
previously stored a `noColor` boolean. Migration reads a stored
`true` as an explicit "no color", because only `--no-color` or the
screen-reader choice could produce it, and reads a stored `false` as no choice
at all, because the CLI that wrote it had no positive `--color` and `NO_COLOR`
still applied. Treating that `false` as an explicit color-on would silently
promote every existing chat and configuration to overriding `NO_COLOR`.

New chats default to `--ui auto`, which uses the alternate-screen interface
only when stdin and stdout are interactive, `TERM` is usable, and the terminal
meets the minimum dimensions. `--ui plain` selects append-only output, while
`--ui enhanced` requests the full-screen interface explicitly. Screen-reader
mode always selects plain output and explains the override when combined with
an explicit enhanced request. Saved and resumed presentation choices continue
to take precedence over the release default.

The wizard asks about screen-reader output before its first complex menu and
persists the answer. Standard and automatic enhanced output remain available
under Advanced settings. Project folders can be pasted or dragged directly
into its project prompt; saved project numbers remain shortcuts when
available.

Redirected stdin is also supported in plain mode. Each input line is handled as
the next chat message or slash command, and end-of-input pauses and saves the
session. This makes short scripted conversations possible without weakening the
interactive lock and checkpoint rules.

The enhanced renderer has compact, stacked, and wide layouts. It redraws on
resize, coalesces text-delta redraws, uses low-frequency activity animation,
shows current model, phase, elapsed time, available token usage, paired-exchange
state, queued-input count, and safety mode, neutralizes control sequences from
conversation text, leaves one terminal row for the existing readline prompt,
and never captures the mouse.
After an exchange, it prints the complete responses on the normal screen so
native terminal scrollback remains available, then reconstructs its live frame
before the next agent starts. It also suspends and restores the normal screen
before a linked workflow starts. Help, history, status, and other supplemental
command output stays on the normal screen so the text remains readable until
the next agent starts. A
recoverable enhanced-renderer failure restores the terminal and continues with
the plain renderer.

Speaker names and structured decisions are always written as text, so color is
supplemental. Presentation preferences are restored when a chat is resumed
and forwarded when chat launches an implementation or review workflow.

Provider adapters also emit safe live progress. Standard interactive chat
streams user-facing text deltas with an explicit speaker heading. Screen-reader
mode buffers those deltas into complete semantic updates. One-shot workflows
also buffer each provider's text into atomic labeled blocks because providers
may run concurrently. Generic activity can describe that an agent is searching,
reading, editing, or using a tool, but never includes raw commands, tool inputs,
file paths, or private reasoning.

Live progress is intentionally not conversation memory. Only the final
schema-validated response is checkpointed, shown as the response, and supplied
to the next agent.
