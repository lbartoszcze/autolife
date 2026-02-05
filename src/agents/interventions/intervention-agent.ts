import type {
  CurrentStateAssessment,
  EvidenceFinding,
  EvidenceReference,
  Forecast,
  InterventionPlan,
  UserPreferenceProfile,
} from "../../contracts.js";

export type InterventionSynthesisInput = {
  state: CurrentStateAssessment;
  preferences?: UserPreferenceProfile;
  evidence?: EvidenceFinding[];
  forecast?: Forecast;
  maxCandidates?: number;
};

export type RankedIntervention = InterventionPlan & {
  score: number;
  impactScore: number;
  effortScore: number;
  riskScore: number;
};

export type InterventionSynthesisResult = {
  selected: InterventionPlan;
  alternatives: InterventionPlan[];
  ranked: RankedIntervention[];
};

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

function toTitle(id: string): string {
  return id
    .split("-")
    .filter(Boolean)
    .map((token) => token[0].toUpperCase() + token.slice(1))
    .join(" ");
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function hashId(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return `dyn:${Math.abs(hash).toString(36)}`;
}

function collectObjectiveIds(input: InterventionSynthesisInput): string[] {
  const ids = new Set<string>();

  for (const key of Object.keys(input.state.needs)) {
    ids.add(normalizeId(key));
  }

  for (const key of Object.keys(input.preferences?.objectiveWeights ?? {})) {
    ids.add(normalizeId(key));
  }

  for (const finding of input.evidence ?? []) {
    ids.add(normalizeId(finding.topicId));
  }

  if (ids.size === 0) {
    ids.add("general");
  }

  return [...ids];
}

function scoreObjective(params: {
  objectiveId: string;
  input: InterventionSynthesisInput;
}): {
  impactScore: number;
  effortScore: number;
  riskScore: number;
  references: EvidenceReference[];
} {
  const stateNeed = params.input.state.needs[params.objectiveId] ?? average(Object.values(params.input.state.needs));
  const prefWeight = params.input.preferences?.objectiveWeights[params.objectiveId] ?? 0;

  const matchingEvidence = (params.input.evidence ?? []).filter((finding) => {
    const topicId = normalizeId(finding.topicId);
    return topicId === params.objectiveId || topicId.includes(params.objectiveId) || params.objectiveId.includes(topicId);
  });
  const evidenceConfidence = average(matchingEvidence.map((finding) => finding.confidence));
  const evidenceRefs = matchingEvidence.flatMap((finding) => finding.references).slice(0, 3);

  const forecastSupport = params.input.forecast?.withIntervention.toLowerCase().includes(params.objectiveId.replace(/-/g, " "))
    ? 0.2
    : params.input.forecast
      ? params.input.forecast.confidence * 0.12
      : 0;

  const impactScore = clamp01(stateNeed * 0.46 + prefWeight * 0.24 + evidenceConfidence * 0.2 + forecastSupport);

  const affectLoad = params.input.state.affect.distress * 0.45 + params.input.state.affect.frustration * 0.3;
  const complexityPenalty = Math.min(0.2, params.objectiveId.split("-").length * 0.03);
  const effortScore = clamp01(affectLoad * 0.55 + (1 - params.input.state.affect.momentum) * 0.25 + complexityPenalty);

  const riskScore = clamp01(
    params.input.state.affect.distress * 0.5 +
      (1 - (params.input.state.freshness.completeness ?? 0)) * 0.25 +
      (1 - evidenceConfidence) * 0.25,
  );

  return {
    impactScore,
    effortScore,
    riskScore,
    references: evidenceRefs,
  };
}

function effortBucket(effortScore: number): InterventionPlan["effort"] {
  if (effortScore >= 0.65) {
    return "high";
  }
  if (effortScore >= 0.4) {
    return "medium";
  }
  return "low";
}

function followUpMinutes(effort: InterventionPlan["effort"]): number {
  if (effort === "low") {
    return 90;
  }
  if (effort === "medium") {
    return 240;
  }
  return 720;
}

function makePlan(params: {
  objectiveId: string;
  impactScore: number;
  effortScore: number;
  riskScore: number;
  references: EvidenceReference[];
}): RankedIntervention {
  const effort = effortBucket(params.effortScore);
  const followUp = followUpMinutes(effort);
  const objectiveLabel = toTitle(params.objectiveId);

  const score = clamp01(params.impactScore - params.effortScore * 0.35 - params.riskScore * 0.4);

  return {
    id: hashId(`${params.objectiveId}:${score.toFixed(4)}`),
    objectiveIds: [params.objectiveId],
    action: `In the next 30 minutes, do one 20-minute block on ${objectiveLabel}; log completion as yes/no and one blocker note.`,
    rationale: `Ranked from dynamic signals: impact=${params.impactScore.toFixed(2)}, effort=${params.effortScore.toFixed(2)}, risk=${params.riskScore.toFixed(2)}.`,
    expectedImpact: `Projected short-term gain on ${objectiveLabel} is ${(params.impactScore * 100).toFixed(0)}% confidence-weighted improvement.`,
    effort,
    followUpMinutes: followUp,
    evidence: params.references,
    score,
    impactScore: params.impactScore,
    effortScore: params.effortScore,
    riskScore: params.riskScore,
  };
}

export function synthesizeInterventionPlan(input: InterventionSynthesisInput): InterventionSynthesisResult {
  const objectiveIds = collectObjectiveIds(input);
  const limit = Math.max(1, Math.min(10, input.maxCandidates ?? 5));

  const ranked = objectiveIds
    .map((objectiveId) => {
      const scored = scoreObjective({ objectiveId, input });
      return makePlan({
        objectiveId,
        impactScore: scored.impactScore,
        effortScore: scored.effortScore,
        riskScore: scored.riskScore,
        references: scored.references,
      });
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const selected = ranked[0] ?? makePlan({
    objectiveId: "general",
    impactScore: 0.35,
    effortScore: 0.35,
    riskScore: 0.35,
    references: [],
  });

  return {
    selected,
    alternatives: ranked.slice(1).map(({ score, impactScore, effortScore, riskScore, ...plan }) => plan),
    ranked,
  };
}

export function synthesizeInterventions(input: InterventionSynthesisInput): RankedIntervention[] {
  return synthesizeInterventionPlan(input).ranked;
}

export function selectInterventionPlan(input: InterventionSynthesisInput): InterventionPlan | undefined {
  return synthesizeInterventionPlan(input).selected;
}
