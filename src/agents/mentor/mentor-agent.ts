import type { CurrentStateAssessment, EvidenceFinding, MentorComparison } from "../../contracts.js";

export type MentorAgentInput = {
  objectiveIds: string[];
  state: Pick<CurrentStateAssessment, "needs" | "affect">;
  evidence?: EvidenceFinding[];
  now?: Date;
  fetchImpl?: typeof fetch;
};

type WikidataSearchResult = {
  id?: string;
  label?: string;
  description?: string;
};

type WikidataSearchResponse = {
  search?: WikidataSearchResult[];
};

type WikidataEntityResponse = {
  entities?: Record<
    string,
    {
      sitelinks?: {
        enwiki?: {
          title?: string;
        };
      };
      claims?: Record<string, Array<{ mainsnak?: { datavalue?: { value?: { time?: string } } } }>>;
    }
  >;
};

type WikipediaSummaryResponse = {
  title?: string;
  type?: string;
  description?: string;
  extract?: string;
  content_urls?: {
    desktop?: {
      page?: string;
    };
  };
};

const OBJECTIVE_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "general",
  "main",
  "work",
  "life",
]);

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
      .replace(/^-+|-+$/g, "") || "general"
  );
}

function objectiveLabel(value: string): string {
  return normalizeId(value).replace(/-/g, " ");
}

function scoreObjective(params: {
  objectiveId: string;
  state: Pick<CurrentStateAssessment, "needs">;
  evidence?: EvidenceFinding[];
}): number {
  const id = normalizeId(params.objectiveId);
  const need = params.state.needs[id] ?? 0;
  const evidence = params.evidence ?? [];
  const evidenceConfidence = evidence
    .filter((finding) => {
      const topic = normalizeId(finding.topicId);
      return topic.includes(id) || id.includes(topic);
    })
    .map((finding) => finding.confidence)
    .reduce((max, value) => Math.max(max, value), 0);
  return need * 0.72 + evidenceConfidence * 0.28;
}

function pickTopic(input: MentorAgentInput): string {
  const candidates = [...new Set(input.objectiveIds.map((id) => normalizeId(id)))].filter(
    (id) => id && !OBJECTIVE_STOPWORDS.has(id),
  );
  if (candidates.length === 0) {
    return "resilience";
  }

  const ranked = candidates
    .map((objectiveId) => ({
      objectiveId,
      score: scoreObjective({
        objectiveId,
        state: input.state,
        evidence: input.evidence,
      }),
    }))
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.objectiveId ?? "resilience";
}

function challengeLens(affect: CurrentStateAssessment["affect"]): string {
  if (affect.distress >= 0.65) {
    return "resilience under pressure";
  }
  if (affect.frustration >= 0.6) {
    return "recovering from setbacks";
  }
  if (affect.momentum <= 0.35) {
    return "discipline and consistency";
  }
  return "sustained focus and execution";
}

async function searchWikidata(params: { query: string; fetchImpl: typeof fetch }): Promise<WikidataSearchResult[]> {
  const url = new URL("https://www.wikidata.org/w/api.php");
  url.searchParams.set("action", "wbsearchentities");
  url.searchParams.set("format", "json");
  url.searchParams.set("language", "en");
  url.searchParams.set("type", "item");
  url.searchParams.set("limit", "8");
  url.searchParams.set("search", params.query);

  const response = await params.fetchImpl(url, {
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Wikidata search failed (${response.status})`);
  }
  const payload = (await response.json()) as WikidataSearchResponse;
  return payload.search ?? [];
}

async function fetchWikidataEntity(params: {
  entityId: string;
  fetchImpl: typeof fetch;
}): Promise<{ enwikiTitle?: string; period?: string }> {
  const url = `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(params.entityId)}.json`;
  const response = await params.fetchImpl(url, {
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Wikidata entity fetch failed (${response.status})`);
  }
  const payload = (await response.json()) as WikidataEntityResponse;
  const entity = payload.entities?.[params.entityId];
  const enwikiTitle = entity?.sitelinks?.enwiki?.title;

  const bornRaw = entity?.claims?.P569?.[0]?.mainsnak?.datavalue?.value?.time;
  const diedRaw = entity?.claims?.P570?.[0]?.mainsnak?.datavalue?.value?.time;
  const bornYear = bornRaw ? Number.parseInt(bornRaw.slice(1, 5), 10) : undefined;
  const diedYear = diedRaw ? Number.parseInt(diedRaw.slice(1, 5), 10) : undefined;
  let period: string | undefined;
  if (Number.isFinite(bornYear) && Number.isFinite(diedYear)) {
    period = `${bornYear}-${diedYear}`;
  } else if (Number.isFinite(bornYear)) {
    period = `${bornYear}-present`;
  }

  return {
    enwikiTitle,
    period,
  };
}

async function fetchWikipediaSummary(params: {
  title: string;
  fetchImpl: typeof fetch;
}): Promise<{ extract?: string; pageUrl?: string }> {
  const response = await params.fetchImpl(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(params.title)}`,
    {
      headers: {
        Accept: "application/json",
      },
    },
  );
  if (!response.ok) {
    return {};
  }
  const payload = (await response.json()) as WikipediaSummaryResponse;
  return {
    extract: payload.extract,
    pageUrl: payload.content_urls?.desktop?.page,
  };
}

function firstSentence(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) {
    return undefined;
  }
  const [sentence] = compact.split(/(?<=[.?!])\s+/);
  return sentence?.trim() || compact.slice(0, 220);
}

const PERSON_DESCRIPTION_HINTS = [
  "politician",
  "scientist",
  "writer",
  "poet",
  "athlete",
  "philosopher",
  "inventor",
  "military",
  "composer",
  "artist",
  "historian",
  "activist",
  "leader",
  "king",
  "queen",
  "american",
  "french",
  "british",
  "german",
  "italian",
];

function looksLikePersonSummary(summary: WikipediaSummaryResponse): boolean {
  if ((summary.type ?? "").toLowerCase() === "disambiguation") {
    return false;
  }
  const description = (summary.description ?? "").toLowerCase();
  if (!description) {
    return false;
  }
  return PERSON_DESCRIPTION_HINTS.some((hint) => description.includes(hint));
}

async function fetchRandomPersonSummary(fetchImpl: typeof fetch): Promise<WikipediaSummaryResponse | undefined> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetchImpl("https://en.wikipedia.org/api/rest_v1/page/random/summary", {
        headers: {
          Accept: "application/json",
        },
      });
      if (!response.ok) {
        continue;
      }
      const payload = (await response.json()) as WikipediaSummaryResponse;
      if (payload.title && looksLikePersonSummary(payload)) {
        return payload;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function fallbackComparison(params: { topic: string; evidence?: EvidenceFinding[] }): MentorComparison {
  const topic = objectiveLabel(params.topic);
  const links = (params.evidence ?? [])
    .flatMap((finding) => finding.references)
    .map((reference) => reference.url)
    .filter((url) => /^https?:\/\//i.test(url))
    .slice(0, 2);

  return {
    topic,
    figure: "Comparative case from evidence corpus",
    context: `Behavior-change outcomes for ${topic} generally improve through repeated small actions rather than one large step.`,
    takeaway: `Run one measurable action for ${topic} now and review adherence after one follow-up window.`,
    sourceLinks: links,
    confidence: links.length > 0 ? 0.42 : 0.28,
  };
}

function scoreCandidate(candidate: WikidataSearchResult): number {
  const description = (candidate.description ?? "").toLowerCase();
  let score = 0;
  if (description.includes("politician") || description.includes("statesman") || description.includes("leader")) {
    score += 0.15;
  }
  if (description.includes("writer") || description.includes("scientist") || description.includes("athlete")) {
    score += 0.12;
  }
  if (description.includes("fictional character")) {
    score += 0.1;
  }
  if (description.includes("human")) {
    score += 0.08;
  }
  if (candidate.label) {
    score += 0.1;
  }
  return score;
}

export async function buildMentorComparison(input: MentorAgentInput): Promise<MentorComparison> {
  const topicId = pickTopic(input);
  const topic = objectiveLabel(topicId);
  const lens = challengeLens(input.state.affect);
  const fetchImpl = input.fetchImpl ?? fetch;

  try {
    const queries = [
      `${topic} ${lens}`,
      `${topic} adversity biography`,
      `${lens} historical figure`,
      "perseverance historical figure",
    ];
    const allCandidates: WikidataSearchResult[] = [];
    for (const query of queries) {
      const candidates = await searchWikidata({ query, fetchImpl });
      allCandidates.push(...candidates);
      if (allCandidates.length >= 6) {
        break;
      }
    }
    const candidates = [...new Map(allCandidates.map((candidate) => [candidate.id ?? candidate.label ?? "", candidate])).values()];
    const selected = [...candidates]
      .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
      .find((candidate) => candidate.id && candidate.label);

    if (!selected?.id || !selected.label) {
      const randomPerson = await fetchRandomPersonSummary(fetchImpl);
      if (randomPerson?.title) {
        return {
          topic,
          figure: randomPerson.title,
          context:
            firstSentence(randomPerson.extract) ??
            `${randomPerson.title} is often cited in historical narratives about adaptation and persistence.`,
          takeaway: `Use this as a momentum anchor: act on ${topic} immediately with one concrete, trackable step.`,
          sourceLinks: [
            randomPerson.content_urls?.desktop?.page,
            `https://en.wikipedia.org/wiki/${encodeURIComponent(randomPerson.title.replace(/ /g, "_"))}`,
          ].filter((url): url is string => Boolean(url)),
          confidence: 0.46,
        };
      }
      return fallbackComparison({ topic: topicId, evidence: input.evidence });
    }

    const entity = await fetchWikidataEntity({
      entityId: selected.id,
      fetchImpl,
    });
    const summary = entity.enwikiTitle
      ? await fetchWikipediaSummary({
          title: entity.enwikiTitle,
          fetchImpl,
        })
      : {};

    const contextSentence =
      firstSentence(summary.extract) ??
      `${selected.label} is often referenced for ${selected.description ?? "handling adversity and long horizons"}.`;

    const sourceLinks = [
      `https://www.wikidata.org/wiki/${selected.id}`,
      summary.pageUrl,
      entity.enwikiTitle ? `https://en.wikipedia.org/wiki/${encodeURIComponent(entity.enwikiTitle.replace(/ /g, "_"))}` : undefined,
    ].filter((url): url is string => Boolean(url));

    return {
      topic,
      figure: selected.label,
      period: entity.period,
      context: contextSentence,
      takeaway: `Use ${selected.label} as a reference for ${lens}: do one concrete action on ${topic} immediately, then evaluate result and iterate.`,
      sourceLinks,
      confidence: clamp01(0.45 + (summary.extract ? 0.22 : 0.08) + (entity.period ? 0.08 : 0)),
    };
  } catch {
    return fallbackComparison({ topic: topicId, evidence: input.evidence });
  }
}
