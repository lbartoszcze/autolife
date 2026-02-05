# Stream Status

Updated: 2026-02-05
Controller: Codex (integration)

## Summary

| Stream | Branch | Head | Validation | Status | Notes |
|---|---|---:|---|---|---|
| Preference Agent | `codex/pref-agent` | `b1f503f` | typecheck/test pass | in progress | New preference module and integration added. |
| State Agent | `codex/state-agent` | `b1f503f` | typecheck/test pass | in progress | New state extraction + data-source model added. |
| Evidence Agent | `codex/evidence-agent` | `b1f503f` | typecheck/test pass | in progress | Evidence retrieval module added; integration still partial. |
| Forecast Agent | `codex/forecast-agent` | `b1f503f` | typecheck/test pass | in progress | Forecast module is present with tests. |
| Intervention Agent | `codex/intervention-agent` | `b1f503f` | typecheck/test pass | in progress | Intervention module is present with tests. |
| Orchestrator | `codex/orchestrator` | `b1f503f` | typecheck/test pass | queued | No orchestrator composition changes landed yet. |
| QA | `codex/qa` | `b1f503f` | typecheck/test pass | queued | No QA harness changes landed yet. |

## Active Blockers

1. Coordination docs are being modified in all stream worktrees, creating unnecessary merge noise.
2. Shared `src/contracts.ts` and `package.json` are being duplicated across multiple branches, which will increase merge conflicts if not normalized.

## Controller Actions

1. Keep coordination docs authoritative in `main`.
2. Strip coordination-only changes from stream branches before stream commits.
3. Merge order after stream fixes:
   1. `codex/pref-agent`
   2. `codex/state-agent`
   3. `codex/evidence-agent`
   4. `codex/forecast-agent`
   5. `codex/intervention-agent`
   6. `codex/orchestrator`
   7. `codex/qa`
