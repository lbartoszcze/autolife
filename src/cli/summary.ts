import fs from "node:fs/promises";

type LooseRecord = Record<string, unknown>;

function asRecord(value: unknown): LooseRecord | undefined {
  return value && typeof value === "object" ? (value as LooseRecord) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The last record of the run's trace file, refused naming the file and the cause when it cannot be read. */
export async function readLastTracePayload(tracePath: string): Promise<LooseRecord> {
  const raw = await fs.readFile(tracePath, "utf-8");
  const line = raw
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) {
    throw new Error(`the trace file ${tracePath} holds no record after the run`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(
      `the last record of ${tracePath} does not parse: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const record = asRecord(parsed);
  if (!record) {
    throw new Error(`the last record of ${tracePath} is not an object`);
  }
  return record;
}

/** Every scored need of the run's state, highest first, as `id(score)`. */
export function topNeeds(payload: LooseRecord): string[] {
  const needs = asRecord(asRecord(payload.state)?.needs);
  if (!needs) {
    return [];
  }
  return Object.entries(needs)
    .flatMap(([id, score]) => (typeof score === "number" ? [{ id, score }] : []))
    .sort((left, right) => right.score - left.score)
    .map(({ id, score }) => `${id}(${score.toFixed(2)})`);
}

/** Every evidence reference the run cited, as `title -> url`. */
export function evidenceLinks(payload: LooseRecord): string[] {
  const evidence = payload.evidence;
  if (!Array.isArray(evidence)) {
    return [];
  }
  return evidence.flatMap((finding: unknown) => {
    const refs = asRecord(finding)?.references;
    if (!Array.isArray(refs)) {
      return [];
    }
    return refs.flatMap((ref: unknown) => {
      const title = asString(asRecord(ref)?.title);
      const url = asString(asRecord(ref)?.url);
      return title && url ? [`${title} -> ${url}`] : [];
    });
  });
}

/** The kinds of data source the run's state signals came from (the part of each signal before `:`). */
export function dataSourceKinds(payload: LooseRecord): string[] {
  const signals = asRecord(payload.state)?.signals;
  if (!Array.isArray(signals)) {
    return [];
  }
  const kinds = new Set<string>();
  for (const signal of signals) {
    const kind = typeof signal === "string" ? signal.split(":")[0]?.trim() : undefined;
    if (kind) {
      kinds.add(kind);
    }
  }
  return [...kinds];
}

export type MentorSummary = { figure?: string; topic?: string; takeaway?: string; links: string[] };

export type ForecastSummary = { baseline?: string; withIntervention?: string };

/** The run's forecast without and with the selected intervention. */
export function forecastSummary(payload: LooseRecord): ForecastSummary {
  const forecast = asRecord(payload.forecast);
  return { baseline: asString(forecast?.baseline), withIntervention: asString(forecast?.withIntervention) };
}

/** The mentor comparison of the selected intervention. */
export function mentorSummary(payload: LooseRecord): MentorSummary {
  const mentor = asRecord(asRecord(payload.selected)?.mentorComparison);
  if (!mentor) {
    return { links: [] };
  }
  const links = Array.isArray(mentor.sourceLinks)
    ? mentor.sourceLinks.filter((entry: unknown): entry is string => typeof entry === "string")
    : [];
  return { figure: asString(mentor.figure), topic: asString(mentor.topic), takeaway: asString(mentor.takeaway), links };
}

export type SoraSummary = { status?: string; title?: string; callToAction?: string; prompt?: string; jobId?: string };

/** The Sora video plan of the selected intervention. */
export function soraSummary(payload: LooseRecord): SoraSummary {
  const video = asRecord(asRecord(payload.selected)?.videoPlan);
  if (!video) {
    return {};
  }
  return {
    status: asString(video.status),
    title: asString(video.title),
    callToAction: asString(video.callToAction),
    prompt: asString(video.prompt),
    jobId: asString(video.jobId),
  };
}
