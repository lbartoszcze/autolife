# Session Kickoff Prompts

Use one prompt per Codex session, in the corresponding worktree.

## Preference Agent Session

Build the Preference Agent in this branch. Scope is `src/agents/preferences/**` and preference-specific logic in `src/infra/life-coach-extractors.ts`. Infer objective weights from user language, learn intervention affinity from outcome feedback, apply recency decay, and return `UserPreferenceProfile` from `coordination/contracts.md`. Do not hardcode objective lists or intervention categories. Add tests and avoid orchestration changes.

## State Agent Session

Build the State Agent in this branch. Scope is `src/agents/state/**` and state-specific logic in `src/infra/life-coach-extractors.ts`. Create a `DataSourcesModel` ingestion layer with transcript adapter first and extensible hooks for calendar, wearables, app usage, and location. Compute needs, affect, freshness, and completeness, and return `CurrentStateAssessment`. Do not choose interventions. Add tests.

## Evidence Agent Session

Build the Evidence Agent in this branch. Scope is `src/agents/evidence/**` and science lookup sections in `src/infra/life-coach.ts`. Implement dynamic retrieval of papers and guidelines by topic, confidence ranking, deduplication, and `EvidenceFinding` outputs with real source links. Do not use static local intervention catalogs as source of truth. Add tests and avoid orchestrator changes.

## Forecast Agent Session

Build the Forecast Agent in this branch. Scope is `src/agents/forecast/**`. Implement baseline and intervention-adjusted future projections with explicit assumptions, horizon, and confidence, and return `Forecast`. Do not output prescriptive nudges directly. Add tests.

## Intervention Agent Session

Build the Intervention Agent in this branch. Scope is `src/agents/interventions/**` and intervention synthesis sections in `src/infra/life-coach.ts`. Generate candidate actions dynamically from state, preferences, evidence, and forecast, rank by expected impact, effort, and risk, and return `InterventionPlan` with measurable action and follow-up window. Do not hardcode fixed strategy families or objective enums. Add tests.

## Orchestrator Session

Build orchestrator composition in this branch. Scope is `src/orchestrator/**`, top-level integration in `src/infra/life-coach.ts`, and `scripts/run-intervention.ts`. Call all agents, arbitrate conflicts, enforce cooldown, safety, and pacing, log deterministic trace, and output `OrchestratorDecision`. Do not duplicate agent internals.

## QA Session

Build QA harness in this branch. Scope is tests and evaluation assets only. Add unit, integration, and adversarial coverage for dynamic behavior, citation presence, forecast transparency, and unsafe recommendation blocking. Do not change production logic outside test scaffolding.
