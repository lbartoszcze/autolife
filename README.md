# Autlife Intervention

Intervention-only repository containing the Autlife life-coach engine and tests.

## Quick Start

```bash
pnpm install
pnpm test
```

## Run the Intervention on Your Data

```bash
pnpm run:intervention -- --source /absolute/path/to/transcript.jsonl
```

Optional flags:
- `--agent <id>`: agent id used for isolated state (default: `main`)
- `--state-dir <path>`: set custom state directory (writes `life-coach-state.json`)
- `--record`: persist dispatch history (off by default)
- `--base-prompt <text>`: override base prompt

Input format:
- JSONL with entries containing `role` + `text`
- or OpenAI-style `type: "message"` lines with `message.role` and text content
- plain text files are treated as user messages
