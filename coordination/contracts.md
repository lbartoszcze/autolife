# Frozen Contracts

These contracts define payloads exchanged between streams. Keep shape stable; extend with optional fields when possible.

```ts
export type DataFreshness = {
  capturedAt: number;
  ageMinutes: number;
  completeness: number; // 0..1
};

export type UserPreferenceProfile = {
  objectiveWeights: Record<string, number>; // dynamic objective ids
  interventionAffinity: Record<string, number>; // dynamic intervention ids
  toneBias: {
    supportive: number; // 0..1
    direct: number; // 0..1
  };
  confidence: number; // 0..1
};

export type CurrentStateAssessment = {
  needs: Record<string, number>; // dynamic dimension ids, 0..1
  affect: {
    frustration: number;
    distress: number;
    momentum: number;
  };
  signals: string[];
  freshness: DataFreshness;
};

export type EvidenceReference = {
  title: string;
  url: string;
  sourceType: "paper" | "guideline" | "meta-analysis" | "review";
  publishedAt?: string;
};

export type EvidenceFinding = {
  topicId: string;
  claim: string;
  confidence: number; // 0..1
  expectedEffect?: string;
  references: EvidenceReference[];
};

export type Forecast = {
  horizonDays: number;
  baseline: string;
  withIntervention: string;
  assumptions: string[];
  confidence: number; // 0..1
};

export type InterventionPlan = {
  id: string;
  objectiveIds: string[];
  action: string;
  rationale: string;
  expectedImpact: string;
  effort: "low" | "medium" | "high";
  followUpMinutes: number;
  evidence: EvidenceReference[];
};

export type OrchestratorDecision = {
  shouldNudge: boolean;
  reason: string;
  selected?: InterventionPlan;
  alternatives?: InterventionPlan[];
  traceId: string;
};
```

## Compatibility Policy

1. Additive-only changes preferred.
2. Removing fields requires an orchestrator + QA coordinated release.
3. New required fields must include defaults in adapters.
