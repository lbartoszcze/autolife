import fs from "node:fs/promises";
import path from "node:path";
import {
  buildCurrentStateAssessment,
  type TranscriptMessage,
} from "./life-coach-extractors.js";
import type { CurrentStateAssessment } from "../contracts.js";

export type HeartbeatLifeCoachConfig = {
  enabled?: boolean;
  science?: {
    enabled?: boolean;
    mode?: "dynamic" | "catalog" | "hybrid";
  };
};

export type LifeCoachConfig = {
  agents?: {
    defaults?: {
      workspace?: string;
    };
  };
};

export type SessionEntry = {
  sessionFile?: string;
  sessionId?: string;
  updatedAt?: number;
};

export type LifeCoachDecision = {
  phase: "initial";
  intervention: "state-assessment";
  score: number;
  rationale: string;
  action: string;
  fallback: string;
  needs: Record<string, number>;
  assessment: CurrentStateAssessment;
};

export type LifeCoachHeartbeatPlan = {
  prompt: string;
  decision?: LifeCoachDecision;
};

function parseSessionLine(line: string): TranscriptMessage[] {
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
          text: parsed.text,
          timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : undefined,
        },
      ];
    }

    if (parsed.type === "message" && parsed.message && typeof parsed.message === "object") {
      const message = parsed.message as {
        role?: unknown;
        content?: unknown;
        timestamp?: unknown;
      };
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
          const maybeText = (entry as { text?: unknown }).text;
          return typeof maybeText === "string" ? maybeText : "";
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
          timestamp: typeof message.timestamp === "number" ? message.timestamp : undefined,
        },
      ];
    }
  } catch {
    return [{ role: "user", text: trimmed }];
  }

  return [];
}

async function readSessionMessages(sessionFile?: string): Promise<TranscriptMessage[]> {
  if (!sessionFile) {
    return [];
  }
  const raw = await fs.readFile(sessionFile, "utf-8");
  const messages: TranscriptMessage[] = [];
  for (const line of raw.split(/\r?\n/)) {
    messages.push(...parseSessionLine(line));
  }
  return messages;
}

function resolveStateFile(): string {
  const root = process.env.AUTLIFE_STATE_DIR?.trim();
  if (root) {
    return path.resolve(root, "state-dispatch-log.jsonl");
  }
  return path.resolve(process.cwd(), ".autlife", "state-dispatch-log.jsonl");
}

async function appendDispatchLog(entry: Record<string, unknown>) {
  const file = resolveStateFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`, "utf-8");
}

export async function createLifeCoachHeartbeatPlan(params: {
  cfg: LifeCoachConfig;
  agentId: string;
  basePrompt: string;
  sessionEntry: SessionEntry;
  lifeCoach?: HeartbeatLifeCoachConfig;
  calendar?: Array<{ title: string; startAt: number; note?: string }>;
  wearables?: Array<{ capturedAt: number; summary: string }>;
  appUsage?: Array<{ capturedAt: number; summary: string }>;
  location?: Array<{ capturedAt: number; summary: string }>;
}): Promise<LifeCoachHeartbeatPlan> {
  if (params.lifeCoach?.enabled === false) {
    return { prompt: params.basePrompt };
  }

  const messages = await readSessionMessages(params.sessionEntry.sessionFile);
  const assessment = await buildCurrentStateAssessment({
    messages,
    calendar: params.calendar,
    wearables: params.wearables,
    appUsage: params.appUsage,
    location: params.location,
  });

  return {
    prompt: `${params.basePrompt}\n[AUTOLIFE CURRENT STATE]\n${JSON.stringify(assessment, null, 2)}`,
    decision: {
      phase: "initial",
      intervention: "state-assessment",
      score: 1 - assessment.freshness.ageMinutes / (assessment.freshness.ageMinutes + 60),
      rationale: "Computed dynamic state from transcript-first data ingestion.",
      action: "Pass CurrentStateAssessment to downstream evidence/forecast/intervention stages.",
      fallback: "Collect additional telemetry sources when completeness is low.",
      needs: assessment.needs,
      assessment,
    },
  };
}

export async function recordLifeCoachDispatch(params: { agentId: string; decision: LifeCoachDecision }): Promise<void> {
  await appendDispatchLog({
    agentId: params.agentId,
    intervention: params.decision.intervention,
    timestamp: Date.now(),
    score: params.decision.score,
  });
}

export const __lifeCoachTestUtils = {
  parseSessionLine,
  readSessionMessages,
};
