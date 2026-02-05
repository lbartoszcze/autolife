# 7. Per-Agent Work Plan

This plan defines implementation scope for each stream. Keep behavior dynamic and aligned to `coordination/contracts.md`.

## Preference Agent (`codex/pref-agent`)

- Worktree: `/Users/lukaszbartoszcze/Documents/Autlife/autolife-pref`
- Build: dynamic preference inference and learning only.
- Do:
  - infer objective weights from user language
  - update intervention affinity from outcome feedback
  - apply recency decay
  - return `UserPreferenceProfile` from `coordination/contracts.md`
- Do not:
  - hardcode objective lists
  - hardcode intervention categories

## State Agent (`codex/state-agent`)

- Worktree: `/Users/lukaszbartoszcze/Documents/Autlife/autolife-state`
- Build: current-state and data-source ingestion layer.
- Do:
  - create `DataSourcesModel` adapters (transcript first, then extensible hooks for calendar, wearables, app usage, and location)
  - compute needs, affect, freshness, and completeness
  - return `CurrentStateAssessment`
- Do not:
  - choose interventions

## Evidence Agent (`codex/evidence-agent`)

- Worktree: `/Users/lukaszbartoszcze/Documents/Autlife/autolife-evidence`
- Build: scientific evidence retrieval, scoring, and citation pipeline.
- Do:
  - fetch papers and guidelines dynamically by topic
  - rank confidence
  - deduplicate findings
  - produce `EvidenceFinding` with real source links
- Do not:
  - use static local intervention catalogs as decision source of truth

## Forecast Agent (`codex/forecast-agent`)

- Worktree: `/Users/lukaszbartoszcze/Documents/Autlife/autolife-forecast`
- Build: future trajectory model.
- Do:
  - generate baseline and intervention-adjusted forecasts
  - include assumptions, confidence, and horizon
  - return `Forecast`
- Do not:
  - output prescriptive nudges directly

## Intervention Agent (`codex/intervention-agent`)

- Worktree: `/Users/lukaszbartoszcze/Documents/Autlife/autolife-intervention`
- Build: dynamic intervention synthesis and ranking.
- Do:
  - generate candidate actions from state, preferences, evidence, and forecast
  - rank by expected impact, effort, and risk
  - return `InterventionPlan` with measurable action and follow-up window
- Do not:
  - hardcode fixed strategy families
  - hardcode objective enums

## Orchestrator Agent (`codex/orchestrator`)

- Worktree: `/Users/lukaszbartoszcze/Documents/Autlife/autolife-orchestrator`
- Build: end-to-end decision engine.
- Do:
  - call all agents
  - arbitrate conflicts
  - enforce cooldown, safety, and pacing
  - log deterministic trace
  - output `OrchestratorDecision`
  - integrate CLI runner
- Do not:
  - duplicate agent internals

## QA Agent (`codex/qa`)

- Worktree: `/Users/lukaszbartoszcze/Documents/Autlife/autolife-qa`
- Build: quality gate and eval harness.
- Do:
  - add unit, integration, and adversarial tests for dynamic behavior
  - verify citation presence
  - verify forecast transparency
  - verify unsafe recommendation blocking
- Do not:
  - change production logic outside test scaffolding

## Shared Rules for All Streams

- Use `coordination/contracts.md` as the interface contract.
- Follow ownership in `coordination/streams.md`.
- Use starter prompts in `coordination/session-prompts.md`.
- No hardcoded objective or strategy lists; dynamic inference only.
