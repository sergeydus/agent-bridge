# Agent Bridge

Agent Bridge is a standalone local coordinator for Codex CLI and Claude Code.
It supports longer human-guided conversations as well as autonomous workflows:
the agents can discuss a task, take turns implementing it, review the same code
revision, refactor in multiple phases, and stop only when both explicitly
approve that revision.

It can be installed anywhere and can work on any project you select. It has no
dependency on the repository that happens to contain its source.

## Quick start

Requirements:

- Node.js 22.6 or newer
- Git for editing workflows
- Codex CLI authenticated with your ChatGPT account
- Claude Code authenticated with an eligible Claude account

Authenticate each CLI once:

```sh
codex login
claude
```

The CLIs use their own subscription authentication. Agent Bridge does not need
an OpenAI or Anthropic API key.

On macOS, double-click **Start Agent Bridge.command**. You can also drag a
project folder onto it, or run:

```sh
npm start
```

To make `agent-bridge` available from any terminal while developing this local
copy:

```sh
npm link
agent-bridge --help
```

On first use, the wizard asks whether you need screen-reader-friendly output
before showing any complex menu, then remembers that choice. Select a project
by number or paste/drag its folder, and choose one plain-language intent:
**Discuss**, **Make changes**, or **Review**. Provider roles, models, interface
style, and limits stay under Advanced settings. **Make changes** always remains
visible. For a non-Git folder, the wizard explains why Git is needed and can
run `git init` after confirmation. It never stages or commits project files;
you review `.gitignore` and create the required first commit yourself.

The default path is short:

1. Answer the accessibility question once.
2. Pick or paste a project.
3. Choose **Discuss**, **Make changes**, or **Review**.

**Discuss can edit later:** ordinary chat messages never edit files, but typing
`/edit` opens a complete safety preview and confirmation before a separate
editing workflow begins. If the repository has no initial commit yet, chat
explains that requirement instead of starting a broken workflow.
If an interrupted peer response is still pending, a linked workflow first runs
its free project eligibility checks, then finishes that read-only response
before preflight or launch. A rejected command spends no provider call, and
cancelling the response leaves the workflow unstarted.

## Interactive chat

Start a persistent conversation tied to any Git repository or ordinary folder:

```sh
agent-bridge chat --cwd /path/to/project
```

From an unlinked source checkout, use:

```sh
npm run chat -- --cwd /path/to/project
```

Each message produces one read-only Codex/Claude exchange and then returns
control to you. The bridge—not either provider—stores bounded conversation
history, so provider calls remain ephemeral, portable, and independently
sandboxed.

While an agent works, Agent Bridge displays safe live progress instead of
waiting silently for the final answer. Interactive chat streams user-facing
text as it arrives. Workflows that may run both providers concurrently buffer
each text update into a complete, speaker-labeled block so their output cannot
interleave. The final schema-validated response is still the only result that
can drive agreement or workflow state.

Inside the chat:

```text
/ask codex|claude <text> Ask one agent directly
/both <text>              Explicitly ask both agents
@codex|@claude|@both ... Short form for a targeted message
/auto [1-20]              Continue until both mark one paired exchange done
/edit [codex|claude]      Preview and start safe alternating edits
/implement codex|claude   Start safe fixed-role implementation and review
/collaborate codex|claude Start safe alternating edits; named agent goes first
/review                   Start a read-only agreement workflow
/paste                    Enter a multiline message
/status                   Show session information
/history [1-50]           Show recent messages
/pause                    Save and leave
/done                     Complete and leave
/help                     Show all commands
```

Press Tab to complete commands and agent names. Readline history is available
for the current process and removes duplicate entries; it is not written to a
separate shell-history file. A complete line typed while an agent is working is
queued for the next prompt. Both terminal modes show the queued count, never
the queued text, and the line is never inserted between the two agents in the
current paired exchange. This covers complete submitted lines. In an enhanced
TTY, characters that have not reached Enter can still be echoed and repainted
during live redraws; broader PTY input coordination remains hardening work.

Ordinary messages and `/both` produce the normal two-agent exchange. `/ask`
and the `@codex` or `@claude` forms call only the selected agent, which is
useful for a focused follow-up without paying for an unnecessary peer call.
The targeted message and response remain part of the shared bounded history.
These conversational turns are read-only: they cannot edit project files.

The terminal reports whether the latest paired exchange is waiting for its
peer, remains open, or has two `done` decisions. “Both marked done” is the exact
structured state; it is not presented as independently verified agreement.
Starting `/auto` from that state explicitly previews that it will open another
exchange.

`/edit` is the recommended editing command. It chooses alternating
implementation and review with Claude first; `/edit codex` changes the first
writer. Before anything can edit, Agent Bridge shows the project, roles,
isolated workspace, dirty-tree handling, verification commands, cycle and
provider-call limits, and asks once for confirmation. `/implement` and
`/collaborate` remain advanced role controls and use the same preflight.

Pause with `/pause` or Ctrl+D, then reopen any saved session—including a
completed one—with:

```sh
agent-bridge chat --resume latest
agent-bridge chat --resume <chat-id>
agent-bridge chat --list-chats
agent-bridge chat --delete-chat <chat-id>
```

During an active provider response, Ctrl+C cancels that work, saves the
checkpoint, and returns to the chat. Press Ctrl+C again while idle to pause and
leave safely.

Use `--task` or `--task-file` with `chat` to supply the first message
immediately. `--no-transcript` keeps only the active recovery checkpoint and
deletes the chat history after `/done`.

## Accessible terminal output

The wizard remembers screen-reader and interface preferences for later runs.
You can also start any mode explicitly with:

```sh
agent-bridge chat --screen-reader --cwd /path/to/project
```

This mode uses append-only semantic status text, descriptive prompts, no ANSI
color, and no decorative progress glyphs. It is saved with interactive chats
and forwarded to child workflows. Claude also receives its native
screen-reader CLI flag when the installed version offers it; `--doctor` reports
which optional provider flags were detected. Live text deltas are buffered into
complete semantic
updates instead of being announced character by character. Use `--no-color`
when you only want to disable Agent Bridge color output, or `--color` to turn
it back on; the two are mutually exclusive. Color is never the only way an
agent or decision is identified.

Color is decided by the most specific source that expresses a choice:

1. `--color` or `--no-color` on the current command line;
2. the presentation saved with the chat being resumed;
3. the preference stored by the wizard;
4. automatic detection, which enables color for an interactive terminal unless
   the standard `NO_COLOR` environment variable is set.

So a saved preference is a preference, not a permanent state — a chat saved
with `--no-color` can be reopened with `--color`. Only those two flags record a
choice: picking a presentation style in the wizard selects a layout and says
nothing about color, so automatic detection still applies afterwards.

Two rules override every layer above: screen-reader mode never uses color, and
color is never written to a redirected stream, because escape sequences would
corrupt output meant for another reader.

Interactive terminals use the enhanced conversation view automatically when
capability checks pass:

```sh
agent-bridge chat --cwd /path/to/project
```

It presents the saved conversation, active agent, model, phase, elapsed time,
available token usage, safety mode, and safe activity in a responsive
full-screen layout. Streaming updates are coalesced to keep redraws responsive
without writing a frame for every text fragment. When an exchange completes,
the renderer returns to the normal screen and prints each complete response so
native terminal scrollback remains available. It resumes the live view before
the next agent starts. The renderer also suspends before a linked workflow
inherits the terminal and restores normal terminal state on exit. Supplemental
command output such as help and history stays on the normal screen until the
next agent starts. If enhanced drawing fails after normal terminal state is
restored, the chat continues with plain output. Use
`--ui plain` to retain append-only output or `--ui enhanced` to request the
full-screen view explicitly. Screen-reader mode, redirected streams,
`TERM=dumb`, and terminals that are too small use the complete plain interface.

Enhanced mode is available under Advanced settings in the wizard and falls
back to standard output if the current terminal cannot support it.

Check your setup:

```sh
npm run doctor
```

Before opening a chat or creating an editing workspace, Agent Bridge checks
that both provider CLIs can start. If either is unavailable, it reports which
command failed and points to the setup diagnostics. On Windows, npm-installed
`.cmd` shims such as `claude.cmd` and `codex.cmd` are supported.

`npm install` installs Agent Bridge's small Windows-compatible process-launch
dependency as well as its development tooling.

## Roadmap

Phase 3 provides an automatic enhanced interactive terminal with a live
conversation view, workflow status, discoverable controls, responsive layouts,
and a complete plain/screen-reader fallback. It is a presentation layer over
the existing state machines and does not change editing permissions or
agreement rules.

See [the Phase 3 enhanced interactive terminal specification](docs/phase-3-interactive-terminal.md).

## What happens during a collaborative run

1. Codex and Claude independently inspect the task and discuss a plan.
2. One agent receives write access and implements.
3. Agent Bridge captures the exact resulting workspace revision.
4. Configured verification commands run outside the agent.
5. The other agent reviews that same revision with read-only access.
6. The roles alternate for another implementation phase when work remains.
7. The run converges only when the implementer and reviewer both return a
   structured `done` decision for the same cycle.
8. A read-only judge writes the final synthesis.

The maximum-cycle limit always remains in force, so disagreement cannot create
an infinite run.

## Workflows

### Collaborate and alternate edits

This is the recommended implementation workflow. Both agents discuss first,
then alternate between implementing and reviewing until they agree or reach
the configured safety cap.

```sh
agent-bridge \
  --task "Implement this safely and keep improving it until both agents agree" \
  --cwd /path/to/project \
  --collaborative claude \
  --max-rounds 6
```

### Fixed roles

One agent remains the implementer while the other remains the reviewer.

```sh
agent-bridge \
  --task-file /path/to/task.md \
  --cwd /path/to/project \
  --implementer codex \
  --max-rounds 6
```

### Review only

Both agents analyze; neither can edit. Review-only mode works with Git
repositories and ordinary folders.

```sh
agent-bridge \
  --task "Review these changes and agree on the safest recommendation" \
  --cwd /path/to/project \
  --git-diff working-tree \
  --until-agreement \
  --max-rounds 6
```

Git review sources can be `working-tree`, `last-commit`, or a custom range:

```sh
agent-bridge \
  --task "Review this branch against main" \
  --cwd /path/to/project \
  --git-diff main...HEAD \
  --rounds 2
```

When the executable is not globally linked, replace `agent-bridge` with
`npm run talk --`.

## Repository safety

Editing workflows require Git with an initial commit and create a detached
worktree by default. The wizard can initialize Git with explicit permission,
but only you decide which files belong in the initial commit. The selected
checkout remains untouched while agents work. At completion, Agent Bridge
creates a binary-safe patch and offers to:

- keep the isolated workspace for inspection;
- apply the patch after checking that the original base revision is unchanged
  and `git apply --check` succeeds; or
- explicitly discard the registered isolated worktree.

Agent Bridge never commits, stages, resets, or silently discards project
changes.

If the selected checkout is dirty, an isolated workspace cannot include those
changes. You must commit or stash them, or explicitly acknowledge a committed
`HEAD` run with `--from-head`.

`--no-isolation` edits the selected checkout directly. It requires a clean
working tree unless you explicitly pass `--allow-dirty`. Existing dirty files
are fingerprinted and the run stops if an agent changes them. Before the first
agent call, Agent Bridge also saves a private, binary-safe recovery patch of
all pre-existing tracked and untracked work. Direct mode remains less isolated
than the default and should be reserved for cases that truly require it.

Run output must stay outside a project used for editing, so checkpoints,
transcripts, and recovery patches are never placed inside the agent workspace.

A `*.preexisting.patch` recovery file represents the original dirty state
relative to its recorded base commit. Inspect it first; the safest restoration
path is to apply it to a clean checkout of that base, not blindly over a
partially edited working tree.

Only the current implementer receives write access. Claude's write phase uses
an explicit file-tool allowlist without Bash. Agent Bridge, not the agent, runs
the verification commands you approve. Write calls are never retried because a
failed call may already have edited files.

## Project configuration

A project may define `.agent-bridge.json`:

```json
{
  "version": 1,
  "verification": [
    {
      "command": "npm",
      "args": ["test"],
      "timeoutMinutes": 15
    },
    {
      "command": "npm",
      "args": ["run", "typecheck"]
    }
  ],
  "protectedPaths": [".env", "secrets"]
}
```

Commands are executable-and-argument arrays, never shell strings. Executable
names cannot contain path separators. This prevents shell interpolation but
does not make an untrusted command safe: project configuration can still run
local package scripts or programs found on `PATH`.

For that reason, project verification is disabled unless you approve it in the
wizard or pass:

```sh
agent-bridge ... --trust-project-config
```

Use `--project-config /path/to/config.json` to select another file. Protected
paths are fingerprinted before agent work and verified after every edit.

See [Project configuration](docs/project-configuration.md) for the exact
contract.

## Recovery and run history

Agent Bridge saves an atomic checkpoint around every workflow transition. A
run lock prevents two processes from resuming the same run concurrently.
`Ctrl+C` cancels safely and preserves an isolated workspace.

```sh
agent-bridge --resume latest
agent-bridge --list-runs
agent-bridge --discard-workspace <run-id>
agent-bridge --delete-run <run-id>
agent-bridge --prune-runs 30
```

Resume uses the task, limits, provider settings, trusted verification commands,
protected paths, and workspace recorded in the checkpoint. It does not silently
adopt a changed project configuration.

Discarding a workspace validates and removes the exact Git-registered worktree
while retaining run history. Deleting a run removes its checkpoint and
transcript artifacts but preserves an editable worktree. Pruning removes only
completed or cancelled runs older than the requested age and skips every
retained worktree.

Use `--no-transcript` when you do not want completed Markdown, JSON, or context
artifacts retained. A temporary checkpoint still exists while the run is
active so interruption remains recoverable; it is deleted after success.
Interactive chats use an independent owner-only checkpoint and Markdown
transcript. Their lock prevents two terminals from reopening the same chat.

## Data sent to providers

Codex and Claude are separate services. Material needed for the selected task
may be sent to both providers, including:

- the task text and shared root `AGENTS.md` or `CLAUDE.md` instructions;
- Git diffs, bounded workspace snapshots, and verification output;
- the other agent's prior response and review findings;
- bounded interactive-chat history when chat mode is active.

Do not place secrets in task text. Keep sensitive files outside the selected
project. `protectedPaths` detects writes but does not prevent provider
visibility. Provider retention and training behavior is governed by the
accounts and policies used by each CLI.

## Local data

Recent projects, checkpoints, transcripts, patches, and isolated worktrees are
stored outside the installation:

- macOS: `~/Library/Application Support/Agent Bridge`
- Linux: `${XDG_STATE_HOME:-~/.local/state}/agent-bridge`
- Windows: `%LOCALAPPDATA%\Agent Bridge`

Set `AGENT_BRIDGE_HOME` to override this location. Files are written with
owner-only permissions where the platform supports them.

## Command-line options

Run `agent-bridge --help` for the authoritative list:

```text
--wizard                 Guided setup, including safe Git setup for editing
chat                     Open interactive human-guided chat mode
--list-chats             List saved interactive chats
--delete-chat <id>       Delete an exact saved chat
--task <text>            Task text; otherwise read stdin
--task-file <path>       Read the task from a file
--cwd <path>             Project visible to the agents
--git-diff <source>      working-tree, last-commit, or a Git range
--rounds <n>             Fixed review rounds
--until-agreement        Continue until both agents approve
--require-agreement      Exit non-zero if the cap is reached without agreement
--max-rounds <n>         Agreement-mode safety cap
--max-auto-rounds <n>    Interactive automatic-exchange cap
--implementer <agent>    Fixed codex or claude implementer
--collaborative <agent>  Alternating workflow and first implementer
--from-head              Acknowledge ignoring dirty changes in isolation
--no-isolation           Edit the selected checkout directly
--allow-dirty            Permit direct editing beside existing changes
--resume <id|latest>     Continue a run, or reopen a chat in chat mode
--retries <n>            Retry transient read-only calls
--timeout-minutes <n>    Per-agent timeout
--judge <agent>          Read-only synthesis agent
--codex-model <name>     Codex model override
--claude-model <name>    Claude model override
--codex-effort <level>   Codex reasoning effort: low, medium, high, xhigh, max
--claude-effort <level>  Claude reasoning effort: low, medium, high, xhigh, max
--screen-reader          Use screen-reader-friendly, append-only output
--color                  Enable color on interactive terminals
--no-color               Disable Agent Bridge color output
--ui <mode>              Chat interface: plain, enhanced, or auto
--project-config <path>  Alternate project configuration
--trust-project-config   Run configured verification commands
--output <directory>     Override run-data storage
--no-transcript          Do not retain completed transcripts
--list-runs              List checkpoints
--delete-run <id>        Delete exact run artifacts
--discard-workspace <id> Safely remove a completed run's isolated worktree
--prune-runs <days>      Prune old safe-to-delete runs
--dry-run                Show provider commands without calling agents
--verbose                Show provider diagnostic output
--doctor                 Check versions, auth, storage, and required features
```

## Development

```sh
npm install
npm run check
npm run test:coverage
npm pack --dry-run
```

The test suite uses temporary repositories, fake providers, and isolated
application-data locations. It never invokes real agents or uses subscription
calls.

Start with [AGENTS.md](AGENTS.md), then see
[Architecture](docs/architecture.md),
[Workflow state machine](docs/workflow-state-machine.md),
[Interactive chat](docs/interactive-chat.md),
[Provider contract](docs/provider-contract.md), and
[Security](docs/security.md).
