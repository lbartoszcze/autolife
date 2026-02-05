import type { UserPreferenceProfile } from "../contracts.js";
import {
  applyRecencyDecay,
  buildUserPreferenceProfile,
  inferObjectivesFromInterventionId as inferObjectivesFromInterventionIdAgent,
  type PreferenceMessage,
  type PreferenceOutcome,
} from "../agents/preferences/preference-agent.js";

export type TranscriptRole = "user" | "assistant";

export type TranscriptMessage = PreferenceMessage;

export type LifeCoachPreferenceModel = UserPreferenceProfile;

export function learnPreferencesFromMessages(params: {
  messages: TranscriptMessage[];
  previous?: UserPreferenceProfile;
  now?: number;
}): UserPreferenceProfile {
  return buildUserPreferenceProfile({
    messages: params.messages,
    previous: params.previous,
    now: params.now,
  });
}

export function learnPreferencesFromOutcome(params: {
  messages: TranscriptMessage[];
  outcomes: PreferenceOutcome[];
  previous?: UserPreferenceProfile;
  now?: number;
}): UserPreferenceProfile {
  return buildUserPreferenceProfile({
    messages: params.messages,
    outcomes: params.outcomes,
    previous: params.previous,
    now: params.now,
  });
}

export function applyPreferenceDecay(params: {
  profile: UserPreferenceProfile;
  ageMinutes: number;
  halfLifeDays?: number;
}): UserPreferenceProfile {
  return applyRecencyDecay(params.profile, params.ageMinutes, params.halfLifeDays);
}

export function resolveObjectives(profile: UserPreferenceProfile, limit = 3): string[] {
  return Object.entries(profile.objectiveWeights)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map((entry) => entry[0]);
}

export function inferObjectivesFromInterventionId(interventionId: string): string[] {
  return inferObjectivesFromInterventionIdAgent(interventionId);
}

export function applyObjectivePreferenceBias(params: {
  rawObjectives: Record<string, number>;
  profile: UserPreferenceProfile;
}): Record<string, number> {
  const adjusted: Record<string, number> = {};
  for (const [objectiveId, score] of Object.entries(params.rawObjectives)) {
    const bias = params.profile.objectiveWeights[objectiveId] ?? 0;
    adjusted[objectiveId] = Number((score * (1 + bias)).toFixed(6));
  }
  return adjusted;
}
