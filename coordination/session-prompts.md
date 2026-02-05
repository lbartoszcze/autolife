# Session Kickoff Prompts

Use one prompt per Codex session, in the corresponding worktree.

## Preference Agent Session

Build the Preference Agent in this branch. Scope is `src/agents/preferences/**` and preference-specific logic in `src/infra/life-coach-extractors.ts`. Use dynamic objective ids from user text and outcomes, avoid hardcoded objective enums, add tests, and do not edit orchestration logic.

## State Agent Session

Build the State Agent in this branch. Scope is `src/agents/state/**` and state-specific logic in `src/infra/life-coach-extractors.ts`. Produce dynamic current-state extraction with confidence/freshness scores, add tests, and avoid evidence/intervention logic.

## Evidence Agent Session

Build the Evidence Agent in this branch. Scope is `src/agents/evidence/**` and science lookup sections in `src/infra/life-coach.ts`. Implement dynamic evidence retrieval and citation links, add tests, and avoid orchestrator changes.

## Forecast Agent Session

Build the Forecast Agent in this branch. Scope is `src/agents/forecast/**`. Implement baseline and intervention-adjusted future projection with assumptions and confidence, add tests, and avoid direct intervention ranking.

## Intervention Agent Session

Build the Intervention Agent in this branch. Scope is `src/agents/interventions/**` and intervention synthesis sections in `src/infra/life-coach.ts`. Generate and rank interventions dynamically from state + preferences + evidence, add tests, and avoid static intervention lists.

## Orchestrator Session

Build orchestrator composition in this branch. Scope is `src/orchestrator/**`, top-level integration in `src/infra/life-coach.ts`, and `scripts/run-intervention.ts`. Wire all agent outputs into a deterministic decision trace with cooldown/safety gating.

## QA Session

Build QA harness in this branch. Scope is tests and evaluation assets only. Add end-to-end coverage for objective extraction, state extraction, evidence citation presence, forecast transparency, and intervention safety.
