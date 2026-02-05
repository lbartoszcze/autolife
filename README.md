# Autlife Intervention

Intervention-only repository containing the Autlife life-coach engine and tests.

## Quick Start

```bash
pnpm install
pnpm test
```

## Run the Orchestrator on Your Data

```bash
pnpm run:intervention -- --source /absolute/path/to/transcript.jsonl
```

Optional flags:
- `--agent <id>`: agent id used for isolated state (default: `main`)
- `--state-dir <path>`: state directory (stores orchestrator state/trace)
- `--trace-file <path>`: custom trace JSONL output file
- `--cooldown-minutes <n>`: cooldown gate window
- `--max-nudges-per-day <n>`: pacing gate limit
- `--record`: persist state between runs (off by default)

Input format:
- JSONL with entries containing `role` + `text`
- or OpenAI-style `type: "message"` lines with `message.role` and text content
- plain text files are treated as user messages

## One-Command Demo

```bash
pnpm run:intervention -- --source /Users/lukaszbartoszcze/Documents/Autlife/autolife/demo/demo-transcript.jsonl --agent demo-live --state-dir /tmp/autolife-demo-live --record
```

The CLI prints:
- gate decision (`should_nudge`, `reason`)
- selected intervention (`selected_action`, `follow_up_minutes`)
- judge-friendly summary (`state_top_needs`, `forecast_baseline`, `forecast_with_intervention`, `evidence_links`)

## Architecture

The system is now a dynamic multi-agent pipeline:

1. `PreferenceAgent`: infers objective weights + intervention affinity from language/outcomes.
2. `StateAgent`: builds current-state from transcript + extensible data-source adapters.
3. `EvidenceAgent`: retrieves and ranks references with source links.
4. `ForecastAgent`: predicts baseline vs intervention-adjusted trajectory.
5. `InterventionAgent`: synthesizes ranked, measurable interventions dynamically.
6. `Orchestrator`: applies cooldown/pacing/safety gates and emits a deterministic trace.

## Parallel Codex Streams

Create all stream worktrees in one command:

```bash
./scripts/setup-worktrees.sh
```

Coordination docs for parallel execution live in `coordination/README.md`.
