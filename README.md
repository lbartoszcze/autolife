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
- `--video-out <path>`: explicit output path for rendered demo video (`.mp4`)
- `--no-render-video`: skip local mp4 rendering
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
- mentor comparison output (`mentor_figure`, `mentor_takeaway`, `mentor_links`)
- Sora video brief output (`sora_status`, `sora_title`, `sora_prompt`, `sora_call_to_action`)
- rendered local demo video output (`video_file`, `video_scenes`, `video_duration_seconds`)
- detected source coverage (`data_sources`)

## Architecture

The system is now a dynamic multi-agent pipeline:

1. `PreferenceAgent`: infers objective weights + intervention affinity from language/outcomes.
2. `StateAgent`: builds current-state from transcript + extensible data-source adapters.
3. `EvidenceAgent`: retrieves and ranks references with source links.
4. `ForecastAgent`: predicts baseline vs intervention-adjusted trajectory.
5. `InterventionAgent`: synthesizes ranked, measurable interventions dynamically.
6. `MentorEngine`: retrieves dynamic historical/reference comparisons from Wikidata/Wikipedia.
7. `VideoEngine`: builds Sora-ready video prompts/storyboards and can queue via webhook.
8. `Orchestrator`: applies cooldown/pacing/safety gates and emits a deterministic trace.

## External Data Sources

Set `AUTLIFE_DATA_SOURCES_FILE` to a JSON config to ingest external telemetry dynamically:

```json
{
  "health": { "path": "/absolute/path/health.json", "format": "json" },
  "gmail": { "path": "/absolute/path/gmail.jsonl", "format": "jsonl" },
  "messenger": { "path": "/absolute/path/messenger.txt", "format": "text" },
  "imessage": { "path": "/absolute/path/imessage.json", "format": "json" },
  "photos": { "path": "/absolute/path/photos.json", "format": "json" },
  "facebook": { "path": "/absolute/path/facebook.jsonl", "format": "jsonl" },
  "custom": [{ "kind": "notion", "path": "/absolute/path/notion-export.json", "format": "json" }]
}
```

Then run:

```bash
AUTLIFE_DATA_SOURCES_FILE=/absolute/path/data-sources.json pnpm run:intervention -- --source /absolute/path/to/transcript.jsonl --record
```

## Sora Integration

- `AUTLIFE_ENABLE_SORA_PLAN=1` (default) includes a Sora video brief in every selected intervention.
- `AUTLIFE_QUEUE_SORA=1` with `AUTLIFE_SORA_WEBHOOK_URL=https://...` sends the video plan to your render queue.

## Parallel Codex Streams

Create all stream worktrees in one command:

```bash
./scripts/setup-worktrees.sh
```

Coordination docs for parallel execution live in `coordination/README.md`.
