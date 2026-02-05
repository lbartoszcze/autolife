#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLifeCoachHeartbeatPlan, recordLifeCoachDispatch } from "../src/infra/life-coach.js";
import type { LifeCoachConfig } from "../src/infra/life-coach.js";

type Role = "user" | "assistant";

type TranscriptMessage = {
  role: Role;
  text: string;
  timestamp: number;
};

type RunOptions = {
  source?: string;
  agentId: string;
  stateDir?: string;
  record: boolean;
  basePrompt: string;
};

function parseArgs(argv: string[]): RunOptions {
  const opts: RunOptions = {
    agentId: "main",
    record: false,
    basePrompt: "Run the orchestrator and produce a safe, paced decision.",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source" && argv[i + 1]) {
      opts.source = argv[++i];
      continue;
    }
    if (arg === "--agent" && argv[i + 1]) {
      opts.agentId = argv[++i];
      continue;
    }
    if (arg === "--state-dir" && argv[i + 1]) {
      opts.stateDir = argv[++i];
      continue;
    }
    if (arg === "--base-prompt" && argv[i + 1]) {
      opts.basePrompt = argv[++i];
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
    if (parsed.role === "user" || parsed.role === "assistant") {
      const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
      if (!text) {
        return [];
      }
      return [{ role: parsed.role, text, timestamp: Date.now() }];
    }
    if (parsed.type === "message" && parsed.message && typeof parsed.message === "object") {
      const msg = parsed.message as { role?: unknown; content?: unknown; timestamp?: unknown };
      const role = msg.role === "user" ? "user" : msg.role === "assistant" ? "assistant" : undefined;
      if (!role) {
        return [];
      }
      let text = "";
      if (Array.isArray(msg.content)) {
        text = msg.content
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
      }
      if (!text) {
        return [];
      }
      const ts = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
      return [{ role, text, timestamp: ts }];
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

async function loadMessages(source: string): Promise<TranscriptMessage[]> {
  const raw = await fs.readFile(source, "utf-8");
  const lines = raw.split(/\r?\n/);
  const messages: TranscriptMessage[] = [];
  for (const line of lines) {
    messages.push(...parseLine(line));
  }
  return messages.slice(-200);
}

async function writeTempSession(messages: TranscriptMessage[]): Promise<string> {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "autlife-orchestrator-"));
  const sessionFile = path.join(runDir, "session.jsonl");
  const rows = messages.map((message) =>
    JSON.stringify({
      type: "message",
      timestamp: message.timestamp,
      message: {
        role: message.role,
        timestamp: message.timestamp,
        content: [{ type: "text", text: message.text }],
      },
    }),
  );
  await fs.writeFile(sessionFile, `${rows.join("\n")}\n`, "utf-8");
  return sessionFile;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.source) {
    throw new Error("Missing required --source /absolute/path/to/transcript");
  }

  const sourcePath = path.resolve(opts.source);
  if (opts.stateDir) {
    process.env.AUTLIFE_STATE_DIR = path.resolve(opts.stateDir);
  }

  const messages = await loadMessages(sourcePath);
  if (messages.length === 0) {
    throw new Error(`No messages parsed from: ${sourcePath}`);
  }

  const sessionFile = await writeTempSession(messages);
  const cfg: LifeCoachConfig = {
    agents: {
      defaults: {
        workspace: path.dirname(sourcePath),
      },
    },
  };

  const plan = await createLifeCoachHeartbeatPlan({
    cfg,
    agentId: opts.agentId,
    basePrompt: opts.basePrompt,
    sessionEntry: {
      sessionFile,
    },
    lifeCoach: {
      enabled: true,
      cooldownMinutes: 60,
      maxNudgesPerDay: 3,
      science: {
        enabled: true,
        mode: "dynamic",
      },
    },
  });

  if (opts.record && plan.decision) {
    await recordLifeCoachDispatch({
      agentId: opts.agentId,
      decision: plan.decision,
    });
  }

  console.log("Autlife orchestrator run complete.");
  console.log(`source=${sourcePath}`);
  console.log(`agent=${opts.agentId}`);
  console.log(`messages=${messages.length}`);
  console.log(`decision_intervention=${plan.decision?.intervention ?? "none"}`);
  console.log(`should_nudge=${plan.decision?.orchestrator.shouldNudge ?? false}`);
  console.log(`trace_id=${plan.decision?.orchestrator.traceId ?? "none"}`);
  console.log("--- prompt ---");
  console.log(plan.prompt);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
