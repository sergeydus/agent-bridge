# Project configuration

Agent Bridge looks for `.agent-bridge.json` at the selected project root.
Use `--project-config <path>` to load a different file.

## Schema

```json
{
  "$schema": "./path/to/agent-bridge/schemas/project-config.schema.json",
  "version": 1,
  "verification": [
    {
      "command": "npm",
      "args": ["run", "check"],
      "timeoutMinutes": 20
    }
  ],
  "protectedPaths": [".env", "private"]
}
```

The optional `$schema` property enables editor completion when its path points
to `schemas/project-config.schema.json`.

Required properties:

- `version`: currently `1`
- `verification`: array of command objects
- `protectedPaths`: array of paths relative to the project root

A command contains a bare executable name, an argument array, and an optional
timeout from 1 to 180 minutes. Path separators in `command` are rejected.

## Trust

Configuration is parsed and displayed automatically, but commands do not run
until the user approves them in the wizard or passes
`--trust-project-config`.

Argument arrays and `shell: false` prevent shell interpolation. They do not
make project scripts harmless: `npm run check`, for example, executes code from
the selected project. Review configuration before trusting it.

Trusted commands run after each implementation pass and before read-only
review. Output is bounded and included as reviewer evidence. A failed command
does not suppress the review; it becomes an explicit finding for the agents.

## Protected paths

Each protected path is fingerprinted before the first writer and checked after
every implementation pass. Files, directories, and missing paths have stable
fingerprints. Symlinks, including symlinks nested in a protected directory,
are rejected because their external targets cannot be protected reliably.

The check detects modification and stops the workflow. Isolation keeps the
original checkout untouched; advanced direct-dirty mode also creates a
recovery patch because detection happens after the write. Protected paths are
not a confidentiality boundary: providers may still observe a protected file
if other task evidence includes it.

When direct dirty editing is explicitly allowed, Agent Bridge automatically
adds every pre-existing changed path to this protection set.
