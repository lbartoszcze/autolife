#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <worktree-path> [--restore-shared]" >&2
  echo "  --restore-shared: also restore package.json and remove local src/contracts.ts if untracked" >&2
  exit 1
fi

WT="$1"
RESTORE_SHARED="0"
if [[ "${2:-}" == "--restore-shared" ]]; then
  RESTORE_SHARED="1"
fi

if [[ ! -d "$WT" ]]; then
  echo "worktree not found: $WT" >&2
  exit 1
fi

GIT="$(command -v git)"

"$GIT" -C "$WT" restore coordination/README.md coordination/session-prompts.md coordination/streams.md || true
rm -f "$WT/coordination/per-agent-work-plan.md"

if [[ "$RESTORE_SHARED" == "1" ]]; then
  "$GIT" -C "$WT" restore package.json || true
  if "$GIT" -C "$WT" ls-files --others --exclude-standard src/contracts.ts >/dev/null 2>&1; then
    rm -f "$WT/src/contracts.ts"
  fi
fi

echo "sanitized: $WT"
"$GIT" -C "$WT" status --short
