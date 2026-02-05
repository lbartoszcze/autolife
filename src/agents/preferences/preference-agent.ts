import type { UserPreferenceProfile } from "../../contracts.js";

export type PreferenceRole = "user" | "assistant";

export type PreferenceMessage = {
  role: PreferenceRole;
  text: string;
  timestamp?: number;
};

export type PreferenceOutcome = {
  interventionId: string;
  outcome: "completed" | "helpful" | "ignored" | "rejected" | "harmful";
  timestamp?: number;
  intensity?: number;
};

export type PreferenceInferenceInput = {
  messages: PreferenceMessage[];
  outcomes?: PreferenceOutcome[];
  previous?: UserPreferenceProfile;
  now?: number;
  decayHalfLifeDays?: number;
};

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "about",
  "after",
  "also",
  "am",
  "are",
  "as",
  "because",
  "been",
  "being",
  "but",
  "could",
  "do",
  "for",
  "from",
  "have",
  "i",
  "im",
  "ive",
  "is",
  "just",
  "like",
  "my",
  "of",
  "on",
  "or",
  "more",
  "need",
  "our",
  "really",
  "so",
  "that",
  "the",
  "them",
  "they",
  "this",
  "to",
  "today",
  "want",
  "we",
  "with",
  "would",
  "you",
  "your",
]);

const OBJECTIVE_CUE_RE =
  /\b(?:want|need|trying to|goal(?: is)? to|aim to|focus on|work on|improve|reduce|stop|start)\s+([a-z0-9][a-z0-9\s'-]{2,70})/gi;

const SUPPORTIVE_CUES = ["please", "help", "thanks", "struggling", "overwhelmed", "anxious", "sad"];
const DIRECT_CUES = ["direct", "clear", "brief", "quick", "blunt", "concise", "just tell me"];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeId(input: string): string {
  return (
    input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "general"
  );
}

function messageTimestamp(message: PreferenceMessage, fallback: number): number {
  return typeof message.timestamp === "number" ? message.timestamp : fallback;
}

function eventWeight(params: { ts: number; now: number; halfLifeMs: number }): number {
  const age = Math.max(0, params.now - params.ts);
  return Math.exp(-age / Math.max(1, params.halfLifeMs));
}

function extractTokens(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) ?? [];
  return tokens.filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function extractObjectivePhrases(text: string): string[] {
  const matches: string[] = [];
  const lowered = text.toLowerCase();
  const matcher = lowered.matchAll(OBJECTIVE_CUE_RE);
  for (const entry of matcher) {
    const rawPhrase = (entry[1] ?? "").trim();
    if (!rawPhrase) {
      continue;
    }

    const fragments = rawPhrase
      .split(/\b(?:and|then)\s+(?:i\s+)?(?:need|want|focus on|work on|improve|reduce|stop|start)\b/gi)
      .map((fragment) => fragment.trim())
      .filter(Boolean);

    for (const fragment of fragments.length ? fragments : [rawPhrase]) {
      const words = fragment.split(/\s+/).slice(0, 5);
      if (words.length === 0) {
        continue;
      }
      matches.push(normalizeId(words.join(" ")));
    }
  }
  return matches;
}

function normalizeWeights(raw: Record<string, number>, limit = 8): Record<string, number> {
  const ranked = Object.entries(raw)
    .filter((entry) => entry[1] > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  if (ranked.length === 0) {
    return { general: 1 };
  }

  const total = ranked.reduce((sum, entry) => sum + entry[1], 0);
  if (total <= 0) {
    return { general: 1 };
  }

  const normalized: Record<string, number> = {};
  for (const [key, value] of ranked) {
    normalized[key] = Number((value / total).toFixed(4));
  }
  return normalized;
}

function inferObjectiveWeights(params: {
  messages: PreferenceMessage[];
  previous?: Record<string, number>;
  now: number;
  halfLifeMs: number;
}): Record<string, number> {
  const map: Record<string, number> = {};

  for (const [objectiveId, score] of Object.entries(params.previous ?? {})) {
    const normalized = normalizeId(objectiveId);
    map[normalized] = (map[normalized] ?? 0) + score * 0.35;
  }

  const userMessages = params.messages.filter((message) => message.role === "user");
  for (const message of userMessages) {
    const lowered = message.text.toLowerCase();
    const weight = eventWeight({
      ts: messageTimestamp(message, params.now),
      now: params.now,
      halfLifeMs: params.halfLifeMs,
    });

    const objectivePhrases = extractObjectivePhrases(lowered);
    for (const phrase of objectivePhrases) {
      map[phrase] = (map[phrase] ?? 0) + 2.2 * weight;
    }

    for (const token of extractTokens(lowered)) {
      const id = normalizeId(token);
      map[id] = (map[id] ?? 0) + 0.3 * weight;
    }
  }

  return normalizeWeights(map);
}

function applyOutcomeAffinityUpdates(params: {
  previous?: Record<string, number>;
  outcomes: PreferenceOutcome[];
  now: number;
  halfLifeMs: number;
}): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [id, score] of Object.entries(params.previous ?? {})) {
    const normalizedId = normalizeId(id);
    result[normalizedId] = clamp01(score * 0.92 + 0.04);
  }

  const outcomeDelta: Record<PreferenceOutcome["outcome"], number> = {
    completed: 0.2,
    helpful: 0.15,
    ignored: -0.05,
    rejected: -0.22,
    harmful: -0.35,
  };

  for (const outcome of params.outcomes) {
    const id = normalizeId(outcome.interventionId);
    const baseline = result[id] ?? 0.5;
    const intensity = clamp01(outcome.intensity ?? 1);
    const ts = typeof outcome.timestamp === "number" ? outcome.timestamp : params.now;
    const freshness = eventWeight({ ts, now: params.now, halfLifeMs: params.halfLifeMs });
    const delta = outcomeDelta[outcome.outcome] * intensity * freshness;
    result[id] = clamp01(baseline + delta);
  }

  return result;
}

function inferToneBias(messages: PreferenceMessage[]): { supportive: number; direct: number } {
  const text = messages
    .filter((message) => message.role === "user")
    .map((message) => message.text.toLowerCase())
    .join("\n");

  const supportiveHits = SUPPORTIVE_CUES.filter((cue) => text.includes(cue)).length;
  const directHits = DIRECT_CUES.filter((cue) => text.includes(cue)).length;
  const denominator = supportiveHits + directHits + 1;

  const supportive = clamp01(0.35 + supportiveHits / denominator);
  const direct = clamp01(0.35 + directHits / denominator);
  return {
    supportive: Number(supportive.toFixed(4)),
    direct: Number(direct.toFixed(4)),
  };
}

function inferConfidence(params: {
  messages: PreferenceMessage[];
  outcomes: PreferenceOutcome[];
  now: number;
  halfLifeMs: number;
}): number {
  const userMessages = params.messages.filter((message) => message.role === "user");
  if (userMessages.length === 0 && params.outcomes.length === 0) {
    return 0.15;
  }

  const signalCount = userMessages.length + params.outcomes.length;
  const density = clamp01(signalCount / 20);

  const latestSignal = Math.max(
    0,
    ...userMessages.map((message) => messageTimestamp(message, 0)),
    ...params.outcomes.map((outcome) => outcome.timestamp ?? 0),
  );
  const recency =
    latestSignal > 0 ? eventWeight({ ts: latestSignal, now: params.now, halfLifeMs: params.halfLifeMs }) : 0;
  return Number(clamp01(0.2 + density * 0.45 + recency * 0.35).toFixed(4));
}

export function buildUserPreferenceProfile(input: PreferenceInferenceInput): UserPreferenceProfile {
  const now = input.now ?? Date.now();
  const halfLifeDays = input.decayHalfLifeDays ?? 14;
  const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000;
  const outcomes = input.outcomes ?? [];

  const objectiveWeights = inferObjectiveWeights({
    messages: input.messages,
    previous: input.previous?.objectiveWeights,
    now,
    halfLifeMs,
  });

  const interventionAffinity = applyOutcomeAffinityUpdates({
    previous: input.previous?.interventionAffinity,
    outcomes,
    now,
    halfLifeMs,
  });

  const toneBias = inferToneBias(input.messages);
  const confidence = inferConfidence({
    messages: input.messages,
    outcomes,
    now,
    halfLifeMs,
  });

  return {
    objectiveWeights,
    interventionAffinity,
    toneBias,
    confidence,
  };
}

export function applyRecencyDecay(
  profile: UserPreferenceProfile,
  ageMinutes: number,
  halfLifeDays = 14,
): UserPreferenceProfile {
  const halfLifeMinutes = halfLifeDays * 24 * 60;
  const decay = Math.exp(-Math.max(0, ageMinutes) / Math.max(1, halfLifeMinutes));

  const objectiveWeights: Record<string, number> = {};
  for (const [key, value] of Object.entries(profile.objectiveWeights)) {
    objectiveWeights[key] = value * decay;
  }

  const interventionAffinity: Record<string, number> = {};
  for (const [key, value] of Object.entries(profile.interventionAffinity)) {
    interventionAffinity[key] = clamp01((value - 0.5) * decay + 0.5);
  }

  return {
    objectiveWeights: normalizeWeights(objectiveWeights),
    interventionAffinity,
    toneBias: {
      supportive: clamp01((profile.toneBias.supportive - 0.5) * decay + 0.5),
      direct: clamp01((profile.toneBias.direct - 0.5) * decay + 0.5),
    },
    confidence: Number(clamp01(profile.confidence * decay).toFixed(4)),
  };
}

export function inferObjectivesFromInterventionId(interventionId: string): string[] {
  const normalized = normalizeId(interventionId);
  const fromColon = interventionId
    .toLowerCase()
    .split(":")
    .map((token) => normalizeId(token))
    .filter((token) => token && token !== "dyn" && token !== "plan");
  if (fromColon.length > 0) {
    return [...new Set(fromColon)];
  }

  const tokens = normalized
    .split("-")
    .filter((token) => token.length >= 3 && token !== "dyn" && token !== "plan");
  return tokens.length > 0 ? [...new Set(tokens)] : ["general"];
}
