import fs from "node:fs/promises";
import path from "node:path";
import { createWorkspaceAgentClients, runOrchestrator, type TranscriptMessage } from "../orchestrator/index.js";
import type { OrchestratorDecision } from "../contracts.js";

export type HeartbeatLifeCoachConfig = {
  enabled?: boolean;
  cooldownMinutes?: number;
  maxNudgesPerDay?: number;
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
  intervention: string;
  score: number;
  rationale: string;
  action: string;
  fallback: string;
  followUpMinutes: number;
  orchestrator: OrchestratorDecision;
};

export type LifeCoachHeartbeatPlan = {
  prompt: string;
  decision?: LifeCoachDecision;
};

function parseMessageLine(raw: string): TranscriptMessage[] {
  const line = raw.trim();
  if (!line) {
    return [];
  }

  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if ((parsed.role === "user" || parsed.role === "assistant") && typeof parsed.text === "string") {
      return [
        {
          role: parsed.role,
          text: parsed.text,
          timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : Date.now(),
        },
      ];
    }

    if (parsed.type === "message" && parsed.message && typeof parsed.message === "object") {
      const message = parsed.message as {
        role?: unknown;
        timestamp?: unknown;
        content?: unknown;
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
    return [{ role: "user", text: line, timestamp: Date.now() }];
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
    messages.push(...parseMessageLine(line));
  }
  return messages.slice(-300);
}

function resolveStateBase(cfg: LifeCoachConfig): string {
  const fromEnv = process.env.AUTLIFE_STATE_DIR?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }
  const workspace = cfg.agents?.defaults?.workspace?.trim();
  if (workspace) {
    return path.resolve(workspace, ".autlife");
  }
  return path.resolve(process.cwd(), ".autlife");
}

export async function createLifeCoachHeartbeatPlan(params: {
  cfg: LifeCoachConfig;
  agentId: string;
  basePrompt: string;
  sessionEntry?: SessionEntry;
  lifeCoach?: HeartbeatLifeCoachConfig;
}): Promise<LifeCoachHeartbeatPlan> {
  if (params.lifeCoach?.enabled === false) {
    return { prompt: params.basePrompt };
  }

  const messages = await readSessionMessages(params.sessionEntry?.sessionFile);
  const clients = await createWorkspaceAgentClients();
  const stateBase = resolveStateBase(params.cfg);

  const { decision, trace } = await runOrchestrator({
    input: {
      agentId: params.agentId,
      messages,
      cooldownMinutes: params.lifeCoach?.cooldownMinutes,
      maxNudgesPerDay: params.lifeCoach?.maxNudgesPerDay,
      stateFile: path.resolve(stateBase, "orchestrator-state.json"),
      traceFile: path.resolve(stateBase, "orchestrator-trace.jsonl"),
      sessionId: params.sessionEntry?.sessionId,
    },
    clients,
  });

  const selected = decision.selected;
  const lifeCoachDecision: LifeCoachDecision | undefined = selected
    ? {
        phase: "initial",
        intervention: selected.id,
        score: trace.scores.forecastConfidence,
        rationale: decision.reason,
        action: selected.action,
        fallback: selected.rationale,
        followUpMinutes: selected.followUpMinutes,
        orchestrator: decision,
      }
    : undefined;

  const prompt =
    `${params.basePrompt}\n\n[AUTOLIFE ORCHESTRATOR]\n` +
    `shouldNudge=${decision.shouldNudge}\n` +
    `reason=${decision.reason}\n` +
    `traceId=${decision.traceId}\n` +
    `${selected ? `selected=${selected.id}\naction=${selected.action}\nfollowUpMinutes=${selected.followUpMinutes}` : "selected=none"}`;

  return {
    prompt,
    decision: lifeCoachDecision,
  };
}

export async function recordLifeCoachDispatch(params: {
  agentId: string;
  decision?: LifeCoachDecision;
}): Promise<void> {
  if (!params.decision) {
    return;
  }
  const base = process.env.AUTLIFE_STATE_DIR?.trim()
    ? path.resolve(process.env.AUTLIFE_STATE_DIR)
    : path.resolve(process.cwd(), ".autlife");
  const file = path.resolve(base, "life-coach-dispatch-log.jsonl");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(
    file,
    `${JSON.stringify({
      agentId: params.agentId,
      intervention: params.decision.intervention,
      timestamp: Date.now(),
    })}\n`,
    "utf-8",
  );
}

export const __lifeCoachTestUtils = {
  parseMessageLine,
  readSessionMessages,
};
