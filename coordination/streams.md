# Stream Boundaries

Each stream owns a strict area to avoid merge conflicts.

## Preference Agent

- Branch: `codex/pref-agent`
- Worktree: `/Users/lukaszbartoszcze/Documents/Autlife/autolife-pref`
- Owns:
  - `src/agents/preferences/**`
  - `src/infra/life-coach-extractors.ts` (preference functions only)
  - `src/agents/preferences/*.test.ts`
- Must deliver:
  - dynamic objective inference from user text
  - preference learning from outcomes
  - explicit confidence + recency handling

## State Agent

- Branch: `codex/state-agent`
- Worktree: `/Users/lukaszbartoszcze/Documents/Autlife/autolife-state`
- Owns:
  - `src/agents/state/**`
  - `src/infra/life-coach-extractors.ts` (state functions only)
  - `src/agents/state/*.test.ts`
- Must deliver:
  - current-state extraction (affect + needs)
  - input adapters for transcript and future telemetry
  - quality scores for freshness and completeness

## Evidence Agent

- Branch: `codex/evidence-agent`
- Worktree: `/Users/lukaszbartoszcze/Documents/Autlife/autolife-evidence`
- Owns:
  - `src/agents/evidence/**`
  - `src/infra/life-coach.ts` (science lookup sections only)
  - `src/agents/evidence/*.test.ts`
- Must deliver:
  - dynamic evidence retrieval pipeline
  - citation object model with source links
  - confidence scoring and deduplication

## Forecast Agent

- Branch: `codex/forecast-agent`
- Worktree: `/Users/lukaszbartoszcze/Documents/Autlife/autolife-forecast`
- Owns:
  - `src/agents/forecast/**`
  - `src/agents/forecast/*.test.ts`
- Must deliver:
  - baseline trajectory prediction
  - intervention-adjusted counterfactual prediction
  - transparent assumptions in structured output

## Intervention Agent

- Branch: `codex/intervention-agent`
- Worktree: `/Users/lukaszbartoszcze/Documents/Autlife/autolife-intervention`
- Owns:
  - `src/agents/interventions/**`
  - `src/infra/life-coach.ts` (intervention synthesis sections only)
  - `src/agents/interventions/*.test.ts`
- Must deliver:
  - dynamic intervention generation (no hardcoded objective/strategy lists)
  - ranking by user state + preference + evidence
  - action plan payload with measurable step

## Orchestrator

- Branch: `codex/orchestrator`
- Worktree: `/Users/lukaszbartoszcze/Documents/Autlife/autolife-orchestrator`
- Owns:
  - `src/orchestrator/**`
  - `src/infra/life-coach.ts` (top-level orchestration only)
  - `scripts/run-intervention.ts`
- Must deliver:
  - execution graph across agents
  - arbitration, cooldown, and safety gating
  - deterministic trace for each decision

## QA

- Branch: `codex/qa`
- Worktree: `/Users/lukaszbartoszcze/Documents/Autlife/autolife-qa`
- Owns:
  - `src/**/*.test.ts`
  - `tests/**`
  - `coordination/evals/**`
- Must deliver:
  - regression suite for end-to-end decision quality
  - adversarial tests for bad nudges and unsafe recommendations
  - merge-gate checklist for integrator

## Integrator Constraints

- Only integrator edits `main` directly.
- If two streams need the same file, split the file first before feature work.
- If a shared type changes, update `coordination/contracts.md` in the same PR.
