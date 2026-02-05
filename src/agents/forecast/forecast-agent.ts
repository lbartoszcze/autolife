import type {
  CurrentStateAssessment,
  EvidenceFinding,
  Forecast,
  InterventionPlan,
  UserPreferenceProfile,
} from "../../contracts.js";

export type ForecastAgentInput = {
  state: CurrentStateAssessment;
  preferences?: UserPreferenceProfile;
  evidence?: EvidenceFinding[];
  intervention?: Pick<InterventionPlan, "id" | "objectiveIds" | "expectedImpact" | "effort">;
  horizonDays?: number;
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

function objectiveLabel(id: string): string {
  return id.replace(/-/g, " ");
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function topNeeds(needs: Record<string, number>, limit = 3): Array<[string, number]> {
  return Object.entries(needs).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function baselineRiskIndex(state: CurrentStateAssessment): number {
  const needLoad = average(Object.values(state.needs));
  const affectLoad = state.affect.distress * 0.45 + state.affect.frustration * 0.35 + (1 - state.affect.momentum) * 0.2;
  const dataPenalty = 1 - state.freshness.completeness;
  return clamp01(needLoad * 0.55 + affectLoad * 0.35 + dataPenalty * 0.1);
}

function interventionAdjustment(params: {
  intervention?: ForecastAgentInput["intervention"];
  evidence: EvidenceFinding[];
  preferences?: UserPreferenceProfile;
  state: CurrentStateAssessment;
}): number {
  const intervention = params.intervention;
  if (!intervention) {
    return 0;
  }

  const objectiveSet = new Set(intervention.objectiveIds.map((id) => id.toLowerCase()));
  const matchingNeedStrength = average(
    Object.entries(params.state.needs)
      .filter(([id]) => objectiveSet.has(id.toLowerCase()))
      .map(([, score]) => score),
  );

  const evidenceStrength = average(
    params.evidence
      .filter((finding) => objectiveSet.has(finding.topicId.toLowerCase()) || finding.topicId.includes("-"))
      .map((finding) => finding.confidence),
  );

  const preferenceAffinity = params.preferences
    ? average(
        Object.entries(params.preferences.interventionAffinity)
          .filter(([id]) => id.includes(intervention.id.toLowerCase()))
          .map(([, score]) => clamp01((score + 1) / 2)),
      )
    : 0;

  const effortPenalty =
    intervention.effort === "high" ? 0.22 : intervention.effort === "medium" ? 0.12 : 0.04;

  return clamp01(matchingNeedStrength * 0.45 + evidenceStrength * 0.3 + preferenceAffinity * 0.2 - effortPenalty);
}

function buildAssumptions(params: {
  state: CurrentStateAssessment;
  intervention?: ForecastAgentInput["intervention"];
  evidence: EvidenceFinding[];
  horizonDays: number;
}): string[] {
  const assumptions: string[] = [];
  assumptions.push(`State snapshot is representative for the next ${params.horizonDays} days.`);
  assumptions.push(
    `Data completeness=${params.state.freshness.completeness.toFixed(2)} and data freshness age=${params.state.freshness.ageMinutes.toFixed(1)} minutes.`,
  );

  if (params.intervention) {
    assumptions.push(`Intervention adherence remains consistent at least once per day.`);
    assumptions.push(`Intervention effort estimated as ${params.intervention.effort}.`);
  } else {
    assumptions.push("No explicit intervention effect is applied in the baseline.");
  }

  if (params.evidence.length > 0) {
    const strongest = [...params.evidence].sort((a, b) => b.confidence - a.confidence)[0];
    assumptions.push(`Evidence weighting anchored on topic ${strongest.topicId} (${strongest.confidence.toFixed(2)} confidence).`);
  } else {
    assumptions.push("Evidence signal is limited, so forecast leans on state trajectory only.");
  }

  return assumptions;
}

export function buildForecast(input: ForecastAgentInput): Forecast {
  const horizonDays = Math.max(1, Math.min(90, Math.round(input.horizonDays ?? 14)));
  const evidence = input.evidence ?? [];

  const risk = baselineRiskIndex(input.state);
  const adjustment = interventionAdjustment({
    intervention: input.intervention,
    evidence,
    preferences: input.preferences,
    state: input.state,
  });

  const top = topNeeds(input.state.needs, 3);
  const focusText =
    top.length > 0
      ? top.map(([id, score]) => `${objectiveLabel(id)} (${score.toFixed(2)})`).join(", ")
      : "general load (0.50)";

  const baseline =
    risk >= 0.65
      ? `Without intervention, high-load dimensions likely remain elevated over ${horizonDays} days: ${focusText}.`
      : risk >= 0.4
        ? `Without intervention, mixed trajectory is expected over ${horizonDays} days with partial recovery: ${focusText}.`
        : `Without intervention, trajectory is relatively stable over ${horizonDays} days, with low drift risk in: ${focusText}.`;

  const adjustedRisk = clamp01(risk - adjustment * 0.45);
  const intervention = input.intervention;
  const withIntervention = intervention
    ? adjustedRisk <= 0.35
      ? `With intervention ${intervention.id}, projected trajectory improves materially within ${horizonDays} days, reducing pressure on ${intervention.objectiveIds.map(objectiveLabel).join(", ")}.`
      : `With intervention ${intervention.id}, projected trajectory improves modestly within ${horizonDays} days, but residual risk remains on ${intervention.objectiveIds.map(objectiveLabel).join(", ")}.`
    : `With a targeted intervention on ${top.map(([id]) => objectiveLabel(id)).join(", ")}, projected trajectory can improve within ${horizonDays} days versus baseline.`;

  const dataConfidence = input.state.freshness.completeness * 0.5 + clamp01(1 - input.state.freshness.ageMinutes / (24 * 60)) * 0.2;
  const evidenceConfidence = evidence.length > 0 ? average(evidence.map((finding) => finding.confidence)) * 0.2 : 0.05;
  const horizonPenalty = Math.min(0.22, horizonDays / 120);
  const interventionConfidenceBoost = input.intervention ? 0.08 : 0;
  const confidence = round3(clamp01(dataConfidence + evidenceConfidence + interventionConfidenceBoost + 0.2 - horizonPenalty));

  return {
    horizonDays,
    baseline,
    withIntervention,
    assumptions: buildAssumptions({
      state: input.state,
      intervention: input.intervention,
      evidence,
      horizonDays,
    }),
    confidence,
  };
}
