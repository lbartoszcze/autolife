import fs from "node:fs/promises";
import path from "node:path";
import { buildUserPreferenceProfile, type PreferenceMessage, type PreferenceOutcome } from "../agents/preferences/preference-agent.js";
import type { UserPreferenceProfile } from "../contracts.js";

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
  intervention: "preference-profile";
  score: number;
  rationale: string;
  action: string;
  fallback: string;
  needs: Record<string, number>;
  profile: UserPreferenceProfile;
};

export type LifeCoachHeartbeatPlan = {
  prompt: string;
  decision?: LifeCoachDecision;
};

function parseMessageLine(raw: string): PreferenceMessage[] {
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
          timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : undefined,
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
    return [{ role: "user", text: line }];
  }

  return [];
}

async function readSessionMessages(sessionFile?: string): Promise<PreferenceMessage[]> {
  if (!sessionFile) {
    return [];
  }

  const raw = await fs.readFile(sessionFile, "utf-8");
  const messages: PreferenceMessage[] = [];
  for (const line of raw.split(/\r?\n/)) {
    messages.push(...parseMessageLine(line));
  }
  return messages;
}

function resolveStateFile(): string {
  const base = process.env.AUTLIFE_STATE_DIR?.trim();
  if (base) {
    return path.resolve(base, "pref-dispatch-log.jsonl");
  }
  return path.resolve(process.cwd(), ".autlife", "pref-dispatch-log.jsonl");
}

async function appendDispatchLog(entry: Record<string, unknown>): Promise<void> {
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
  outcomes?: PreferenceOutcome[];
  previous?: UserPreferenceProfile;
}): Promise<LifeCoachHeartbeatPlan> {
  if (params.lifeCoach?.enabled === false) {
    return {
      prompt: params.basePrompt,
    };
  }

  const messages = await readSessionMessages(params.sessionEntry.sessionFile);
  const profile = buildUserPreferenceProfile({
    messages,
    outcomes: params.outcomes,
    previous: params.previous,
  });

  return {
    prompt: `${params.basePrompt}\n[AUTOLIFE PREFERENCE PROFILE]\n${JSON.stringify(profile, null, 2)}`,
    decision: {
      phase: "initial",
      intervention: "preference-profile",
      score: profile.confidence,
      rationale: "Generated dynamic preference profile from transcript language and outcomes.",
      action: "Use profile.objectiveWeights and profile.interventionAffinity in downstream ranking.",
      fallback: "Collect more user language if confidence is low.",
      needs: profile.objectiveWeights,
      profile,
    },
  };
}

export async function recordLifeCoachDispatch(params: { agentId: string; decision: LifeCoachDecision }): Promise<void> {
  await appendDispatchLog({
    agentId: params.agentId,
    intervention: params.decision.intervention,
    score: params.decision.score,
    timestamp: Date.now(),
  });
}

export const __lifeCoachTestUtils = {
  parseMessageLine,
  readSessionMessages,
};
