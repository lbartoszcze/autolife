# Parallel Build Coordination

This folder is the source of truth for running multiple Codex sessions in parallel on Autlife.

## Active Streams

| Stream | Branch | Worktree |
|---|---|---|
| Preference Agent | `codex/pref-agent` | `/Users/lukaszbartoszcze/Documents/Autlife/autolife-pref` |
| State Agent | `codex/state-agent` | `/Users/lukaszbartoszcze/Documents/Autlife/autolife-state` |
| Evidence Agent | `codex/evidence-agent` | `/Users/lukaszbartoszcze/Documents/Autlife/autolife-evidence` |
| Forecast Agent | `codex/forecast-agent` | `/Users/lukaszbartoszcze/Documents/Autlife/autolife-forecast` |
| Intervention Agent | `codex/intervention-agent` | `/Users/lukaszbartoszcze/Documents/Autlife/autolife-intervention` |
| Orchestrator | `codex/orchestrator` | `/Users/lukaszbartoszcze/Documents/Autlife/autolife-orchestrator` |
| QA | `codex/qa` | `/Users/lukaszbartoszcze/Documents/Autlife/autolife-qa` |

## Execution Plan

1. Frozen Contracts: `coordination/contracts.md`
2. Per-Agent Work Plan: `coordination/per-agent-work-plan.md`
3. Session Prompts: `coordination/session-prompts.md`
4. Ownership Boundaries: `coordination/streams.md`

## Rules

1. Do not edit files owned by another stream.
2. Use `coordination/contracts.md` for shared types and payload contracts.
3. No hardcoded objective or strategy lists. Dynamic inference only.
4. Rebase from `main` before opening a PR.
5. Push every 60 to 90 minutes.
6. Integrator merges in this order:
   1. `pref-agent`
   2. `state-agent`
   3. `evidence-agent`
   4. `forecast-agent`
   5. `intervention-agent`
   6. `orchestrator`
   7. `qa`

## Required Local Validation

Run before each push:

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run
```

## Controller Ops

Generate a stream health report from `main`:

```bash
./scripts/controller/stream-health.sh
```

Run checks for every stream in the report:

```bash
RUN_CHECKS=1 ./scripts/controller/stream-health.sh
```

Remove coordination-file noise from a stream worktree:

```bash
./scripts/controller/sanitize-stream.sh /absolute/worktree/path
```

## Files in This Folder

- `coordination/contracts.md`: frozen interfaces each stream must follow.
- `coordination/per-agent-work-plan.md`: stream-specific Build/Do/Do-not plan.
- `coordination/status.md`: live controller status and blockers.
- `coordination/streams.md`: boundaries, deliverables, and owned files.
- `coordination/session-prompts.md`: copy-paste prompts to start each Codex session.
