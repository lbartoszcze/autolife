export type TranscriptRole = "user" | "assistant";

export type TranscriptMessage = {
  role: TranscriptRole;
  text: string;
  timestamp?: number;
};

export type LifeCoachNeedScores = Record<string, number>;

export type LifeCoachAffectScores = {
  frustration: number;
  distress: number;
  momentum: number;
};

export type LifeCoachPreferenceModel = {
  objectiveBias: Record<string, number>;
  interventionAffinity: Record<string, number>;
  supportiveToneBias: number;
  lastLearnedMessageTs: number;
};

export type LifeCoachHistoryStatus = "sent" | "completed" | "ignored" | "rejected";

export type ResolvedTone = "supportive" | "direct";

const DEFAULT_GENERIC_OBJECTIVE = "general";
const DEFAULT_OBJECTIVE_WEIGHT = 1;

const COMPLETION_HINTS = [
  "done",
  "did it",
  "i did",
  "completed",
  "finished",
  "went for a walk",
  "walked",
  "i stopped scrolling",
  "off social",
  "focused",
  "made progress",
];

const REJECTION_HINTS = [
  "stop reminding",
  "stop nudging",
  "leave me alone",
  "not now",
  "later",
  "don't want",
  "no thanks",
  "annoying",
  "frustrating",
];

const POSITIVE_HINTS = [
  "calm",
  "better",
  "good",
  "great",
  "focused",
  "productive",
  "energized",
  "happy",
];

const STRESS_HINTS = [
  "stressed",
  "overwhelmed",
  "anxious",
  "panic",
  "frustrated",
  "angry",
  "burned out",
];

const LOW_ENERGY_HINTS = ["tired", "exhausted", "sleepy", "drained", "fatigue", "fatigued"];
const LOW_FOCUS_HINTS = [
  "can't focus",
  "cannot focus",
  "distracted",
  "procrastinating",
  "doomscroll",
  "scrolling",
  "stuck",
];
const LOW_MOOD_HINTS = ["sad", "down", "hopeless", "lonely", "depressed", "empty"];

const FRUSTRATION_HINTS = [
  "frustrated",
  "annoying",
  "irritated",
  "angry",
  "stuck",
  "this is not working",
];

const GOAL_CUES = ["want", "goal", "trying to", "need to", "would like", "prefer", "helps", "works"];
const AVOID_CUES = ["don't", "do not", "can't", "cannot", "hate", "dislike", "annoying", "frustrating", "stop"];

const SCIENCE_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "always",
  "because",
  "been",
  "before",
  "being",
  "between",
  "could",
  "did",
  "does",
  "doing",
  "dont",
  "from",
  "have",
  "having",
  "just",
  "like",
  "maybe",
  "more",
  "need",
  "now",
  "really",
  "still",
  "that",
  "their",
  "them",
  "then",
  "this",
  "want",
  "with",
  "would",
  "your",
]);

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function clampSigned(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(-1, Math.min(1, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function countHintMatches(text: string, hints: string[]): number {
  let count = 0;
  for (const hint of hints) {
    if (text.includes(hint)) {
      count += 1;
    }
  }
  return count;
}

function countMentions(messages: TranscriptMessage[], hints: string[]): number {
  return messages.reduce((acc, msg) => acc + countHintMatches(msg.text, hints), 0);
}

function containsAny(text: string, hints: string[]): boolean {
  return hints.some((hint) => text.includes(hint));
}

function normalizeAxisId(value: string): string {
  const compact = value
    .trim()
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return compact || DEFAULT_GENERIC_OBJECTIVE;
}

function extractMeaningfulTokensFromText(text: string): string[] {
  const tokens = text.match(/[a-z][a-z0-9'-]{2,}/g) ?? [];
  return tokens
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3 && !SCIENCE_STOPWORDS.has(token));
}

function countDimensionMentions(messages: TranscriptMessage[], dimension: string): number {
  const token = normalizeAxisId(dimension);
  if (!token) {
    return 0;
  }
  const phrase = token.replaceAll("-", " ");
  const hints = [token, phrase].filter((value) => value.length > 0);
  return countMentions(messages, hints);
}

function getPrimaryNeedKey(needs: LifeCoachNeedScores): string {
  return Object.entries(needs).toSorted((a, b) => b[1] - a[1])[0]?.[0] ?? DEFAULT_GENERIC_OBJECTIVE;
}

function getAverageNeed(needs: LifeCoachNeedScores): number {
  const values = Object.values(needs);
  if (!values.length) {
    return 0.5;
  }
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function extractTopDimensions(messages: TranscriptMessage[], limit = 6): string[] {
  const counts = new Map<string, number>();
  const userMessages = messages.filter((msg) => msg.role === "user").slice(-24);
  for (const message of userMessages) {
    const tokens = extractMeaningfulTokensFromText(message.text);
    for (const token of tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .map(([token]) => normalizeAxisId(token))
    .filter(Boolean);
  return [...new Set(ranked)].slice(0, limit);
}

export function estimateNeeds(messages: TranscriptMessage[]): LifeCoachNeedScores {
  const recentUsers = messages.filter((msg) => msg.role === "user").slice(-24);
  if (recentUsers.length === 0) {
    return { [DEFAULT_GENERIC_OBJECTIVE]: 0.5 };
  }

  const dimensions = extractTopDimensions(recentUsers, 6);
  if (!dimensions.length) {
    dimensions.push(DEFAULT_GENERIC_OBJECTIVE);
  }

  const positiveHits = countMentions(recentUsers, POSITIVE_HINTS) + countMentions(recentUsers, COMPLETION_HINTS);
  const stressHits =
    countMentions(recentUsers, STRESS_HINTS) +
    countMentions(recentUsers, FRUSTRATION_HINTS) +
    countMentions(recentUsers, REJECTION_HINTS);
  const lowActivationHits = countMentions(recentUsers, LOW_ENERGY_HINTS) + countMentions(recentUsers, LOW_FOCUS_HINTS);
  const denom = Math.max(1, recentUsers.length * 2);
  const baseLoad = clamp01(stressHits / denom + lowActivationHits / (denom * 1.5) - positiveHits / (denom * 2));

  const needs: LifeCoachNeedScores = {};
  for (const dimension of dimensions) {
    const mentions = countDimensionMentions(recentUsers, dimension);
    const mentionSignal = clamp01(mentions / Math.max(1, recentUsers.length * 1.2));
    const dimensionToken = normalizeAxisId(dimension).replaceAll("-", " ");
    const messageNegativity = recentUsers.filter(
      (msg) =>
        msg.text.includes(dimensionToken) &&
        (containsAny(msg.text, STRESS_HINTS) ||
          containsAny(msg.text, FRUSTRATION_HINTS) ||
          containsAny(msg.text, REJECTION_HINTS) ||
          containsAny(msg.text, LOW_FOCUS_HINTS) ||
          containsAny(msg.text, LOW_ENERGY_HINTS)),
    ).length;
    const negativitySignal = clamp01(messageNegativity / Math.max(1, recentUsers.length));
    const severity = clamp01(0.28 + mentionSignal * 0.5 + negativitySignal * 0.3 + baseLoad * 0.2);
    needs[dimension] = round2(severity);
  }
  return needs;
}

export function estimateAffect(
  messages: TranscriptMessage[],
  needs: LifeCoachNeedScores,
): LifeCoachAffectScores {
  const recentUsers = messages.filter((msg) => msg.role === "user").slice(-20);
  const averageNeed = getAverageNeed(needs);
  const topNeed = needs[getPrimaryNeedKey(needs)] ?? averageNeed;
  if (recentUsers.length === 0) {
    return {
      frustration: round2(clamp01(averageNeed * 0.55 + topNeed * 0.15)),
      distress: round2(clamp01(averageNeed * 0.6)),
      momentum: round2(clamp01(0.35 - averageNeed * 0.28)),
    };
  }
  const denom = Math.max(1, recentUsers.length * 2);
  const frustrationHits =
    countMentions(recentUsers, FRUSTRATION_HINTS) + countMentions(recentUsers, REJECTION_HINTS);
  const distressHits = countMentions(recentUsers, STRESS_HINTS) + countMentions(recentUsers, LOW_MOOD_HINTS);
  const positiveHits = countMentions(recentUsers, POSITIVE_HINTS) + countMentions(recentUsers, COMPLETION_HINTS);
  const frustration = clamp01(frustrationHits / denom + averageNeed * 0.35 + topNeed * 0.18);
  const distress = clamp01(
    distressHits / denom + averageNeed * 0.45 + topNeed * 0.22 - positiveHits / (denom * 2),
  );
  const momentum = clamp01(positiveHits / denom + (1 - averageNeed) * 0.35 - frustration / 4);
  return {
    frustration: round2(frustration),
    distress: round2(distress),
    momentum: round2(momentum),
  };
}

export function resolveObjectives(
  cfgObjectives: Partial<Record<string, number>> | undefined,
  needs: LifeCoachNeedScores,
): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const objective of Object.keys(needs)) {
    merged[normalizeAxisId(objective)] = DEFAULT_OBJECTIVE_WEIGHT;
  }
  for (const [objective, value] of Object.entries(cfgObjectives ?? {})) {
    if (typeof value !== "number") {
      continue;
    }
    merged[normalizeAxisId(objective)] = Math.max(0, Math.min(2, value));
  }
  if (!Object.keys(merged).length) {
    merged[DEFAULT_GENERIC_OBJECTIVE] = DEFAULT_OBJECTIVE_WEIGHT;
  }
  return merged;
}

export function applyObjectivePreferenceBias(params: {
  objectives: Record<string, number>;
  preferences: LifeCoachPreferenceModel;
}): Record<string, number> {
  const merged = { ...params.objectives };
  for (const objective of Object.keys(merged)) {
    const bias = params.preferences.objectiveBias[objective] ?? 0;
    merged[objective] = Math.max(0, Math.min(2, round2(merged[objective] * (1 + bias * 0.35))));
  }
  return merged;
}

export function applyPreferenceDecay(params: {
  preferences: LifeCoachPreferenceModel;
  now: number;
  updatedAt: number;
}): void {
  const elapsedMs = Math.max(0, params.now - params.updatedAt);
  if (elapsedMs <= 0) {
    return;
  }
  const elapsedDays = elapsedMs / (24 * 60 * 60_000);
  if (elapsedDays < 0.25) {
    return;
  }
  const retention = Math.pow(0.96, elapsedDays);
  for (const objective of Object.keys(params.preferences.objectiveBias)) {
    params.preferences.objectiveBias[objective] = round2(
      clampSigned(params.preferences.objectiveBias[objective] * retention),
    );
  }
  for (const intervention of Object.keys(params.preferences.interventionAffinity)) {
    params.preferences.interventionAffinity[intervention] = round2(
      clampSigned(params.preferences.interventionAffinity[intervention] * retention),
    );
  }
  params.preferences.supportiveToneBias = round2(
    clampSigned(params.preferences.supportiveToneBias * retention),
  );
}

export function learnPreferencesFromMessages(params: {
  state: { preferences: LifeCoachPreferenceModel };
  messages: TranscriptMessage[];
}): void {
  const learnable = params.messages.filter(
    (msg) =>
      msg.role === "user" &&
      typeof msg.timestamp === "number" &&
      msg.timestamp > params.state.preferences.lastLearnedMessageTs,
  );
  if (learnable.length === 0) {
    return;
  }
  let maxTimestamp = params.state.preferences.lastLearnedMessageTs;
  for (const message of learnable) {
    const text = message.text;
    const positiveCueHits = countHintMatches(text, GOAL_CUES);
    const avoidCueHits = countHintMatches(text, AVOID_CUES);
    const completionHits = countHintMatches(text, COMPLETION_HINTS);
    const frustrationHits = countHintMatches(text, REJECTION_HINTS) + countHintMatches(text, FRUSTRATION_HINTS);

    const dimensions = extractTopDimensions(
      [{ role: "user", text, timestamp: message.timestamp }],
      3,
    );
    if (!dimensions.length) {
      dimensions.push(DEFAULT_GENERIC_OBJECTIVE);
    }
    for (const objective of dimensions) {
      const objectiveToken = normalizeAxisId(objective);
      const mentions = Math.max(
        1,
        countHintMatches(text, [objectiveToken, objectiveToken.replaceAll("-", " ")]),
      );
      const upDelta = positiveCueHits > 0 ? 0.03 * mentions * positiveCueHits : 0;
      const downDelta = avoidCueHits > 0 ? 0.02 * mentions * avoidCueHits : 0;
      const current = params.state.preferences.objectiveBias[objectiveToken] ?? 0;
      params.state.preferences.objectiveBias[objectiveToken] = round2(
        clampSigned(current + upDelta - downDelta),
      );
    }
    if (frustrationHits > 0) {
      params.state.preferences.supportiveToneBias = round2(
        clampSigned(params.state.preferences.supportiveToneBias + 0.08 * frustrationHits),
      );
    } else if (completionHits > 0) {
      params.state.preferences.supportiveToneBias = round2(
        clampSigned(params.state.preferences.supportiveToneBias - 0.03),
      );
    }
    if (typeof message.timestamp === "number" && message.timestamp > maxTimestamp) {
      maxTimestamp = message.timestamp;
    }
  }
  params.state.preferences.lastLearnedMessageTs = maxTimestamp;
}

export function inferObjectivesFromInterventionId(intervention: string): string[] {
  const normalized = intervention.toLowerCase();
  if (normalized.startsWith("dyn:")) {
    const parts = normalized.split(":");
    const axis = normalizeAxisId(parts[1] ?? "");
    return axis ? [axis] : [DEFAULT_GENERIC_OBJECTIVE];
  }
  const guessed = normalized
    .split(/[^a-z0-9]+/)
    .map(normalizeAxisId)
    .filter((token) => token.length > 2 && token !== "dyn")
    .slice(0, 2);
  if (!guessed.length) {
    guessed.push(DEFAULT_GENERIC_OBJECTIVE);
  }
  return [...new Set(guessed)];
}

export function learnPreferencesFromOutcome(params: {
  state: { preferences: LifeCoachPreferenceModel };
  intervention: string;
  status: LifeCoachHistoryStatus;
  tone?: ResolvedTone;
}): void {
  if (params.status === "sent") {
    return;
  }
  const affinityDelta =
    params.status === "completed" ? 0.08 : params.status === "ignored" ? -0.04 : -0.1;
  const currentAffinity = params.state.preferences.interventionAffinity[params.intervention] ?? 0;
  params.state.preferences.interventionAffinity[params.intervention] = round2(
    clampSigned(currentAffinity + affinityDelta),
  );
  const inferredObjectives = inferObjectivesFromInterventionId(params.intervention);
  for (const objective of inferredObjectives) {
    const delta = params.status === "completed" ? 0.03 : params.status === "rejected" ? -0.02 : 0;
    if (!delta) {
      continue;
    }
    params.state.preferences.objectiveBias[objective] = round2(
      clampSigned((params.state.preferences.objectiveBias[objective] ?? 0) + delta),
    );
  }
  if (params.status === "rejected") {
    const toneDelta = params.tone === "direct" ? 0.08 : 0.03;
    params.state.preferences.supportiveToneBias = round2(
      clampSigned(params.state.preferences.supportiveToneBias + toneDelta),
    );
  } else if (params.status === "completed" && params.tone === "direct") {
    params.state.preferences.supportiveToneBias = round2(
      clampSigned(params.state.preferences.supportiveToneBias - 0.04),
    );
  }
}

export {
  selectInterventionPlan,
  synthesizeInterventionPlan,
  synthesizeInterventions,
} from "../agents/interventions/intervention-agent.js";
