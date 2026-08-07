# Provider contract

`AgentProvider` is the only interface between orchestration and an external
coding CLI.

## Inputs

Each call receives:

- a complete role-specific prompt;
- project working directory;
- read-only or write mode;
- response kind (`turn` or `synthesis`);
- Git/non-Git project kind;
- timeout, cancellation signal, model, and reasoning effort;
- whether the provider should enable its native screen-reader behavior;
- an optional provider-neutral live-event sink;
- a private temporary directory for response schemas and output.

The orchestrator does not construct provider flags. Provider adapters do not
decide workflow order. A provider that has no native accessibility flag may
ignore the screen-reader capability; Agent Bridge still renders its response
semantically.

Interactive chat uses the same `turn` response contract and always requests
read-only access. Provider-native session persistence remains disabled; the
coordinator supplies bounded, JSON-encoded bridge history on each call.

## Outputs

A normal turn must produce:

```json
{
  "decision": "done",
  "text": "Human-readable analysis or implementation report"
}
```

`decision` is `done` only when no actionable work or unresolved disagreement
remains. Otherwise it is `continue`.

A synthesis produces:

```json
{
  "text": "Final result in Markdown"
}
```

The response parser accepts the direct object and the documented structured
wrappers emitted by the supported CLIs. It rejects unstructured, ambiguous, or
empty output. It never infers a decision from prose.

## Live events

Codex runs with its documented JSONL mode. Claude runs with its documented
stream-json mode and partial message events. Their adapters normalize output
to a deliberately small event union:

- safe generic activity;
- user-facing text deltas or complete text updates;
- text completion boundaries;
- token usage metadata.

The normalized stream is informational. The final schema-constrained output
file or result event remains authoritative, and only that validated response
may affect decisions, checkpoints, or convergence. The adapters never forward
reasoning events, thinking deltas, commands, tool inputs, file paths, or raw
provider events. Unknown event types are ignored for forward compatibility.

The implementation follows the official [Codex non-interactive
contract](https://developers.openai.com/codex/noninteractive) and [Claude
streaming output
contract](https://code.claude.com/docs/en/agent-sdk/streaming-output).

## Permissions

Read-only provider calls must use the strongest supported read-only mode.
Write permissions must be explicit and scoped to the selected workspace.
Provider-specific bypass flags are forbidden.

Claude write turns allow `Edit`, `Read`, `Write`, `Glob`, and `Grep`, without
Bash. Codex uses its workspace-write sandbox. Both receive instructions not to
run package, build, deploy, or version-control mutations; approved checks are
the coordinator's responsibility.

Claude's tool set is declared twice on purpose, because the two flags act at
different layers. `--tools` selects which built-in tools exist for the turn,
and `--allowedTools` is the allow-without-prompting list that keeps a
non-interactive call from stalling on a confirmation. One shared constant per
access level feeds both, so availability and permission cannot drift apart.

Codex only activates its Windows restricted-token sandbox when `windows.sandbox`
is set. Because Agent Bridge runs Codex with `--ignore-user-config`, it supplies
that value itself on Windows; without it `--sandbox workspace-write` silently
degrades to a read-only sandbox that rejects every edit.

## Argument safety

Every provider argument must stay on a single line. Windows resolves both
provider CLIs to `.cmd` shims that run through `cmd.exe`, where a line break
inside an argument truncates the command line and silently discards every later
argument — including the permission flags. `runProcess` refuses to spawn such a
command instead of running a partial one, and long instructions belong in the
prompt on standard input rather than in an argument.

Only flags the installed provider CLIs actually accept may be emitted. An
unrecognized flag aborts the call, and one placed after a truncated argument
hides that failure entirely.

Provider CLIs gain and lose flags between releases, so support is detected, not
assumed in either direction. Each adapter therefore sorts the flags it emits
into three kinds, and a test asserts that the declared sets match what the
adapter really emits.

**Required and advertised.** Emitted on every call and listed in the CLI's own
help output. `CODEX_REQUIRED_FLAGS` and `CLAUDE_REQUIRED_FLAGS` name them in one
place, and `agent-bridge --doctor` verifies that exact list, reporting any flag
by name. Conditional flags stay out of it — Codex's `--skip-git-repo-check`,
`--config`, and `--model`, and Claude's `--model` and `--effort` appear only
when the project or the user asks for them, so a missing one should not condemn
an otherwise working installation.

Help text is matched as whole flag tokens, never as substrings: a CLI that
advertises `--json-schema` must not be read as offering `--json`.

**Required but hidden.** A CLI may implement a flag while omitting it from
`--help`. Claude Code registers `--max-turns` this way. Help inspection cannot
confirm such a flag, and it must not gate it either: dropping `--max-turns`
would remove the turn bound from every write call. Because a probe cannot cover
these, `--doctor` checks the installed release against
`CLAUDE_MINIMUM_VERSION`, the oldest Claude Code that Agent Bridge is tested
against, and fails below it. That floor is a tested minimum rather than the
release that introduced any particular flag; raise it when a hidden dependency
is known to be newer. An unreadable version number is reported as unverified
instead of passing silently.

**Optional capabilities.** Used only when available, probed once per session
from the CLI's own help output, and omitted when absent; a failed probe omits
them rather than risking a rejected call. Claude's are `--safe-mode`, which
excludes the target project's discovered customizations — CLAUDE.md, hooks,
plugins, and MCP servers — from an agent turn, and `--ax-screen-reader`, its
native accessible renderer. A test may assert that an optional flag is gated,
never that it is permanently absent.

A dry run stays side-effect free: it launches nothing, including the capability
probe, so it prints the version-independent command without capability-gated
flags. Adapters keep argument construction in a pure function so both the dry
run and the gate stay testable without a provider CLI installed.

## Retry behavior

Read-only calls may retry a small allowlist of transient failures. Write calls
never retry. Timeout and cancellation must terminate the provider process tree.

Before a provider-backed session begins, both adapters must pass a lightweight
version check. A failed check names the unavailable provider and directs the
user to `agent-bridge --doctor`; one-shot editing performs this check before
creating an isolated workspace, and a resumed run or chat performs it only
after confirming exclusive ownership of the checkpoint, so a run or chat
already active elsewhere reports that conflict rather than an unrelated
provider error. Provider calls retain fixed executables, argument-array
execution, and `shell: false` at the Agent Bridge boundary, including escaped
npm `.cmd` shim resolution on Windows.

## Adding a provider

1. Implement the provider interface without changing the orchestrator.
2. Require schema-constrained responses.
3. Define explicit read and write permission mappings.
4. Implement independent version and auth diagnostics.
5. Add dry-run assertions for every generated command.
6. Normalize only safe, documented streaming events and keep the final
   structured response authoritative.
7. Test split event chunks, output wrappers, malformed responses, timeout, and
   cancellation without invoking a real subscription call.
