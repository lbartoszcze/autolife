#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-/Users/lukaszbartoszcze/Documents/Autlife}"
REPO="$ROOT/autolife"

if [ ! -d "$REPO/.git" ]; then
  echo "Repository not found at: $REPO" >&2
  exit 1
fi

GIT_BIN="$(command -v git)"
if [ -z "$GIT_BIN" ]; then
  echo "git is required" >&2
  exit 1
fi

cd "$REPO"

add_worktree() {
  local name="$1"
  local branch="$2"
  local path="$ROOT/$name"

  if [ -d "$path/.git" ] || [ -f "$path/.git" ]; then
    echo "skip: $path already exists"
    return 0
  fi

  if "$GIT_BIN" show-ref --verify --quiet "refs/heads/$branch"; then
    echo "add: $path from existing $branch"
    "$GIT_BIN" worktree add "$path" "$branch"
  else
    echo "create: $path on $branch from main"
    "$GIT_BIN" worktree add "$path" -b "$branch" main
  fi
}

add_worktree autolife-pref codex/pref-agent
add_worktree autolife-state codex/state-agent
add_worktree autolife-evidence codex/evidence-agent
add_worktree autolife-forecast codex/forecast-agent
add_worktree autolife-intervention codex/intervention-agent
add_worktree autolife-orchestrator codex/orchestrator
add_worktree autolife-qa codex/qa

"$GIT_BIN" worktree list
