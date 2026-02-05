import type { CurrentStateAssessment } from "../../contracts.js";

export type TranscriptMessage = {
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
};

export type SourceKind = "transcript" | "calendar" | "wearables" | "app-usage" | "location" | string;

export type SourceSignal = {
  source: SourceKind;
  capturedAt: number;
  needs: Record<string, number>;
  affect: Partial<CurrentStateAssessment["affect"]>;
  observations: string[];
  completeness: number;
};

export interface DataSourceAdapter<T = unknown> {
  kind: SourceKind;
  ingest(data: T, now: number): SourceSignal | null;
}

export type ExternalSourceHooks = Partial<{
  calendar: DataSourceAdapter<unknown>;
  wearables: DataSourceAdapter<unknown>;
  "app-usage": DataSourceAdapter<unknown>;
  location: DataSourceAdapter<unknown>;
}>;

export type DataSourcesInput = {
  transcript?: TranscriptMessage[];
  calendar?: unknown;
  wearables?: unknown;
  appUsage?: unknown;
  location?: unknown;
  custom?: Array<{ kind: string; payload: unknown }>;
  now?: number;
};

const STOPWORDS = new Set([
  "and",
  "about",
  "after",
  "again",
  "also",
  "cannot",
  "cant",
  "because",
  "been",
  "being",
  "did",
  "dont",
  "could",
  "does",
  "doing",
  "from",
  "have",
  "into",
  "just",
  "keep",
  "less",
  "more",
  "must",
  "need",
  "really",
  "same",
  "some",
  "still",
  "that",
  "their",
  "them",
  "there",
  "they",
  "this",
  "those",
  "through",
  "under",
  "until",
  "very",
  "want",
  "with",
  "within",
  "without",
  "would",
]);

const DISTRESS_CUES = [
  "overwhelmed",
  "stressed",
  "anxious",
  "panic",
  "hopeless",
  "burned out",
  "drained",
  "exhausted",
  "lonely",
];

const FRUSTRATION_CUES = [
  "frustrated",
  "annoyed",
  "angry",
  "stuck",
  "blocked",
  "not working",
  "hate",
];

const MOMENTUM_CUES = [
  "progress",
  "done",
  "completed",
  "focused",
  "better",
  "energized",
  "steady",
];

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
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "general";
}

function tokenize(text: string): string[] {
  return (text.match(/[a-z][a-z0-9'-]{2,}/gi) ?? [])
    .map((token) => token.toLowerCase())
    .map((token) => token.replace(/(^'+|'+$)/g, ""))
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function countCue(text: string, cues: string[]): number {
  let count = 0;
  for (const cue of cues) {
    if (text.includes(cue)) {
      count += 1;
    }
  }
  return count;
}

function makePassthroughAdapter(kind: SourceKind): DataSourceAdapter<unknown> {
  return {
    kind,
    ingest(data: unknown, now: number): SourceSignal | null {
      if (data === undefined || data === null) {
        return null;
      }
      const hasContent =
        (Array.isArray(data) && data.length > 0) ||
        (typeof data === "object" && Object.keys(data as Record<string, unknown>).length > 0) ||
        typeof data === "string" ||
        typeof data === "number";
      if (!hasContent) {
        return null;
      }
      return {
        source: kind,
        capturedAt: now,
        needs: {},
        affect: {},
        observations: [`${kind} signal attached`],
        completeness: 0.35,
      };
    },
  };
}

export function createTranscriptAdapter(): DataSourceAdapter<TranscriptMessage[]> {
  return {
    kind: "transcript",
    ingest(messages: TranscriptMessage[], now: number): SourceSignal | null {
      const userMessages = messages.filter((entry) => entry.role === "user");
      if (userMessages.length === 0) {
        return null;
      }

      const needsStrength: Record<string, number> = {};
      let distressSignal = 0;
      let frustrationSignal = 0;
      let momentumSignal = 0;
      let capturedAt = 0;

      for (const message of userMessages.slice(-40)) {
        const timestamp = typeof message.timestamp === "number" ? message.timestamp : now;
        capturedAt = Math.max(capturedAt, timestamp);
        const ageDays = Math.max(0, now - timestamp) / (24 * 60 * 60_000);
        const recency = Math.exp((-Math.log(2) * ageDays) / 14);

        const text = message.text.toLowerCase();
        const tokens = tokenize(text);
        for (let index = 0; index < tokens.length; index += 1) {
          const token = tokens[index];
          const objectiveId = normalizeId(token);
          needsStrength[objectiveId] = (needsStrength[objectiveId] ?? 0) + recency;

          const next = tokens[index + 1];
          if (next) {
            const phraseId = normalizeId(`${token}-${next}`);
            needsStrength[phraseId] = (needsStrength[phraseId] ?? 0) + recency * 0.9;
          }
        }

        distressSignal += countCue(text, DISTRESS_CUES) * recency;
        frustrationSignal += countCue(text, FRUSTRATION_CUES) * recency;
        momentumSignal += countCue(text, MOMENTUM_CUES) * recency;
      }

      const rankedNeeds = Object.entries(needsStrength)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 14);
      const maxStrength = rankedNeeds[0]?.[1] ?? 1;

      const needs = Object.fromEntries(
        rankedNeeds.map(([id, value]) => [id, round3(clamp01(0.2 + (value / maxStrength) * 0.8))]),
      );

      const denominator = Math.max(1, userMessages.length);
      const affect = {
        distress: round3(clamp01(distressSignal / denominator)),
        frustration: round3(clamp01(frustrationSignal / denominator)),
        momentum: round3(clamp01(momentumSignal / denominator)),
      };

      return {
        source: "transcript",
        capturedAt: capturedAt || now,
        needs,
        affect,
        observations: [
          `Parsed ${userMessages.length} user messages`,
          `Detected ${Object.keys(needs).length} dynamic need dimensions`,
        ],
        completeness: clamp01(0.55 + Math.min(0.4, userMessages.length / 30)),
      };
    },
  };
}

export class DataSourcesModel {
  private readonly adapters = new Map<string, DataSourceAdapter<unknown>>();

  public constructor(hooks: ExternalSourceHooks = {}) {
    this.registerAdapter(createTranscriptAdapter() as DataSourceAdapter<unknown>);
    this.registerAdapter((hooks.calendar ?? makePassthroughAdapter("calendar")) as DataSourceAdapter<unknown>);
    this.registerAdapter((hooks.wearables ?? makePassthroughAdapter("wearables")) as DataSourceAdapter<unknown>);
    this.registerAdapter((hooks["app-usage"] ?? makePassthroughAdapter("app-usage")) as DataSourceAdapter<unknown>);
    this.registerAdapter((hooks.location ?? makePassthroughAdapter("location")) as DataSourceAdapter<unknown>);
  }

  public registerAdapter(adapter: DataSourceAdapter<unknown>): void {
    this.adapters.set(adapter.kind, adapter);
  }

  public ingestAll(input: DataSourcesInput): SourceSignal[] {
    const now = input.now ?? Date.now();
    const signals: SourceSignal[] = [];

    const pushIfAny = (kind: string, payload: unknown): void => {
      if (payload === undefined) {
        return;
      }
      const adapter = this.adapters.get(kind);
      if (!adapter) {
        return;
      }
      const signal = adapter.ingest(payload, now);
      if (signal) {
        signals.push(signal);
      }
    };

    pushIfAny("transcript", input.transcript ?? []);
    pushIfAny("calendar", input.calendar);
    pushIfAny("wearables", input.wearables);
    pushIfAny("app-usage", input.appUsage);
    pushIfAny("location", input.location);

    for (const custom of input.custom ?? []) {
      pushIfAny(custom.kind, custom.payload);
    }

    return signals;
  }
}
