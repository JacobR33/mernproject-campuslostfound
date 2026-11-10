#!/usr/bin/env bash
set -euo pipefail

# Run from any directory on the Ubuntu Droplet.
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # nvm is not always loaded in non-interactive SSH sessions.
    set +u
    source "$HOME/.nvm/nvm.sh"
    set -u
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is missing. Load nvm and run: nvm use 22" >&2
  exit 1
fi

exec node "$project_dir/server/scripts/demo.cjs" "$@"
