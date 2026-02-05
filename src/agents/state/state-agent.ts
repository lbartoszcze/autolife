import type { CurrentStateAssessment } from "../../contracts.js";

export type TranscriptRole = "user" | "assistant";

export type TranscriptMessage = {
  role: TranscriptRole;
  text: string;
  timestamp?: number;
};

export type DataSourceKind = "transcript" | "calendar" | "wearables" | "app-usage" | "location";

export type DataSignal = {
  sourceId: string;
  kind: DataSourceKind;
  capturedAt: number;
  text: string;
  weight: number;
};

export type DataSourceAdapter = {
  id: string;
  kind: DataSourceKind;
  ingest: () => Promise<DataSignal[]>;
};

export type DataSourcesModel = {
  adapters: DataSourceAdapter[];
};

export type StateAgentInput = {
  nowMs?: number;
  dataSources: DataSourcesModel;
};

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "about",
  "after",
  "again",
  "also",
  "am",
  "are",
  "as",
  "better",
  "because",
  "before",
  "but",
  "could",
  "do",
  "for",
  "doing",
  "from",
  "have",
  "hours",
  "i",
  "im",
  "ive",
  "is",
  "just",
  "keep",
  "like",
  "my",
  "now",
  "of",
  "on",
  "or",
  "our",
  "so",
  "spent",
  "the",
  "to",
  "today",
  "wasted",
  "we",
  "feel",
  "really",
  "still",
  "that",
  "then",
  "this",
  "was",
  "were",
  "what",
  "when",
  "why",
  "with",
  "want",
  "would",
  "you",
]);

const DISTRESS_CUES = ["anxious", "overwhelmed", "panic", "hopeless", "stressed"];
const FRUSTRATION_CUES = ["frustrated", "stuck", "blocked", "annoyed", "irritated"];
const MOMENTUM_CUES = ["done", "finished", "better", "focused", "momentum", "progress"];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
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

function countCueHits(text: string, cues: string[]): number {
  let hits = 0;
  for (const cue of cues) {
    if (text.includes(cue)) {
      hits += 1;
    }
  }
  return hits;
}

function summarizeSignal(signal: DataSignal): string {
  const compact = signal.text.trim().replace(/\s+/g, " ");
  const excerpt = compact.length > 96 ? `${compact.slice(0, 93)}...` : compact;
  return `${signal.kind}:${signal.sourceId}:${excerpt}`;
}

function inferNeeds(signals: DataSignal[]): Record<string, number> {
  const weightedCounts = new Map<string, number>();
  let totalWeight = 0;

  for (const signal of signals) {
    const weight = clamp01(signal.weight || 0.5);
    totalWeight += weight;
    for (const token of tokenize(signal.text)) {
      const id = normalizeId(token);
      weightedCounts.set(id, (weightedCounts.get(id) ?? 0) + weight);
    }
  }

  if (weightedCounts.size === 0) {
    return { general: 0.5 };
  }

  const denominator = Math.max(1, totalWeight);
  const sorted = [...weightedCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const needs: Record<string, number> = {};
  for (const [objectiveId, value] of sorted) {
    needs[objectiveId] = round3(clamp01(0.2 + value / denominator * 0.7));
  }
  return needs;
}

function inferAffect(signals: DataSignal[], needs: Record<string, number>): CurrentStateAssessment["affect"] {
  const normalizedText = signals.map((signal) => signal.text.toLowerCase()).join("\n");
  const distressHits = countCueHits(normalizedText, DISTRESS_CUES);
  const frustrationHits = countCueHits(normalizedText, FRUSTRATION_CUES);
  const momentumHits = countCueHits(normalizedText, MOMENTUM_CUES);

  const needAverage =
    Object.values(needs).length > 0
      ? Object.values(needs).reduce((sum, score) => sum + score, 0) / Object.values(needs).length
      : 0.5;
  const signalScale = Math.max(1, signals.length);

  return {
    frustration: round3(clamp01(frustrationHits / signalScale * 0.45 + needAverage * 0.45)),
    distress: round3(clamp01(distressHits / signalScale * 0.5 + needAverage * 0.5)),
    momentum: round3(clamp01(momentumHits / signalScale * 0.4 + (1 - needAverage) * 0.35)),
  };
}

function computeFreshness(nowMs: number, signals: DataSignal[], adapterCount: number): CurrentStateAssessment["freshness"] {
  const capturedAt = signals.length > 0 ? Math.max(...signals.map((signal) => signal.capturedAt)) : nowMs;
  const ageMinutes = round3(Math.max(0, nowMs - capturedAt) / 60_000);

  const sourceCoverage = adapterCount > 0 ? new Set(signals.map((signal) => signal.kind)).size / adapterCount : 0;
  const volumeCoverage = clamp01(signals.length / Math.max(4, adapterCount * 2));
  const recencyCoverage = clamp01(1 - ageMinutes / (24 * 60));
  const completeness = round3(clamp01(sourceCoverage * 0.45 + volumeCoverage * 0.35 + recencyCoverage * 0.2));

  return {
    capturedAt,
    ageMinutes,
    completeness,
  };
}

export async function assessCurrentState(input: StateAgentInput): Promise<CurrentStateAssessment> {
  const nowMs = input.nowMs ?? Date.now();
  const adapters = input.dataSources.adapters;

  const allSignals: DataSignal[] = [];
  for (const adapter of adapters) {
    const signals = await adapter.ingest();
    for (const signal of signals) {
      allSignals.push({
        ...signal,
        kind: adapter.kind,
      });
    }
  }

  allSignals.sort((a, b) => b.capturedAt - a.capturedAt);
  const needs = inferNeeds(allSignals);
  const affect = inferAffect(allSignals, needs);
  const freshness = computeFreshness(nowMs, allSignals, adapters.length);

  return {
    needs,
    affect,
    signals: allSignals.slice(0, 16).map(summarizeSignal),
    freshness,
  };
}

export function createTranscriptAdapter(params: {
  messages: TranscriptMessage[];
  id?: string;
  nowMs?: number;
}): DataSourceAdapter {
  const nowMs = params.nowMs ?? Date.now();
  return {
    id: params.id ?? "transcript-main",
    kind: "transcript",
    ingest: async () =>
      params.messages
        .filter((message) => message.role === "user")
        .slice(-120)
        .map((message) => ({
          sourceId: params.id ?? "transcript-main",
          kind: "transcript",
          capturedAt: typeof message.timestamp === "number" ? message.timestamp : nowMs,
          text: message.text,
          weight: 0.8,
        })),
  };
}

export function createCalendarAdapter(params: {
  events?: Array<{ title: string; startAt: number; note?: string }>;
  id?: string;
}): DataSourceAdapter {
  return {
    id: params.id ?? "calendar-hook",
    kind: "calendar",
    ingest: async () =>
      (params.events ?? []).map((event) => ({
        sourceId: params.id ?? "calendar-hook",
        kind: "calendar",
        capturedAt: event.startAt,
        text: `${event.title}${event.note ? ` ${event.note}` : ""}`,
        weight: 0.55,
      })),
  };
}

export function createWearablesAdapter(params: {
  samples?: Array<{ capturedAt: number; summary: string }>;
  id?: string;
}): DataSourceAdapter {
  return {
    id: params.id ?? "wearables-hook",
    kind: "wearables",
    ingest: async () =>
      (params.samples ?? []).map((sample) => ({
        sourceId: params.id ?? "wearables-hook",
        kind: "wearables",
        capturedAt: sample.capturedAt,
        text: sample.summary,
        weight: 0.6,
      })),
  };
}

export function createAppUsageAdapter(params: {
  samples?: Array<{ capturedAt: number; summary: string }>;
  id?: string;
}): DataSourceAdapter {
  return {
    id: params.id ?? "app-usage-hook",
    kind: "app-usage",
    ingest: async () =>
      (params.samples ?? []).map((sample) => ({
        sourceId: params.id ?? "app-usage-hook",
        kind: "app-usage",
        capturedAt: sample.capturedAt,
        text: sample.summary,
        weight: 0.5,
      })),
  };
}

export function createLocationAdapter(params: {
  samples?: Array<{ capturedAt: number; summary: string }>;
  id?: string;
}): DataSourceAdapter {
  return {
    id: params.id ?? "location-hook",
    kind: "location",
    ingest: async () =>
      (params.samples ?? []).map((sample) => ({
        sourceId: params.id ?? "location-hook",
        kind: "location",
        capturedAt: sample.capturedAt,
        text: sample.summary,
        weight: 0.45,
      })),
  };
}

export function createDataSourcesModel(adapters: DataSourceAdapter[]): DataSourcesModel {
  return { adapters };
}

export function createTranscriptFirstDataSourcesModel(params: {
  messages: TranscriptMessage[];
  nowMs?: number;
  calendarEvents?: Array<{ title: string; startAt: number; note?: string }>;
  wearableSamples?: Array<{ capturedAt: number; summary: string }>;
  appUsageSamples?: Array<{ capturedAt: number; summary: string }>;
  locationSamples?: Array<{ capturedAt: number; summary: string }>;
  additionalAdapters?: DataSourceAdapter[];
}): DataSourcesModel {
  const adapters: DataSourceAdapter[] = [
    createTranscriptAdapter({
      messages: params.messages,
      nowMs: params.nowMs,
    }),
  ];

  if (params.calendarEvents && params.calendarEvents.length > 0) {
    adapters.push(createCalendarAdapter({ events: params.calendarEvents }));
  }
  if (params.wearableSamples && params.wearableSamples.length > 0) {
    adapters.push(createWearablesAdapter({ samples: params.wearableSamples }));
  }
  if (params.appUsageSamples && params.appUsageSamples.length > 0) {
    adapters.push(createAppUsageAdapter({ samples: params.appUsageSamples }));
  }
  if (params.locationSamples && params.locationSamples.length > 0) {
    adapters.push(createLocationAdapter({ samples: params.locationSamples }));
  }
  if (params.additionalAdapters && params.additionalAdapters.length > 0) {
    adapters.push(...params.additionalAdapters);
  }

  return createDataSourcesModel(adapters);
}
