import type {
  CurrentStateAssessment,
  EvidenceFinding,
  Forecast,
  InterventionPlan,
  UserPreferenceProfile,
} from "../contracts.js";
import type { AgentBundle, TranscriptMessage } from "./orchestrator.js";

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

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) ?? []).slice(0, 12);
}

function topEntries(scores: Record<string, number>, limit: number): Array<[string, number]> {
  return Object.entries(scores).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function inferPreference(messages: TranscriptMessage[]): UserPreferenceProfile {
  const weights: Record<string, number> = {};
  for (const message of messages.filter((entry) => entry.role === "user")) {
    for (const token of tokenize(message.text)) {
      const id = normalizeId(token);
      weights[id] = (weights[id] ?? 0) + 1;
    }
  }
  const ranked = topEntries(weights, 6);
  const total = ranked.reduce((sum, [, value]) => sum + value, 0) || 1;
  const objectiveWeights = Object.fromEntries(ranked.map(([id, value]) => [id, value / total]));

  return {
    objectiveWeights: Object.keys(objectiveWeights).length > 0 ? objectiveWeights : { general: 1 },
    interventionAffinity: {},
    toneBias: {
      supportive: 0.55,
      direct: 0.45,
    },
    confidence: clamp01(messages.length / 20),
  };
}

function assessState(messages: TranscriptMessage[], nowMs: number): CurrentStateAssessment {
  const needs: Record<string, number> = {};
  let stressHits = 0;
  let progressHits = 0;

  for (const message of messages.filter((entry) => entry.role === "user")) {
    const text = message.text.toLowerCase();
    if (text.includes("stressed") || text.includes("overwhelmed") || text.includes("stuck")) {
      stressHits += 1;
    }
    if (text.includes("done") || text.includes("progress") || text.includes("better")) {
      progressHits += 1;
    }
    for (const token of tokenize(text)) {
      const id = normalizeId(token);
      needs[id] = (needs[id] ?? 0) + 0.2;
    }
  }

  const rankedNeeds = topEntries(needs, 8);
  const maxNeed = rankedNeeds[0]?.[1] ?? 1;
  const normalizedNeeds = Object.fromEntries(rankedNeeds.map(([id, score]) => [id, clamp01(score / maxNeed)]));

  return {
    needs: Object.keys(normalizedNeeds).length > 0 ? normalizedNeeds : { general: 0.5 },
    affect: {
      frustration: clamp01(stressHits / Math.max(1, messages.length)),
      distress: clamp01(stressHits / Math.max(1, messages.length) * 0.9),
      momentum: clamp01(progressHits / Math.max(1, messages.length)),
    },
    signals: messages.slice(-5).map((message) => `${message.role}:${message.text.slice(0, 60)}`),
    freshness: {
      capturedAt: nowMs,
      ageMinutes: 0,
      completeness: clamp01(messages.length / 12 + 0.2),
    },
  };
}

function findEvidence(topics: string[]): EvidenceFinding[] {
  return topics.slice(0, 4).map((topicId) => ({
    topicId,
    claim: `Preliminary evidence search for ${topicId.replace(/-/g, " ")} returned relevant literature.`,
    confidence: 0.45,
    references: [
      {
        title: `PubMed search: ${topicId}`,
        url: `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(topicId)}`,
        sourceType: "paper",
      },
    ],
  }));
}

function buildForecast(state: CurrentStateAssessment, evidence: EvidenceFinding[]): Forecast {
  const topNeed = topEntries(state.needs, 1)[0]?.[0] ?? "general";
  return {
    horizonDays: 14,
    baseline: `Without intervention, ${topNeed.replace(/-/g, " ")} pressure is likely to persist over two weeks.`,
    withIntervention: `With a targeted action, ${topNeed.replace(/-/g, " ")} pressure should decline within two weeks.`,
    assumptions: [
      "State snapshot remains representative for the horizon.",
      `Data completeness is ${state.freshness.completeness.toFixed(2)}.`,
      `Evidence coverage includes ${evidence.length} topic(s).`,
    ],
    confidence: clamp01(state.freshness.completeness * 0.6 + 0.25),
  };
}

function synthesizeIntervention(state: CurrentStateAssessment, evidence: EvidenceFinding[], forecast: Forecast): {
  selected: InterventionPlan;
  alternatives: InterventionPlan[];
} {
  const topNeed = topEntries(state.needs, 1)[0]?.[0] ?? "general";
  const selected: InterventionPlan = {
    id: `dyn:${topNeed}:micro-step`,
    objectiveIds: [topNeed],
    action: `Do one 20-minute block on ${topNeed.replace(/-/g, " ")} now, then log completion and blocker notes.`,
    rationale: "Derived from top need, state affect, and evidence topics.",
    expectedImpact: forecast.withIntervention,
    effort: state.affect.distress > 0.6 ? "medium" : "low",
    followUpMinutes: state.affect.distress > 0.6 ? 180 : 90,
    evidence: evidence.flatMap((finding) => finding.references).slice(0, 2),
  };

  const alternatives: InterventionPlan[] = topEntries(state.needs, 3)
    .slice(1)
    .map(([need]) => ({
      id: `dyn:${need}:micro-step`,
      objectiveIds: [need],
      action: `Do one 15-minute block on ${need.replace(/-/g, " ")} and capture one metric.` ,
      rationale: "Alternative objective from ranked needs.",
      expectedImpact: `Should reduce pressure on ${need.replace(/-/g, " ")}.`,
      effort: "low",
      followUpMinutes: 120,
      evidence: evidence.filter((finding) => finding.topicId === need).flatMap((finding) => finding.references).slice(0, 1),
    }));

  return {
    selected,
    alternatives,
  };
}

export function createLocalAgentBundle(): AgentBundle {
  return {
    preference: {
      inferProfile: async ({ messages }) => inferPreference(messages),
    },
    state: {
      assess: async ({ messages, nowMs }) => assessState(messages, nowMs),
    },
    evidence: {
      find: async ({ topics }) => findEvidence(topics),
    },
    forecast: {
      project: async ({ state, evidence }) => buildForecast(state, evidence),
    },
    intervention: {
      synthesize: async ({ state, evidence, forecast }) => synthesizeIntervention(state, evidence, forecast),
    },
  };
}
