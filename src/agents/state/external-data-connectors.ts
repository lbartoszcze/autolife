import fs from "node:fs/promises";
import path from "node:path";
import type { DataSourceAdapter, DataSourceKind, DataSignal } from "./state-agent.js";

export type ExternalConnectorKind =
  | "health"
  | "gmail"
  | "messenger"
  | "imessage"
  | "photos"
  | "facebook"
  | (string & {});

export type ExternalFileConnectorConfig = {
  path: string;
  kind?: ExternalConnectorKind;
  id?: string;
  format?: "json" | "jsonl" | "text" | "auto";
  weight?: number;
  maxItems?: number;
};

export type ExternalDataSourcesConfig = {
  health?: ExternalFileConnectorConfig;
  gmail?: ExternalFileConnectorConfig;
  messenger?: ExternalFileConnectorConfig;
  imessage?: ExternalFileConnectorConfig;
  photos?: ExternalFileConnectorConfig;
  facebook?: ExternalFileConnectorConfig;
  custom?: ExternalFileConnectorConfig[];
};

type ParsedRecord = {
  capturedAt: number;
  text: string;
};

const DEFAULT_WEIGHT_BY_KIND: Record<string, number> = {
  health: 0.72,
  gmail: 0.52,
  messenger: 0.58,
  imessage: 0.62,
  photos: 0.48,
  facebook: 0.5,
};

const TIMESTAMP_FIELDS = [
  "timestamp",
  "time",
  "ts",
  "createdAt",
  "created_at",
  "date",
  "datetime",
  "capturedAt",
  "startAt",
  "endAt",
];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeKind(kind: string | undefined, fallback: string): DataSourceKind {
  const normalized = (kind ?? fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (normalized || fallback) as DataSourceKind;
}

function normalizeId(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "external"
  );
}

function inferFormat(filePath: string): "json" | "jsonl" | "text" {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jsonl" || ext === ".ndjson") {
    return "jsonl";
  }
  if (ext === ".json") {
    return "json";
  }
  return "text";
}

function parseTimestampValue(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) {
      return value;
    }
    if (value > 1_000_000_000) {
      return value * 1000;
    }
    return fallback;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
    const numeric = Number.parseInt(value, 10);
    if (Number.isFinite(numeric)) {
      return parseTimestampValue(numeric, fallback);
    }
  }
  return fallback;
}

function compact(value: string, max = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 3)}...`;
}

function flattenStrings(value: unknown, depth = 0, maxValues = 20): string[] {
  if (depth > 4 || maxValues <= 0) {
    return [];
  }
  if (typeof value === "string") {
    const cleaned = compact(value, 140);
    return cleaned ? [cleaned] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    const buffer: string[] = [];
    for (const entry of value.slice(0, 10)) {
      const nested = flattenStrings(entry, depth + 1, maxValues - buffer.length);
      buffer.push(...nested);
      if (buffer.length >= maxValues) {
        break;
      }
    }
    return buffer;
  }
  if (value && typeof value === "object") {
    const buffer: string[] = [];
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
      if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
        buffer.push(`${key}:${entry}`);
      } else {
        const nested = flattenStrings(entry, depth + 1, maxValues - buffer.length);
        if (nested.length > 0) {
          buffer.push(`${key}:${nested[0]}`);
        }
      }
      if (buffer.length >= maxValues) {
        break;
      }
    }
    return buffer;
  }
  return [];
}

function extractTimestampFromObject(record: Record<string, unknown>, fallback: number): number {
  for (const field of TIMESTAMP_FIELDS) {
    if (field in record) {
      return parseTimestampValue(record[field], fallback);
    }
  }
  return fallback;
}

function extractRecord(record: unknown, fallbackTs: number): ParsedRecord | undefined {
  if (record === null || record === undefined) {
    return undefined;
  }
  if (typeof record === "string") {
    const text = compact(record);
    if (!text) {
      return undefined;
    }
    return {
      capturedAt: fallbackTs,
      text,
    };
  }
  if (typeof record === "number" || typeof record === "boolean") {
    return {
      capturedAt: fallbackTs,
      text: String(record),
    };
  }
  if (Array.isArray(record)) {
    const values = flattenStrings(record, 0, 18);
    if (values.length === 0) {
      return undefined;
    }
    return {
      capturedAt: fallbackTs,
      text: compact(values.join(" | ")),
    };
  }

  const objectRecord = record as Record<string, unknown>;
  const text = flattenStrings(objectRecord, 0, 22).join(" | ");
  if (!text) {
    return undefined;
  }
  return {
    capturedAt: extractTimestampFromObject(objectRecord, fallbackTs),
    text: compact(text),
  };
}

function parseJsonPayload(payload: unknown, nowMs: number, maxItems: number): ParsedRecord[] {
  if (Array.isArray(payload)) {
    return payload
      .slice(-maxItems)
      .map((entry) => extractRecord(entry, nowMs))
      .filter((entry): entry is ParsedRecord => Boolean(entry));
  }
  const one = extractRecord(payload, nowMs);
  return one ? [one] : [];
}

function parseJsonlPayload(raw: string, nowMs: number, maxItems: number): ParsedRecord[] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-maxItems);

  const rows: ParsedRecord[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      const row = extractRecord(parsed, nowMs);
      if (row) {
        rows.push(row);
      }
    } catch {
      const row = extractRecord(line, nowMs);
      if (row) {
        rows.push(row);
      }
    }
  }
  return rows;
}

function parseTextPayload(raw: string, nowMs: number, maxItems: number): ParsedRecord[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-maxItems)
    .map((line) => ({
      capturedAt: nowMs,
      text: compact(line, 180),
    }));
}

async function loadFileRecords(params: {
  filePath: string;
  format: "json" | "jsonl" | "text";
  nowMs: number;
  maxItems: number;
}): Promise<ParsedRecord[]> {
  const raw = await fs.readFile(params.filePath, "utf-8");
  if (params.format === "json") {
    try {
      return parseJsonPayload(JSON.parse(raw) as unknown, params.nowMs, params.maxItems);
    } catch {
      return parseTextPayload(raw, params.nowMs, params.maxItems);
    }
  }
  if (params.format === "jsonl") {
    return parseJsonlPayload(raw, params.nowMs, params.maxItems);
  }
  return parseTextPayload(raw, params.nowMs, params.maxItems);
}

function createFileConnectorAdapter(params: {
  kind: DataSourceKind;
  id: string;
  filePath: string;
  format: "json" | "jsonl" | "text" | "auto";
  weight: number;
  maxItems: number;
  nowMs?: number;
}): DataSourceAdapter {
  return {
    id: params.id,
    kind: params.kind,
    ingest: async (): Promise<DataSignal[]> => {
      const nowMs = params.nowMs ?? Date.now();
      const format = params.format === "auto" ? inferFormat(params.filePath) : params.format;
      try {
        const records = await loadFileRecords({
          filePath: params.filePath,
          format,
          nowMs,
          maxItems: params.maxItems,
        });
        return records.map((record, idx) => ({
          sourceId: `${params.id}-${idx + 1}`,
          kind: params.kind,
          capturedAt: record.capturedAt,
          text: record.text,
          weight: params.weight,
        }));
      } catch {
        return [];
      }
    },
  };
}

function buildConnector(
  fallbackKind: string,
  config: ExternalFileConnectorConfig | undefined,
  nowMs?: number,
): DataSourceAdapter | undefined {
  if (!config?.path) {
    return undefined;
  }
  const kind = normalizeKind(config.kind, fallbackKind);
  const id = normalizeId(config.id ?? `${kind}-connector`);
  const format = config.format ?? "auto";
  const weight = clamp01(config.weight ?? DEFAULT_WEIGHT_BY_KIND[kind] ?? 0.5) || 0.5;
  const maxItems = Math.max(1, Math.min(500, Math.round(config.maxItems ?? 120)));
  const filePath = path.resolve(config.path);

  return createFileConnectorAdapter({
    kind,
    id,
    filePath,
    format,
    weight,
    maxItems,
    nowMs,
  });
}

export function parseExternalDataSourcesConfig(raw: unknown): ExternalDataSourcesConfig {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const cfg = raw as Record<string, unknown>;
  const parseEntry = (value: unknown): ExternalFileConnectorConfig | undefined => {
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const row = value as Record<string, unknown>;
    if (typeof row.path !== "string" || !row.path.trim()) {
      return undefined;
    }
    return {
      path: row.path,
      kind: typeof row.kind === "string" ? row.kind : undefined,
      id: typeof row.id === "string" ? row.id : undefined,
      format:
        row.format === "json" || row.format === "jsonl" || row.format === "text" || row.format === "auto"
          ? row.format
          : undefined,
      weight: typeof row.weight === "number" ? row.weight : undefined,
      maxItems: typeof row.maxItems === "number" ? row.maxItems : undefined,
    };
  };

  const customRaw = Array.isArray(cfg.custom) ? cfg.custom : [];
  const custom = customRaw.map((entry) => parseEntry(entry)).filter((entry): entry is ExternalFileConnectorConfig => Boolean(entry));

  return {
    health: parseEntry(cfg.health),
    gmail: parseEntry(cfg.gmail),
    messenger: parseEntry(cfg.messenger),
    imessage: parseEntry(cfg.imessage),
    photos: parseEntry(cfg.photos),
    facebook: parseEntry(cfg.facebook),
    custom,
  };
}

export async function loadExternalDataAdapters(params: {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
} = {}): Promise<DataSourceAdapter[]> {
  const env = params.env ?? process.env;
  const cfgPathRaw = params.configPath ?? env.AUTLIFE_DATA_SOURCES_FILE;
  if (!cfgPathRaw?.trim()) {
    return [];
  }
  const configPath = path.resolve(cfgPathRaw.trim());

  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = parseExternalDataSourcesConfig(JSON.parse(raw) as unknown);
    const adapters = [
      buildConnector("health", parsed.health, params.nowMs),
      buildConnector("gmail", parsed.gmail, params.nowMs),
      buildConnector("messenger", parsed.messenger, params.nowMs),
      buildConnector("imessage", parsed.imessage, params.nowMs),
      buildConnector("photos", parsed.photos, params.nowMs),
      buildConnector("facebook", parsed.facebook, params.nowMs),
      ...(parsed.custom ?? []).map((entry) => buildConnector(entry.kind ?? "external", entry, params.nowMs)),
    ].filter((adapter): adapter is DataSourceAdapter => Boolean(adapter));

    return adapters;
  } catch {
    return [];
  }
}
