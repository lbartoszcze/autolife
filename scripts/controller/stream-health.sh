#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-/Users/lukaszbartoszcze/Documents/Autlife}"
RUN_CHECKS="${RUN_CHECKS:-0}"

stream_rows=(
  "pref-agent|codex/pref-agent|$ROOT/autolife-pref"
  "state-agent|codex/state-agent|$ROOT/autolife-state"
  "evidence-agent|codex/evidence-agent|$ROOT/autolife-evidence"
  "forecast-agent|codex/forecast-agent|$ROOT/autolife-forecast"
  "intervention-agent|codex/intervention-agent|$ROOT/autolife-intervention"
  "orchestrator|codex/orchestrator|$ROOT/autolife-orchestrator"
  "qa|codex/qa|$ROOT/autolife-qa"
)

print_header() {
  echo "# Stream Health"
  date '+Generated: %Y-%m-%d %H:%M:%S %Z'
  echo
}

check_stream() {
  local name="$1"
  local branch="$2"
  local wt="$3"

  echo "## $name"
  echo "- branch: $branch"
  echo "- worktree: $wt"

  if [[ ! -d "$wt/.git" && ! -f "$wt/.git" ]]; then
    echo "- exists: no"
    echo "- status: missing"
    echo
    return 0
  fi

  local head upstream status_count
  head="$(git -C "$wt" rev-parse --short HEAD 2>/dev/null || echo '?')"
  upstream="$(git -C "$wt" rev-parse --abbrev-ref --symbolic-full-name @{upstream} 2>/dev/null || echo '-')"
  status_count="$(git -C "$wt" status --porcelain | wc -l | tr -d ' ')"

  echo "- exists: yes"
  echo "- head: $head"
  echo "- upstream: $upstream"
  echo "- dirty_files: $status_count"

  if [[ "$status_count" != "0" ]]; then
    echo "- changed_paths:"
    git -C "$wt" status --short | sed 's/^/  - /'
  fi

  if [[ "$RUN_CHECKS" == "1" ]]; then
    local ts_status test_status
    if (cd "$wt" && pnpm exec tsc --noEmit >/tmp/autlife_tsc_out.$$ 2>/tmp/autlife_tsc_err.$$); then
      ts_status="pass"
    else
      ts_status="fail"
    fi

    if (cd "$wt" && pnpm exec vitest run >/tmp/autlife_test_out.$$ 2>/tmp/autlife_test_err.$$); then
      test_status="pass"
    else
      test_status="fail"
    fi

    echo "- typecheck: $ts_status"
    if [[ "$ts_status" == "fail" ]]; then
      sed 's/^/  /' /tmp/autlife_tsc_err.$$ || true
    fi

    echo "- tests: $test_status"
    if [[ "$test_status" == "fail" ]]; then
      sed 's/^/  /' /tmp/autlife_test_out.$$ || true
      sed 's/^/  /' /tmp/autlife_test_err.$$ || true
    fi

    rm -f /tmp/autlife_tsc_out.$$ /tmp/autlife_tsc_err.$$ /tmp/autlife_test_out.$$ /tmp/autlife_test_err.$$ || true
  fi

  echo
}

print_header
for row in "${stream_rows[@]}"; do
  IFS='|' read -r name branch wt <<<"$row"
  check_stream "$name" "$branch" "$wt"
done
