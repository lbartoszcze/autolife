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
