#!/bin/zsh

SCRIPT_DIRECTORY="${0:A:h}"
cd "$SCRIPT_DIRECTORY" || exit 1

if [[ $# -gt 0 && "$1" != -* ]]; then
  node --experimental-strip-types "$SCRIPT_DIRECTORY/src/cli.ts" --wizard --cwd "$1"
else
  node --experimental-strip-types "$SCRIPT_DIRECTORY/src/cli.ts" --wizard "$@"
fi
EXIT_CODE=$?

echo
read -r "?Press Return to close this window..."
exit "$EXIT_CODE"
