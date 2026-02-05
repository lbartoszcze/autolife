export type DataFreshness = {
  capturedAt: number;
  ageMinutes: number;
  completeness: number;
};

export type UserPreferenceProfile = {
  objectiveWeights: Record<string, number>;
  interventionAffinity: Record<string, number>;
  toneBias: {
    supportive: number;
    direct: number;
  };
  confidence: number;
};

export type CurrentStateAssessment = {
  needs: Record<string, number>;
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
  confidence: number;
  expectedEffect?: string;
  references: EvidenceReference[];
};

export type Forecast = {
  horizonDays: number;
  baseline: string;
  withIntervention: string;
  assumptions: string[];
  confidence: number;
};

export type MentorComparison = {
  topic: string;
  figure: string;
  period?: string;
  context: string;
  takeaway: string;
  sourceLinks: string[];
  confidence: number;
};

export type SoraVideoPlan = {
  provider: "sora";
  status: "ready" | "queued" | "skipped";
  title: string;
  prompt: string;
  storyboard: string[];
  durationSeconds: number;
  callToAction: string;
  jobId?: string;
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
  mentorComparison?: MentorComparison;
  videoPlan?: SoraVideoPlan;
};

export type OrchestratorDecision = {
  shouldNudge: boolean;
  reason: string;
  selected?: InterventionPlan;
  alternatives?: InterventionPlan[];
  traceId: string;
};
