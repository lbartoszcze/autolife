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

## Rules

1. Do not edit files owned by another stream.
2. Use `coordination/contracts.md` for shared types and payload contracts.
3. Rebase from `main` before opening a PR.
4. Push every 60 to 90 minutes.
5. Integrator merges in this order:
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

## Files in This Folder

- `coordination/streams.md`: boundaries, deliverables, and owned files.
- `coordination/contracts.md`: frozen interfaces each stream must follow.
- `coordination/session-prompts.md`: copy-paste prompts to start each Codex session.
