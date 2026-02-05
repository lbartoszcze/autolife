import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CurrentStateAssessment,
  EvidenceFinding,
  Forecast,
  InterventionPlan,
  OrchestratorDecision,
  UserPreferenceProfile,
} from "../contracts.js";

export type TranscriptMessage = {
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
};

export type AgentBundle = {
  preference: {
    inferProfile(input: { messages: TranscriptMessage[]; nowMs: number }): Promise<UserPreferenceProfile>;
  };
  state: {
    assess(input: { messages: TranscriptMessage[]; nowMs: number }): Promise<CurrentStateAssessment>;
  };
  evidence: {
    find(input: {
      state: CurrentStateAssessment;
      preferences: UserPreferenceProfile;
      topics: string[];
      nowMs: number;
    }): Promise<EvidenceFinding[]>;
  };
  forecast: {
    project(input: {
      state: CurrentStateAssessment;
      preferences: UserPreferenceProfile;
      evidence: EvidenceFinding[];
      nowMs: number;
    }): Promise<Forecast>;
  };
  intervention: {
    synthesize(input: {
      state: CurrentStateAssessment;
      preferences: UserPreferenceProfile;
      evidence: EvidenceFinding[];
      forecast: Forecast;
      nowMs: number;
    }): Promise<{ selected: InterventionPlan; alternatives: InterventionPlan[] }>;
  };
};

export type OrchestratorInput = {
  agentId: string;
  messages: TranscriptMessage[];
  agents: AgentBundle;
  nowMs?: number;
  cooldownMinutes?: number;
  maxNudgesPerDay?: number;
  topicHints?: string[];
  stateDir?: string;
};

export type OrchestratorAgentClients = {
  preference(params: { messages: TranscriptMessage[]; now: number }): Promise<UserPreferenceProfile>;
  state(params: { messages: TranscriptMessage[]; now: number }): Promise<CurrentStateAssessment>;
  evidence(params: {
    messages?: TranscriptMessage[];
    state: CurrentStateAssessment;
    preferences: UserPreferenceProfile;
    topics: string[];
    now: number;
  }): Promise<EvidenceFinding[]>;
  forecast(params: {
    state: CurrentStateAssessment;
    preferences: UserPreferenceProfile;
    evidence: EvidenceFinding[];
    now: number;
  }): Promise<Forecast>;
  intervention(params: {
    state: CurrentStateAssessment;
    preferences: UserPreferenceProfile;
    evidence: EvidenceFinding[];
    forecast: Forecast;
    now: number;
  }): Promise<{
    selected?: InterventionPlan;
    alternatives?: InterventionPlan[];
    ranked?: Array<InterventionPlan & { score?: number }>;
  }>;
};

export type OrchestratorRunInput = {
  agentId: string;
  messages: TranscriptMessage[];
  now?: number;
  cooldownMinutes?: number;
  maxNudgesPerDay?: number;
  stateFile?: string;
  traceFile?: string;
  sessionId?: string;
  topicHints?: string[];
};

export type OrchestratorTrace = {
  traceId: string;
  summary: string;
  gates: {
    cooldownBlocked: boolean;
    pacingBlocked: boolean;
    safetyBlocked: boolean;
  };
  scores: {
    stateCompleteness: number;
    forecastConfidence: number;
    selectedEvidenceConfidence: number;
  };
  selectedInterventionId?: string;
};

type OrchestratorState = {
  lastDispatchByAgent: Record<string, number>;
  dailyDispatchByAgent: Record<string, { date: string; count: number }>;
};

const DEFAULT_STATE: OrchestratorState = {
  lastDispatchByAgent: {},
  dailyDispatchByAgent: {},
};

const UNSAFE_ACTION_PATTERNS = [
  /\boverdose\b/i,
  /\bself-harm\b/i,
  /\bsuicide\b/i,
  /\billegal\b/i,
  /\bviolent\b/i,
  /\bopioid\b/i,
];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeId(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "main"
  );
}

function resolveStateRoot(override?: string): string {
  if (override?.trim()) {
    return path.resolve(override.trim());
  }
  if (process.env.AUTLIFE_STATE_DIR?.trim()) {
    return path.resolve(process.env.AUTLIFE_STATE_DIR.trim());
  }
  return path.join(os.homedir(), ".autlife");
}

function stateFilePath(root: string): string {
  return path.join(root, "orchestrator-state.json");
}

function traceFilePath(root: string): string {
  return path.join(root, "orchestrator-trace.jsonl");
}

async function readState(root: string): Promise<OrchestratorState> {
  try {
    const raw = await fs.readFile(stateFilePath(root), "utf-8");
    const parsed = JSON.parse(raw) as Partial<OrchestratorState>;
    return {
      lastDispatchByAgent: parsed.lastDispatchByAgent ?? {},
      dailyDispatchByAgent: parsed.dailyDispatchByAgent ?? {},
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

async function writeState(root: string, state: OrchestratorState): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(stateFilePath(root), JSON.stringify(state, null, 2), "utf-8");
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalStringify(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalStringify(entry)}`).join(",")}}`;
}

function createTraceId(payload: unknown): string {
  return crypto.createHash("sha256").update(canonicalStringify(payload)).digest("hex").slice(0, 16);
}

async function appendTrace(root: string, payload: Record<string, unknown>): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.appendFile(traceFilePath(root), `${JSON.stringify(payload)}\n`, "utf-8");
}

function topKeys(scores: Record<string, number>, limit: number): string[] {
  return Object.entries(scores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key]) => key);
}

function pickTopics(params: {
  state: CurrentStateAssessment;
  preferences: UserPreferenceProfile;
  hints?: string[];
}): string[] {
  const topics = new Set<string>();

  for (const objective of topKeys(params.state.needs, 3)) {
    topics.add(objective);
  }
  for (const objective of topKeys(params.preferences.objectiveWeights, 2)) {
    topics.add(objective);
  }
  for (const hint of params.hints ?? []) {
    topics.add(normalizeId(hint));
  }

  if (topics.size === 0) {
    topics.add("general");
  }
  return [...topics];
}

function isUnsafePlan(plan: InterventionPlan | undefined): boolean {
  if (!plan) {
    return false;
  }
  return UNSAFE_ACTION_PATTERNS.some((pattern) => pattern.test(plan.action) || pattern.test(plan.rationale));
}

function arbitratePlan(params: {
  state: CurrentStateAssessment;
  selected: InterventionPlan;
  alternatives: InterventionPlan[];
}): InterventionPlan {
  const topNeeds = new Set(topKeys(params.state.needs, 3));
  if (params.selected.objectiveIds.some((id) => topNeeds.has(id))) {
    return params.selected;
  }
  const fallback = params.alternatives.find((candidate) => candidate.objectiveIds.some((id) => topNeeds.has(id)));
  return fallback ?? params.selected;
}

function dayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

async function readLastTracePayload(root: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await fs.readFile(traceFilePath(root), "utf-8");
    const lastLine = raw
      .trim()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (!lastLine) {
      return undefined;
    }
    const parsed = JSON.parse(lastLine) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function extractTraceNumber(root: Record<string, unknown> | undefined, pathParts: string[]): number {
  let cursor: unknown = root;
  for (const part of pathParts) {
    if (!cursor || typeof cursor !== "object") {
      return 0;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return typeof cursor === "number" && Number.isFinite(cursor) ? cursor : 0;
}

function extractEvidenceConfidence(payload: Record<string, unknown> | undefined): number {
  const evidence = payload?.evidence;
  if (!Array.isArray(evidence)) {
    return 0;
  }

  const confidences = evidence
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return 0;
      }
      const value = (entry as Record<string, unknown>).confidence;
      return typeof value === "number" && Number.isFinite(value) ? value : 0;
    })
    .filter((value) => value > 0);

  if (confidences.length === 0) {
    return 0;
  }
  return Math.max(...confidences);
}

function toTrace(params: {
  decision: OrchestratorDecision;
  tracePayload?: Record<string, unknown>;
}): OrchestratorTrace {
  const reason = params.decision.reason.toLowerCase();
  return {
    traceId: params.decision.traceId,
    summary: params.decision.reason,
    gates: {
      cooldownBlocked: reason.includes("cooldown"),
      pacingBlocked: reason.includes("daily"),
      safetyBlocked: reason.includes("safety"),
    },
    scores: {
      stateCompleteness: clamp01(extractTraceNumber(params.tracePayload, ["state", "freshness", "completeness"])),
      forecastConfidence: clamp01(extractTraceNumber(params.tracePayload, ["forecast", "confidence"])),
      selectedEvidenceConfidence: clamp01(extractEvidenceConfidence(params.tracePayload)),
    },
    selectedInterventionId: params.decision.selected?.id,
  };
}

function fallbackIntervention(nowMs: number): InterventionPlan {
  return {
    id: `dyn:general:${nowMs}`,
    objectiveIds: ["general"],
    action: "Do one 10-minute stabilization step and log completion.",
    rationale: "Fallback selected because no dynamic intervention was returned.",
    expectedImpact: "Stabilize momentum and gather more signal.",
    effort: "low",
    followUpMinutes: 60,
    evidence: [],
  };
}

function adaptClients(clients: OrchestratorAgentClients, messages: TranscriptMessage[]): AgentBundle {
  return {
    preference: {
      inferProfile: async ({ messages: inputMessages, nowMs }) => clients.preference({ messages: inputMessages, now: nowMs }),
    },
    state: {
      assess: async ({ messages: inputMessages, nowMs }) => clients.state({ messages: inputMessages, now: nowMs }),
    },
    evidence: {
      find: async ({ state, preferences, topics, nowMs }) =>
        clients.evidence({
          messages,
          state,
          preferences,
          topics,
          now: nowMs,
        }),
    },
    forecast: {
      project: async ({ state, preferences, evidence, nowMs }) =>
        clients.forecast({
          state,
          preferences,
          evidence,
          now: nowMs,
        }),
    },
    intervention: {
      synthesize: async ({ state, preferences, evidence, forecast, nowMs }) => {
        const result = await clients.intervention({
          state,
          preferences,
          evidence,
          forecast,
          now: nowMs,
        });
        return {
          selected: result.selected ?? fallbackIntervention(nowMs),
          alternatives: result.alternatives ?? [],
        };
      },
    },
  };
}

export async function orchestrateDecision(input: OrchestratorInput): Promise<OrchestratorDecision> {
  const nowMs = input.nowMs ?? Date.now();
  const cooldownMinutes = Math.max(0, input.cooldownMinutes ?? 120);
  const maxNudgesPerDay = Math.max(1, input.maxNudgesPerDay ?? 3);
  const normalizedAgentId = normalizeId(input.agentId);
  const root = resolveStateRoot(input.stateDir);
  const persisted = await readState(root);

  const lastDispatch = persisted.lastDispatchByAgent[normalizedAgentId] ?? 0;
  if (lastDispatch > 0 && nowMs - lastDispatch < cooldownMinutes * 60_000) {
    const tracePayload = {
      agentId: normalizedAgentId,
      nowMs,
      reason: "cooldown",
      sinceLastMinutes: Math.round((nowMs - lastDispatch) / 60_000),
    };
    const traceId = createTraceId(tracePayload);
    await appendTrace(root, { traceId, ...tracePayload });
    return {
      shouldNudge: false,
      reason: `Cooldown active for agent ${normalizedAgentId}.`,
      traceId,
    };
  }

  const today = dayKey(nowMs);
  const daily = persisted.dailyDispatchByAgent[normalizedAgentId];
  const dailyCount = daily && daily.date === today ? daily.count : 0;
  if (dailyCount >= maxNudgesPerDay) {
    const tracePayload = {
      agentId: normalizedAgentId,
      nowMs,
      reason: "daily-limit",
      dailyCount,
      maxNudgesPerDay,
    };
    const traceId = createTraceId(tracePayload);
    await appendTrace(root, { traceId, ...tracePayload });
    return {
      shouldNudge: false,
      reason: `Daily pacing limit reached (${maxNudgesPerDay}).`,
      traceId,
    };
  }

  const [preferences, state] = await Promise.all([
    input.agents.preference.inferProfile({ messages: input.messages, nowMs }),
    input.agents.state.assess({ messages: input.messages, nowMs }),
  ]);

  const topics = pickTopics({
    state,
    preferences,
    hints: input.topicHints,
  });

  const evidence = await input.agents.evidence.find({
    state,
    preferences,
    topics,
    nowMs,
  });

  const forecast = await input.agents.forecast.project({
    state,
    preferences,
    evidence,
    nowMs,
  });

  const synthesized = await input.agents.intervention.synthesize({
    state,
    preferences,
    evidence,
    forecast,
    nowMs,
  });

  const selected = arbitratePlan({
    state,
    selected: synthesized.selected,
    alternatives: synthesized.alternatives,
  });

  const unsafe = isUnsafePlan(selected);
  const shouldNudge = !unsafe;

  const tracePayload = {
    agentId: normalizedAgentId,
    nowMs,
    topics,
    shouldNudge,
    reason: unsafe ? "unsafe" : "ok",
    state,
    preferences,
    evidence,
    forecast,
    selected,
    alternatives: synthesized.alternatives,
  };
  const traceId = createTraceId(tracePayload);
  await appendTrace(root, { traceId, ...tracePayload });

  if (shouldNudge) {
    persisted.lastDispatchByAgent[normalizedAgentId] = nowMs;
    persisted.dailyDispatchByAgent[normalizedAgentId] = {
      date: today,
      count: dailyCount + 1,
    };
    await writeState(root, persisted);
  }

  return {
    shouldNudge,
    reason: unsafe ? "Safety gate blocked unsafe action." : "All gates passed.",
    selected: shouldNudge ? selected : undefined,
    alternatives: shouldNudge ? synthesized.alternatives : undefined,
    traceId,
  };
}

export async function runOrchestrator(params: {
  input: OrchestratorRunInput;
  clients: OrchestratorAgentClients;
}): Promise<{ decision: OrchestratorDecision; trace: OrchestratorTrace }> {
  const nowMs = params.input.now ?? Date.now();
  const statePath = params.input.stateFile
    ? path.resolve(params.input.stateFile)
    : path.resolve(process.cwd(), ".autlife", "orchestrator-state.json");
  const root = path.dirname(statePath);
  const externalTracePath = params.input.traceFile ? path.resolve(params.input.traceFile) : undefined;

  const decision = await orchestrateDecision({
    agentId: params.input.agentId,
    messages: params.input.messages,
    nowMs,
    cooldownMinutes: params.input.cooldownMinutes,
    maxNudgesPerDay: params.input.maxNudgesPerDay,
    topicHints: params.input.topicHints,
    stateDir: root,
    agents: adaptClients(params.clients, params.input.messages),
  });

  const tracePayload = await readLastTracePayload(root);
  const trace = toTrace({ decision, tracePayload });

  if (externalTracePath && externalTracePath !== traceFilePath(root) && tracePayload) {
    await fs.mkdir(path.dirname(externalTracePath), { recursive: true });
    await fs.appendFile(externalTracePath, `${JSON.stringify(tracePayload)}\n`, "utf-8");
  }

  return { decision, trace };
}
