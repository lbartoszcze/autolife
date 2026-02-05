import type {
  CurrentStateAssessment,
  EvidenceFinding,
  EvidenceReference,
  Forecast,
  InterventionPlan,
  UserPreferenceProfile,
} from "../contracts.js";
import type { AgentPorts, TranscriptMessage } from "./ports.js";

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

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function topEntries(values: Record<string, number>, limit: number): Array<[string, number]> {
  return Object.entries(values).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function inferNeeds(messages: TranscriptMessage[]): Record<string, number> {
  const counts = new Map<string, number>();
  const userMessages = messages.filter((message) => message.role === "user").slice(-40);

  for (const message of userMessages) {
    for (const token of tokenize(message.text)) {
      const key = normalizeId(token);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  if (counts.size === 0) {
    return { general: 0.5 };
  }

  const denominator = Math.max(1, userMessages.length * 2);
  const result: Record<string, number> = {};
  for (const [key, value] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    result[key] = round3(clamp01(0.2 + value / denominator * 0.8));
  }
  return result;
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

function inferAffect(messages: TranscriptMessage[], needs: Record<string, number>) {
  const meanNeed = average(Object.values(needs));
  const users = messages.filter((message) => message.role === "user").slice(-24);
  const denominator = Math.max(1, users.length);

  return {
    frustration: round3(clamp01(countCueHits(users, FRUSTRATION_CUES) / denominator * 0.45 + meanNeed * 0.45)),
    distress: round3(clamp01(countCueHits(users, DISTRESS_CUES) / denominator * 0.5 + meanNeed * 0.5)),
    momentum: round3(clamp01(countCueHits(users, MOMENTUM_CUES) / denominator * 0.45 + (1 - meanNeed) * 0.35)),
  };
}

function evidenceReference(topicId: string): EvidenceReference {
  const query = encodeURIComponent(`${topicId.replace(/-/g, " ")} behavior intervention randomized trial`);
  return {
    title: `PubMed query for ${topicId}`,
    url: `https://pubmed.ncbi.nlm.nih.gov/?term=${query}`,
    sourceType: "paper",
  };
}

export function createDefaultAgentPorts(nowMs = Date.now()): AgentPorts {
  return {
    preference: {
      buildProfile: async (messages) => {
        const needs = inferNeeds(messages);
        const objectiveWeights = (() => {
          const total = Math.max(1e-6, Object.values(needs).reduce((sum, score) => sum + score, 0));
          return Object.fromEntries(
            Object.entries(needs).map(([id, score]) => [id, round3(clamp01(score / total))]),
          );
        })();

        const supportiveHits = countCueHits(messages, ["gentle", "supportive", "kind", "overwhelmed"]);
        const directHits = countCueHits(messages, ["direct", "brief", "concise", "blunt"]);
        const supportive = round3(clamp01((supportiveHits + 1) / (supportiveHits + directHits + 2)));

        return {
          objectiveWeights,
          interventionAffinity: {},
          toneBias: {
            supportive,
            direct: round3(clamp01(1 - supportive)),
          },
          confidence: round3(clamp01(messages.length / 40)),
        } as UserPreferenceProfile;
      },
    },

    state: {
      assessState: async (messages) => {
        const needs = inferNeeds(messages);
        const affect = inferAffect(messages, needs);
        const latestTs = messages
          .map((message) => message.timestamp)
          .filter((value): value is number => typeof value === "number")
          .sort((a, b) => b - a)[0];
        const capturedAt = latestTs ?? nowMs;
        const ageMinutes = round3(Math.max(0, nowMs - capturedAt) / 60_000);

        return {
          needs,
          affect,
          signals: messages
            .filter((message) => message.role === "user")
            .slice(-8)
            .map((message) => message.text),
          freshness: {
            capturedAt,
            ageMinutes,
            completeness: round3(clamp01(Math.min(1, messages.length / 16))),
          },
        } as CurrentStateAssessment;
      },
    },

    evidence: {
      buildEvidence: async ({ state }) => {
        const selected = topEntries(state.needs, 3);
        return selected.map(([topicId, score]) => ({
          topicId,
          claim: `Evidence lookup generated dynamically for ${topicId}.`,
          confidence: round3(clamp01(0.35 + score * 0.45)),
          expectedEffect: `Likely improvement in ${topicId.replace(/-/g, " ")} with consistent execution.`,
          references: [evidenceReference(topicId)],
        })) as EvidenceFinding[];
      },
    },

    forecast: {
      buildForecast: async ({ state, evidence }) => {
        const top = topEntries(state.needs, 2)
          .map(([id, score]) => `${id.replace(/-/g, " ")} (${score.toFixed(2)})`)
          .join(", ");

        return {
          horizonDays: 14,
          baseline: `Without intervention, pressure likely persists on ${top || "general"}.`,
          withIntervention: `With intervention, trajectory improves if the selected action is completed consistently over 14 days.`,
          assumptions: [
            "Current transcript patterns remain similar during the horizon.",
            `Data completeness=${state.freshness.completeness.toFixed(2)} at forecast time.`,
            "User executes at least one measurable step per day.",
          ],
          confidence: round3(clamp01(0.35 + state.freshness.completeness * 0.35 + average(evidence.map((item) => item.confidence)) * 0.25)),
        } as Forecast;
      },
    },

    intervention: {
      buildPlan: async ({ state, evidence, forecast }) => {
        const candidates = topEntries(state.needs, 4).map(([objectiveId, needScore], index) => {
          const evidenceForObjective = evidence
            .filter((item) => normalizeId(item.topicId).includes(normalizeId(objectiveId)))
            .flatMap((item) => item.references)
            .slice(0, 2);

          const effort = needScore >= 0.7 ? "medium" : needScore >= 0.85 ? "high" : "low";
          const followUpMinutes = effort === "high" ? 180 : effort === "medium" ? 90 : 45;

          return {
            id: `dyn:${normalizeId(objectiveId)}:${normalizeId(String(index + 1))}`,
            objectiveIds: [normalizeId(objectiveId)],
            action: `Run one 15-minute block on ${objectiveId.replace(/-/g, " ")} now and record one completion marker.`,
            rationale: `Generated from state need=${needScore.toFixed(2)}, evidence links=${evidenceForObjective.length}, forecast confidence=${forecast.confidence.toFixed(2)}.`,
            expectedImpact: `Expected reduction in ${objectiveId.replace(/-/g, " ")} load over ${forecast.horizonDays} days.`,
            effort,
            followUpMinutes,
            evidence: evidenceForObjective,
          } as InterventionPlan;
        });

        return {
          selected: candidates[0],
          alternatives: candidates.slice(1),
        };
      },
    },
  };
}
