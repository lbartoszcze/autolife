import type { EvidenceFinding, EvidenceReference } from "../../contracts.js";

export type EvidenceTopicInput =
  | string
  | {
      topicId?: string;
      query: string;
    };

export type EvidenceAgentInput = {
  topics: EvidenceTopicInput[];
  maxReferencesPerTopic?: number;
  minConfidence?: number;
  now?: Date;
  fetchImpl?: typeof fetch;
};

type SourceType = EvidenceReference["sourceType"];

type ScoredReference = EvidenceReference & {
  citations: number;
  score: number;
};

type OpenAlexResponse = {
  results?: Array<{
    display_name?: string;
    doi?: string;
    publication_year?: number;
    cited_by_count?: number;
    type?: string;
    primary_location?: {
      landing_page_url?: string;
    };
  }>;
};

type CrossrefResponse = {
  message?: {
    items?: Array<{
      title?: string[];
      DOI?: string;
      URL?: string;
      issued?: {
        "date-parts"?: number[][];
      };
      type?: string;
      "is-referenced-by-count"?: number;
    }>;
  };
};

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
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "general";
}

function mapOpenAlexType(type?: string): SourceType {
  const normalized = (type ?? "").toLowerCase();
  if (normalized.includes("meta")) {
    return "meta-analysis";
  }
  if (normalized.includes("review")) {
    return "review";
  }
  return "paper";
}

function scoreReference(params: {
  sourceType: SourceType;
  citations: number;
  publishedAt?: string;
  hasUrl: boolean;
  nowYear: number;
}): number {
  const typeWeight: Record<SourceType, number> = {
    "meta-analysis": 0.76,
    review: 0.7,
    guideline: 0.78,
    paper: 0.62,
  };

  const citationBoost = Math.min(0.17, Math.log1p(Math.max(0, params.citations)) / 8);

  let recencyBoost = 0;
  if (params.publishedAt) {
    const year = Number.parseInt(params.publishedAt.slice(0, 4), 10);
    if (Number.isFinite(year) && year > 1900) {
      const age = Math.max(0, params.nowYear - year);
      recencyBoost = Math.max(-0.08, 0.08 - age * 0.01);
    }
  }

  const urlBoost = params.hasUrl ? 0.05 : 0;
  return round3(clamp01(typeWeight[params.sourceType] + citationBoost + recencyBoost + urlBoost));
}

function pickUrl(params: { doi?: string; landingUrl?: string; fallbackUrl?: string }): string {
  if (params.landingUrl && /^https?:\/\//i.test(params.landingUrl)) {
    return params.landingUrl;
  }
  if (params.fallbackUrl && /^https?:\/\//i.test(params.fallbackUrl)) {
    return params.fallbackUrl;
  }
  if (params.doi) {
    const cleanDoi = params.doi.replace(/^https?:\/\/doi\.org\//i, "");
    return `https://doi.org/${cleanDoi}`;
  }
  return "";
}

function dedupeReferences(references: ScoredReference[]): ScoredReference[] {
  const bestByKey = new Map<string, ScoredReference>();
  for (const reference of references) {
    const dedupeKey = normalizeId(reference.url || reference.title);
    const existing = bestByKey.get(dedupeKey);
    if (!existing || reference.score > existing.score) {
      bestByKey.set(dedupeKey, reference);
    }
  }
  return [...bestByKey.values()].sort((a, b) => b.score - a.score);
}

async function fetchOpenAlex(
  query: string,
  fetchImpl: typeof fetch,
  nowYear: number,
  maxRows: number,
): Promise<ScoredReference[]> {
  const url = new URL("https://api.openalex.org/works");
  url.searchParams.set("search", query);
  url.searchParams.set("per-page", String(Math.max(3, maxRows * 2)));
  url.searchParams.set("select", "display_name,doi,publication_year,cited_by_count,type,primary_location");

  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`OpenAlex request failed for topic \"${query}\" (${response.status})`);
  }

  const payload = (await response.json()) as OpenAlexResponse;
  const records = payload.results ?? [];

  return records
    .map((record): ScoredReference | null => {
      const title = record.display_name?.trim();
      if (!title) {
        return null;
      }

      const publishedAt =
        typeof record.publication_year === "number" ? `${record.publication_year.toString().padStart(4, "0")}-01-01` : undefined;
      const url = pickUrl({
        doi: record.doi,
        landingUrl: record.primary_location?.landing_page_url,
      });
      const sourceType = mapOpenAlexType(record.type);
      const citations = Math.max(0, record.cited_by_count ?? 0);
      const score = scoreReference({
        sourceType,
        citations,
        publishedAt,
        hasUrl: Boolean(url),
        nowYear,
      });

      return {
        title,
        url,
        sourceType,
        publishedAt,
        citations,
        score,
      };
    })
    .filter((reference): reference is ScoredReference => Boolean(reference));
}

async function fetchCrossrefGuidelines(
  query: string,
  fetchImpl: typeof fetch,
  nowYear: number,
  maxRows: number,
): Promise<ScoredReference[]> {
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query.title", `${query} guideline`);
  url.searchParams.set("rows", String(Math.max(3, maxRows * 2)));

  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Crossref request failed for topic \"${query}\" (${response.status})`);
  }

  const payload = (await response.json()) as CrossrefResponse;
  const records = payload.message?.items ?? [];

  return records
    .map((record): ScoredReference | null => {
      const title = record.title?.[0]?.trim();
      if (!title) {
        return null;
      }
      const lowered = title.toLowerCase();
      if (!lowered.includes("guideline") && !lowered.includes("recommendation") && !lowered.includes("consensus")) {
        return null;
      }

      const year = record.issued?.["date-parts"]?.[0]?.[0];
      const publishedAt = typeof year === "number" ? `${year.toString().padStart(4, "0")}-01-01` : undefined;
      const url = pickUrl({
        doi: record.DOI,
        fallbackUrl: record.URL,
      });
      const citations = Math.max(0, record["is-referenced-by-count"] ?? 0);
      const score = scoreReference({
        sourceType: "guideline",
        citations,
        publishedAt,
        hasUrl: Boolean(url),
        nowYear,
      });

      return {
        title,
        url,
        sourceType: "guideline",
        publishedAt,
        citations,
        score,
      };
    })
    .filter((reference): reference is ScoredReference => Boolean(reference));
}

async function gatherTopicEvidence(params: {
  topicId: string;
  query: string;
  fetchImpl: typeof fetch;
  maxReferences: number;
  minConfidence: number;
  nowYear: number;
}): Promise<EvidenceFinding> {
  const references: ScoredReference[] = [];

  const results = await Promise.allSettled([
    fetchOpenAlex(params.query, params.fetchImpl, params.nowYear, params.maxReferences),
    fetchCrossrefGuidelines(params.query, params.fetchImpl, params.nowYear, params.maxReferences),
  ]);

  for (const result of results) {
    if (result.status === "fulfilled") {
      references.push(...result.value);
    }
  }

  const deduped = dedupeReferences(references)
    .filter((reference) => reference.url)
    .slice(0, params.maxReferences);

  const confidence =
    deduped.length === 0
      ? 0
      : round3(
          clamp01(
            deduped.slice(0, 3).reduce((sum, reference) => sum + reference.score, 0) /
              Math.min(3, deduped.length),
          ),
        );

  const claim =
    deduped.length === 0
      ? `No retrievable evidence found for ${params.query}.`
      : `Top evidence for ${params.query} leans on ${deduped[0].sourceType} sources, led by \"${deduped[0].title}\".`;

  return {
    topicId: params.topicId,
    claim,
    confidence: confidence >= params.minConfidence ? confidence : round3(confidence * 0.85),
    expectedEffect:
      deduped.length > 0
        ? `Highest-ranked source confidence ${round3(deduped[0].score)} from ${deduped[0].sourceType} evidence.`
        : undefined,
    references: deduped.map((reference) => ({
      title: reference.title,
      url: reference.url,
      sourceType: reference.sourceType,
      publishedAt: reference.publishedAt,
    })),
  };
}

export async function buildEvidenceFindings(input: EvidenceAgentInput): Promise<EvidenceFinding[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const maxReferences = Math.max(2, input.maxReferencesPerTopic ?? 5);
  const minConfidence = clamp01(input.minConfidence ?? 0.35);
  const nowYear = (input.now ?? new Date()).getUTCFullYear();

  const topics = input.topics.map((topic) => {
    if (typeof topic === "string") {
      return {
        topicId: normalizeId(topic),
        query: topic,
      };
    }
    return {
      topicId: normalizeId(topic.topicId ?? topic.query),
      query: topic.query,
    };
  });

  const findings = await Promise.all(
    topics.map((topic) =>
      gatherTopicEvidence({
        topicId: topic.topicId,
        query: topic.query,
        fetchImpl,
        maxReferences,
        minConfidence,
        nowYear,
      }),
    ),
  );

  return findings;
}
