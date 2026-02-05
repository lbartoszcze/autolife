import type {
  CurrentStateAssessment,
  EvidenceFinding,
  Forecast,
  InterventionPlan,
  UserPreferenceProfile,
} from "../contracts.js";

export type TranscriptMessage = {
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
};

export type AgentPorts = {
  preference: {
    buildProfile: (messages: TranscriptMessage[]) => Promise<UserPreferenceProfile>;
  };
  state: {
    assessState: (messages: TranscriptMessage[]) => Promise<CurrentStateAssessment>;
  };
  evidence: {
    buildEvidence: (params: {
      state: CurrentStateAssessment;
      preferences: UserPreferenceProfile;
      messages: TranscriptMessage[];
    }) => Promise<EvidenceFinding[]>;
  };
  forecast: {
    buildForecast: (params: {
      state: CurrentStateAssessment;
      preferences: UserPreferenceProfile;
      evidence: EvidenceFinding[];
    }) => Promise<Forecast>;
  };
  intervention: {
    buildPlan: (params: {
      state: CurrentStateAssessment;
      preferences: UserPreferenceProfile;
      evidence: EvidenceFinding[];
      forecast: Forecast;
    }) => Promise<{ selected?: InterventionPlan; alternatives: InterventionPlan[] }>;
  };
};

export type OrchestratorInput = {
  messages: TranscriptMessage[];
  nowMs?: number;
  cooldownMinutes?: number;
  maxNudgesPerDay?: number;
  recentDispatches?: Array<{ sentAt: number; interventionId: string }>;
};

export type OrchestratorTrace = {
  traceId: string;
  summary: string;
  gates: {
    cooldownBlocked: boolean;
    pacingBlocked: boolean;
    safetyBlocked: boolean;
  };
  scores: {
    stateCompleteness: number;
    forecastConfidence: number;
    selectedEvidenceConfidence: number;
  };
  selectedInterventionId?: string;
};
