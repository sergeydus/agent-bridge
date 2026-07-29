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
5. Its response is checkpointed and control returns to the human.

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
create a second persistent command-history file.

If interruption occurs after the first response, the checkpoint records the
pending peer and exact saved message. Resume calls only that missing peer; it
does not repeat the already completed provider call.

`/auto N` first previews its maximum exchanges and provider calls, then repeats
paired exchanges until both providers return `done` for the same exchange or
the requested limit is reached. This agreement applies only to the current
answer; it never authorizes edits and never prevents a later human follow-up.

## Conversation memory

Provider-native persistence is disabled. Agent Bridge stores ordered messages
locally and embeds a bounded JSON representation in each new prompt. The
beginning and end are retained when a long conversation exceeds the prompt
budget. Providers may always inspect the selected project directly.

Every active session has:

- a versioned, runtime-validated JSON checkpoint;
- an owner-only Markdown transcript;
- an exclusive lock;
- saved project type, provider settings, retry limit, and timeout;
- saved screen-reader, color, and interface preferences;
- independent automatic-chat and editing-workflow limits;
- linked workflow results.

Completed sessions remain reopenable. `/pause`, Ctrl+D, and idle interruption
leave the session resumable. Ctrl+C during active provider work cancels that
operation and returns to the saved chat; a second idle Ctrl+C pauses it.
`/done` marks it complete. With `--no-transcript`, the active checkpoint still
exists for recovery but both files are deleted after successful completion.

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
requires Git, defaults to a detached worktree, and uses the standard completion
choices. The temporary task file is owner-only and removed when the workflow
exits.

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
from another process.

## Presentation

`--screen-reader` selects semantic, append-only output without color or
decorative separators. It uses descriptive prompt labels and forwards
Claude's native accessibility flag. `--no-color` disables bridge color without
changing the rest of the standard layout. `NO_COLOR` is also honored.

`--ui enhanced` opts into the Phase 3 alternate-screen preview. `--ui auto`
uses it only when stdin and stdout are interactive, `TERM` is usable, and the
terminal meets the minimum dimensions. `--ui plain` remains the release
default. Screen-reader mode always selects plain output and explains the
override when combined with an explicit enhanced request.

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
resize, neutralizes control sequences from conversation text, leaves one
terminal row for the existing readline prompt, and never captures the mouse.
It suspends and restores the normal screen before a linked workflow starts,
then reconstructs its frame from the in-memory presentation model afterward.
Help, history, status, and other supplemental command output temporarily use
the normal screen so the text remains readable until the next command. A
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
