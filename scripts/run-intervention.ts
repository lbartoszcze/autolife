#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkspaceAgentClients, runOrchestrator, type TranscriptMessage } from "../src/orchestrator/index.js";

type RunOptions = {
  source?: string;
  agentId: string;
  stateDir?: string;
  traceFile?: string;
  cooldownMinutes?: number;
  maxNudgesPerDay?: number;
  record: boolean;
};

function parseArgs(argv: string[]): RunOptions {
  const opts: RunOptions = {
    agentId: "main",
    record: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--source" && argv[index + 1]) {
      opts.source = argv[++index];
      continue;
    }
    if (arg === "--agent" && argv[index + 1]) {
      opts.agentId = argv[++index];
      continue;
    }
    if (arg === "--state-dir" && argv[index + 1]) {
      opts.stateDir = argv[++index];
      continue;
    }
    if (arg === "--trace-file" && argv[index + 1]) {
      opts.traceFile = argv[++index];
      continue;
    }
    if (arg === "--cooldown-minutes" && argv[index + 1]) {
      opts.cooldownMinutes = Number.parseInt(argv[++index], 10);
      continue;
    }
    if (arg === "--max-nudges-per-day" && argv[index + 1]) {
      opts.maxNudgesPerDay = Number.parseInt(argv[++index], 10);
      continue;
    }
    if (arg === "--record") {
      opts.record = true;
      continue;
    }
  }

  return opts;
}

function parseLine(line: string): TranscriptMessage[] {
  const trimmed = line.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if ((parsed.role === "user" || parsed.role === "assistant") && typeof parsed.text === "string") {
      return [
        {
          role: parsed.role,
          text: parsed.text.trim(),
          timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now(),
        },
      ];
    }

    if (parsed.type === "message" && parsed.message && typeof parsed.message === "object") {
      const message = parsed.message as { role?: unknown; timestamp?: unknown; content?: unknown };
      if (message.role !== "user" && message.role !== "assistant") {
        return [];
      }
      if (!Array.isArray(message.content)) {
        return [];
      }

      const text = message.content
        .map((entry) => {
          if (!entry || typeof entry !== "object") {
            return "";
          }
          const chunk = entry as { text?: unknown };
          return typeof chunk.text === "string" ? chunk.text : "";
        })
        .filter(Boolean)
        .join("\n")
        .trim();

      if (!text) {
        return [];
      }

      return [
        {
          role: message.role,
          text,
          timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
        },
      ];
    }
  } catch {
    const lowered = trimmed.toLowerCase();
    if (lowered.startsWith("user:")) {
      return [{ role: "user", text: trimmed.slice(5).trim(), timestamp: Date.now() }];
    }
    if (lowered.startsWith("assistant:")) {
      return [{ role: "assistant", text: trimmed.slice(10).trim(), timestamp: Date.now() }];
    }
    return [{ role: "user", text: trimmed, timestamp: Date.now() }];
  }

  return [];
}

async function loadMessages(sourcePath: string): Promise<TranscriptMessage[]> {
  const raw = await fs.readFile(sourcePath, "utf-8");
  const messages: TranscriptMessage[] = [];
  for (const line of raw.split(/\r?\n/)) {
    messages.push(...parseLine(line));
  }
  return messages.slice(-300);
}

function resolveStateFile(opts: RunOptions): string {
  if (!opts.record) {
    return path.resolve(os.tmpdir(), `autolife-orchestrator-state-${process.pid}.json`);
  }
  const base = opts.stateDir ? path.resolve(opts.stateDir) : path.resolve(process.cwd(), ".autlife");
  return path.resolve(base, "orchestrator-state.json");
}

function resolveTraceFile(opts: RunOptions): string {
  if (opts.traceFile) {
    return path.resolve(opts.traceFile);
  }
  const base = opts.stateDir ? path.resolve(opts.stateDir) : path.resolve(process.cwd(), ".autlife");
  return path.resolve(base, "orchestrator-trace.jsonl");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.source) {
    throw new Error("Missing required --source /absolute/path/to/transcript");
  }

  const sourcePath = path.resolve(opts.source);
  const messages = await loadMessages(sourcePath);
  if (messages.length === 0) {
    throw new Error(`No messages parsed from: ${sourcePath}`);
  }

  const clients = await createWorkspaceAgentClients();

  const { decision, trace } = await runOrchestrator({
    input: {
      agentId: opts.agentId,
      messages,
      cooldownMinutes: opts.cooldownMinutes,
      maxNudgesPerDay: opts.maxNudgesPerDay,
      stateFile: resolveStateFile(opts),
      traceFile: resolveTraceFile(opts),
      sessionId: path.basename(sourcePath),
    },
    clients,
  });

  console.log("Autlife orchestration run complete.");
  console.log(`source=${sourcePath}`);
  console.log(`agent=${opts.agentId}`);
  console.log(`messages=${messages.length}`);
  console.log(`should_nudge=${decision.shouldNudge}`);
  console.log(`reason=${decision.reason}`);
  console.log(`trace_id=${decision.traceId}`);
  if (decision.selected) {
    console.log(`selected_id=${decision.selected.id}`);
    console.log(`selected_action=${decision.selected.action}`);
    console.log(`follow_up_minutes=${decision.selected.followUpMinutes}`);
  }
  console.log("--- trace ---");
  console.log(JSON.stringify(trace, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
