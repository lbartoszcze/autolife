# Stream Boundaries

Each stream owns a strict area to avoid merge conflicts and to keep responsibilities composable.

## Preference Agent

- Branch: `codex/pref-agent`
- Worktree: `/Users/lukaszbartoszcze/Documents/Autlife/autolife-pref`
- Owns:
  - `src/agents/preferences/**`
  - `src/infra/life-coach-extractors.ts` (preference functions only)
  - `src/agents/preferences/*.test.ts`
- Build:
  - dynamic preference inference and learning only
- Must deliver:
  - infer objective weights from user language
  - update intervention affinity from outcome feedback
  - apply recency decay
  - return `UserPreferenceProfile`
- Do not:
  - hardcode objective lists
  - hardcode intervention categories

## State Agent

- Branch: `codex/state-agent`
- Worktree: `/Users/lukaszbartoszcze/Documents/Autlife/autolife-state`
- Owns:
  - `src/agents/state/**`
  - `src/infra/life-coach-extractors.ts` (state functions only)
  - `src/agents/state/*.test.ts`
- Build:
  - current-state and data-source ingestion layer
- Must deliver:
  - `DataSourcesModel` transcript adapter first
  - extensible hooks for calendar, wearables, app usage, and location
  - computed needs, affect, freshness, and completeness
  - return `CurrentStateAssessment`
- Do not:
  - choose interventions

## Evidence Agent

- Branch: `codex/evidence-agent`
- Worktree: `/Users/lukaszbartoszcze/Documents/Autlife/autolife-evidence`
- Owns:
  - `src/agents/evidence/**`
  - `src/infra/life-coach.ts` (science lookup sections only)
  - `src/agents/evidence/*.test.ts`
- Build:
  - scientific evidence retrieval, scoring, and citation pipeline
- Must deliver:
  - fetch papers and guidelines dynamically by topic
  - rank confidence and deduplicate evidence
  - produce `EvidenceFinding` with real source links
- Do not:
  - use static local intervention catalogs as decision source of truth

## Forecast Agent

- Branch: `codex/forecast-agent`
- Worktree: `/Users/lukaszbartoszcze/Documents/Autlife/autolife-forecast`
- Owns:
  - `src/agents/forecast/**`
  - `src/agents/forecast/*.test.ts`
- Build:
  - future trajectory model
- Must deliver:
  - baseline and intervention-adjusted forecasts
  - explicit assumptions, confidence, and horizon
  - return `Forecast`
- Do not:
  - output prescriptive nudges directly

## Intervention Agent

- Branch: `codex/intervention-agent`
- Worktree: `/Users/lukaszbartoszcze/Documents/Autlife/autolife-intervention`
- Owns:
  - `src/agents/interventions/**`
  - `src/infra/life-coach.ts` (intervention synthesis sections only)
  - `src/agents/interventions/*.test.ts`
- Build:
  - dynamic intervention synthesis and ranking
- Must deliver:
  - generate candidate actions from state, preferences, evidence, and forecast
  - rank by expected impact, effort, and risk
  - return `InterventionPlan` with measurable action and follow-up window
- Do not:
  - hardcode fixed strategy families
  - hardcode objective enums

## Orchestrator

- Branch: `codex/orchestrator`
- Worktree: `/Users/lukaszbartoszcze/Documents/Autlife/autolife-orchestrator`
- Owns:
  - `src/orchestrator/**`
  - `src/infra/life-coach.ts` (top-level orchestration only)
  - `scripts/run-intervention.ts`
- Build:
  - end-to-end decision engine
- Must deliver:
  - call all agents
  - arbitrate conflicts
  - enforce cooldown, safety, and pacing
  - log deterministic trace
  - output `OrchestratorDecision`
  - integrate CLI runner
- Do not:
  - duplicate agent internals

## QA

- Branch: `codex/qa`
- Worktree: `/Users/lukaszbartoszcze/Documents/Autlife/autolife-qa`
- Owns:
  - `src/**/*.test.ts`
  - `tests/**`
  - `coordination/evals/**`
- Build:
  - quality gate and eval harness
- Must deliver:
  - unit, integration, and adversarial tests for dynamic behavior
  - citation presence checks
  - forecast transparency checks
  - unsafe recommendation blocking checks
- Do not:
  - change production logic outside test scaffolding

## Integrator Constraints

- Only integrator edits `main` directly.
- If two streams need the same file, split the file first before feature work.
- If a shared type changes, update `coordination/contracts.md` in the same PR.
- No hardcoded objective or strategy lists; dynamic inference only.
