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

## Permissions

Read-only provider calls must use the strongest supported read-only mode.
Write permissions must be explicit and scoped to the selected workspace.
Provider-specific bypass flags are forbidden.

Claude write turns allow `Edit`, `Read`, `Write`, `Glob`, and `Grep`, without
Bash. Codex uses its workspace-write sandbox. Both receive instructions not to
run package, build, deploy, or version-control mutations; approved checks are
the coordinator's responsibility.

## Retry behavior

Read-only calls may retry a small allowlist of transient failures. Write calls
never retry. Timeout and cancellation must terminate the provider process tree.

## Adding a provider

1. Implement the provider interface without changing the orchestrator.
2. Require schema-constrained responses.
3. Define explicit read and write permission mappings.
4. Implement independent version and auth diagnostics.
5. Add dry-run assertions for every generated command.
6. Test output wrappers, malformed responses, timeout, and cancellation without
   invoking a real subscription call.
