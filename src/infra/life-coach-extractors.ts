import type { CurrentStateAssessment } from "../contracts.js";
import {
  assessCurrentState,
  createAppUsageAdapter,
  createCalendarAdapter,
  createDataSourcesModel,
  createLocationAdapter,
  createTranscriptAdapter,
  createWearablesAdapter,
  type TranscriptMessage as StateTranscriptMessage,
} from "../agents/state/state-agent.js";

export type TranscriptRole = "user" | "assistant";

export type TranscriptMessage = StateTranscriptMessage;

export type LifeCoachNeedScores = Record<string, number>;

export type LifeCoachAffectScores = {
  frustration: number;
  distress: number;
  momentum: number;
};

export type LifeCoachPreferenceModel = {
  objectiveBias: Record<string, number>;
  interventionAffinity: Record<string, number>;
  supportiveToneBias: number;
  lastLearnedMessageTs: number;
};

export type LifeCoachHistoryStatus = "sent" | "completed" | "ignored" | "rejected";

export type ResolvedTone = "supportive" | "direct";

const STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "because",
  "before",
  "could",
  "from",
  "have",
  "just",
  "like",
  "really",
  "that",
  "then",
  "this",
  "with",
  "would",
]);

const DISTRESS_CUES = ["anxious", "overwhelmed", "panic", "stressed", "hopeless"];
const FRUSTRATION_CUES = ["frustrated", "stuck", "blocked", "annoyed", "irritated"];
const MOMENTUM_CUES = ["done", "finished", "better", "focused", "progress"];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function clampSigned(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(-1, Math.min(1, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function normalizeId(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "general"
  );
}

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9']{2,}/g) ?? []).filter((token) => !STOPWORDS.has(token));
}

function countCueHits(messages: TranscriptMessage[], cues: string[]): number {
  return messages.reduce((sum, message) => {
    if (message.role !== "user") {
      return sum;
    }
    const text = message.text.toLowerCase();
    let hits = 0;
    for (const cue of cues) {
      if (text.includes(cue)) {
        hits += 1;
      }
    }
    return sum + hits;
  }, 0);
}

export function estimateNeeds(messages: TranscriptMessage[]): LifeCoachNeedScores {
  const userMessages = messages.filter((message) => message.role === "user").slice(-40);
  if (userMessages.length === 0) {
    return { general: 0.5 };
  }

  const counts = new Map<string, number>();
  for (const message of userMessages) {
    for (const token of tokenize(message.text)) {
      const id = normalizeId(token);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }

  const denominator = Math.max(1, userMessages.length * 2);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const needs: LifeCoachNeedScores = {};
  for (const [id, value] of sorted) {
    needs[id] = round3(clamp01(0.2 + value / denominator * 0.8));
  }
  if (Object.keys(needs).length === 0) {
    needs.general = 0.5;
  }
  return needs;
}

export function estimateAffect(messages: TranscriptMessage[], needs: LifeCoachNeedScores): LifeCoachAffectScores {
  const userMessages = messages.filter((message) => message.role === "user").slice(-24);
  const denominator = Math.max(1, userMessages.length);

  const meanNeed =
    Object.values(needs).length > 0
      ? Object.values(needs).reduce((sum, value) => sum + value, 0) / Object.values(needs).length
      : 0.5;

  const distressHits = countCueHits(userMessages, DISTRESS_CUES);
  const frustrationHits = countCueHits(userMessages, FRUSTRATION_CUES);
  const momentumHits = countCueHits(userMessages, MOMENTUM_CUES);

  return {
    frustration: round3(clamp01(frustrationHits / denominator * 0.45 + meanNeed * 0.45)),
    distress: round3(clamp01(distressHits / denominator * 0.5 + meanNeed * 0.5)),
    momentum: round3(clamp01(momentumHits / denominator * 0.45 + (1 - meanNeed) * 0.35)),
  };
}

export async function buildCurrentStateAssessment(params: {
  messages: TranscriptMessage[];
  nowMs?: number;
  calendar?: Array<{ title: string; startAt: number; note?: string }>;
  wearables?: Array<{ capturedAt: number; summary: string }>;
  appUsage?: Array<{ capturedAt: number; summary: string }>;
  location?: Array<{ capturedAt: number; summary: string }>;
}): Promise<CurrentStateAssessment> {
  const adapters = [
    createTranscriptAdapter({ messages: params.messages, nowMs: params.nowMs }),
    createCalendarAdapter({ events: params.calendar }),
    createWearablesAdapter({ samples: params.wearables }),
    createAppUsageAdapter({ samples: params.appUsage }),
    createLocationAdapter({ samples: params.location }),
  ];

  return assessCurrentState({
    nowMs: params.nowMs,
    dataSources: createDataSourcesModel(adapters),
  });
}

export function resolveObjectives(
  cfgObjectives: Partial<Record<string, number>> | undefined,
  needs: LifeCoachNeedScores,
): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const key of Object.keys(needs)) {
    merged[normalizeId(key)] = 1;
  }
  for (const [key, value] of Object.entries(cfgObjectives ?? {})) {
    if (!Number.isFinite(value)) {
      continue;
    }
    merged[normalizeId(key)] = Math.max(0, Math.min(2, value as number));
  }
  if (Object.keys(merged).length === 0) {
    merged.general = 1;
  }
  return merged;
}

export function applyObjectivePreferenceBias(params: {
  objectives: Record<string, number>;
  preferences: LifeCoachPreferenceModel;
}): Record<string, number> {
  const adjusted: Record<string, number> = {};
  for (const [objective, weight] of Object.entries(params.objectives)) {
    const bias = params.preferences.objectiveBias[normalizeId(objective)] ?? 0;
    adjusted[normalizeId(objective)] = round3(Math.max(0, Math.min(2, weight * (1 + bias * 0.3))));
  }
  return adjusted;
}

export function applyPreferenceDecay(params: {
  preferences: LifeCoachPreferenceModel;
  updatedAt: number;
  now: number;
}): void {
  const elapsedDays = Math.max(0, (params.now - params.updatedAt) / (24 * 60 * 60_000));
  const decay = Math.exp(-elapsedDays / 28);

  for (const [key, value] of Object.entries(params.preferences.objectiveBias)) {
    params.preferences.objectiveBias[key] = round3(clampSigned(value * decay));
  }
  for (const [key, value] of Object.entries(params.preferences.interventionAffinity)) {
    params.preferences.interventionAffinity[key] = round3(clampSigned(value * decay));
  }
  params.preferences.supportiveToneBias = round3(clampSigned(params.preferences.supportiveToneBias * decay));
}

export function learnPreferencesFromMessages(params: {
  state: { preferences: LifeCoachPreferenceModel };
  messages: TranscriptMessage[];
}): void {
  const needs = estimateNeeds(params.messages);
  const baseline = Object.values(needs).length > 0 ? 1 / Object.values(needs).length : 1;

  for (const [objective, value] of Object.entries(needs)) {
    const normalized = normalizeId(objective);
    const targetBias = clampSigned((value - baseline) * 0.6);
    const current = params.state.preferences.objectiveBias[normalized] ?? 0;
    params.state.preferences.objectiveBias[normalized] = round3(clampSigned(current * 0.6 + targetBias * 0.4));
  }

  const directSignal = countCueHits(params.messages, ["direct", "brief", "concise"]);
  const supportiveSignal = countCueHits(params.messages, ["gentle", "supportive", "kind"]);
  const toneDelta = clampSigned((supportiveSignal - directSignal) * 0.06);
  params.state.preferences.supportiveToneBias = round3(
    clampSigned(params.state.preferences.supportiveToneBias * 0.8 + toneDelta),
  );
  params.state.preferences.lastLearnedMessageTs = Date.now();
}

export function learnPreferencesFromOutcome(params: {
  state: { preferences: LifeCoachPreferenceModel };
  intervention: string;
  status: LifeCoachHistoryStatus;
  tone?: ResolvedTone;
}): void {
  const interventionId = normalizeId(params.intervention);
  const current = params.state.preferences.interventionAffinity[interventionId] ?? 0;
  const delta =
    params.status === "completed"
      ? 0.2
      : params.status === "ignored"
        ? -0.08
        : params.status === "rejected"
          ? -0.18
          : 0;
  params.state.preferences.interventionAffinity[interventionId] = round3(clampSigned(current + delta));
}

export function inferObjectivesFromInterventionId(interventionId: string): string[] {
  if (interventionId.toLowerCase().startsWith("dyn:")) {
    return [normalizeId(interventionId.split(":")[1] ?? "general")];
  }
  return interventionId
    .split(/[^a-z0-9]+/i)
    .map((token) => normalizeId(token))
    .filter((token) => token.length >= 3)
    .slice(0, 2);
}
