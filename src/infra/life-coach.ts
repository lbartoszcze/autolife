import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { resolveStateDir } from "../config/paths.js";
import type {
  HeartbeatLifeCoachConfig,
  LifeCoachInterventionId,
  LifeCoachObjective,
} from "../config/types.agent-defaults.js";
import { normalizeAgentId } from "../routing/session-key.js";

type TranscriptRole = "user" | "assistant";

type TranscriptMessage = {
  role: TranscriptRole;
  text: string;
  timestamp?: number;
};

type LifeCoachNeedScores = Record<LifeCoachObjective, number>;

type LifeCoachAffectScores = {
  frustration: number;
  distress: number;
  momentum: number;
};

type LifeCoachStats = Record<
  LifeCoachInterventionId,
  {
    sent: number;
    completed: number;
    ignored: number;
    rejected: number;
  }
>;

type LifeCoachHistoryEntry = {
  id: string;
  intervention: LifeCoachInterventionId;
  sentAt: number;
  status: "sent" | "completed" | "ignored" | "rejected";
  followUpMinutes: number;
  followUpSentAt?: number;
  tone?: ResolvedTone;
  note?: string;
};

type LifeCoachPreferenceModel = {
  objectiveBias: Record<LifeCoachObjective, number>;
  interventionAffinity: Record<LifeCoachInterventionId, number>;
  supportiveToneBias: number;
  lastLearnedMessageTs: number;
};

type LifeCoachStateFile = {
  version: 2;
  updatedAt: number;
  history: LifeCoachHistoryEntry[];
  stats: LifeCoachStats;
  preferences: LifeCoachPreferenceModel;
};

type InterventionSpec = {
  id: LifeCoachInterventionId;
  objectives: Partial<Record<LifeCoachObjective, number>>;
  effects: Partial<Record<LifeCoachObjective, number>>;
  baseFriction: number;
  followUpMinutes: number;
  action: (params: { needs: LifeCoachNeedScores; tone: ResolvedTone }) => string;
  fallback: string;
  evidenceNote: string;
  toolHint: string;
};

type ResolvedTone = "supportive" | "direct";

export type LifeCoachDecision = {
  phase: "initial" | "follow-up";
  intervention: LifeCoachInterventionId;
  score: number;
  rationale: string;
  action: string;
  fallback: string;
  followUpMinutes: number;
  tone: ResolvedTone;
  soraPrompt?: string;
  needs: LifeCoachNeedScores;
  affect: LifeCoachAffectScores;
  evidenceNote: string;
  toolHint: string;
};

export type LifeCoachHeartbeatPlan = {
  prompt: string;
  decision?: LifeCoachDecision;
};

const DEFAULT_COOLDOWN_MINUTES = 90;
const DEFAULT_MAX_NUDGES_PER_DAY = 6;
const DEFAULT_ALLOW_SORA = true;
const DEFAULT_DONE_TOKEN = "DONE";
const DEFAULT_HELP_TOKEN = "NEED_HELP";

const DEFAULT_OBJECTIVES: Record<LifeCoachObjective, number> = {
  mood: 1,
  energy: 0.9,
  focus: 1,
  movement: 1,
  socialMediaReduction: 1.2,
  stressRegulation: 1,
};

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
const SOCIAL_URGE_HINTS = [
  "social media",
  "instagram",
  "tiktok",
  "twitter",
  "x.com",
  "youtube shorts",
  "doomscroll",
  "scrolling",
];
const MOVEMENT_HINTS = ["walk", "outside", "steps", "exercise", "workout", "run"];

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

const INTERVENTION_KEYWORDS: Record<LifeCoachInterventionId, string[]> = {
  walk: ["walk", "outside", "steps", "exercise", "move"],
  "social-block": ["social media", "instagram", "tiktok", "twitter", "x.com", "scroll"],
  "focus-sprint": ["focus", "deep work", "pomodoro", "task", "procrastinating"],
  breathing: ["breathing", "breath", "calm", "anxious", "panic"],
  hydration: ["water", "hydrate", "dehydrated", "drink"],
  "sora-visualization": ["visualization", "future self", "sora", "video"],
};

const OBJECTIVE_KEYWORDS: Record<LifeCoachObjective, string[]> = {
  mood: ["happy", "better", "mood", "sad", "down", "lonely"],
  energy: ["energy", "tired", "fatigue", "exhausted", "sleepy"],
  focus: ["focus", "distracted", "procrastinating", "productive"],
  movement: ["walk", "outside", "exercise", "steps", "workout"],
  socialMediaReduction: ["social media", "instagram", "tiktok", "twitter", "scrolling", "doomscroll"],
  stressRegulation: ["stress", "anxious", "panic", "calm", "overwhelmed"],
};

const INTERVENTIONS: InterventionSpec[] = [
  {
    id: "walk",
    objectives: {
      movement: 1,
      mood: 0.7,
      stressRegulation: 0.7,
      focus: 0.5,
      socialMediaReduction: 0.5,
    },
    effects: {
      movement: 0.9,
      mood: 0.45,
      stressRegulation: 0.4,
      focus: 0.35,
      socialMediaReduction: 0.3,
      energy: 0.2,
    },
    baseFriction: 0.4,
    followUpMinutes: 45,
    action: ({ needs, tone }) => {
      const duration = needs.energy > 0.75 ? 10 : needs.focus > 0.7 ? 15 : 20;
      return tone === "supportive"
        ? `Take a ${duration}-minute walk now, without social apps open, and notice one detail around you every 2 minutes.`
        : `Start a ${duration}-minute walk now. Keep your phone in pocket and no social feeds during the walk.`;
    },
    fallback: "If going outside is hard right now, do a 5-minute indoor walk and reopen this conversation.",
    evidenceNote:
      "Brief outdoor movement and light exposure are associated with better mood regulation and improved attentional control.",
    toolHint: "Use a 10-20 minute timer and enable Do Not Disturb before starting the walk.",
  },
  {
    id: "social-block",
    objectives: {
      socialMediaReduction: 1,
      focus: 0.8,
      stressRegulation: 0.5,
    },
    effects: {
      socialMediaReduction: 0.95,
      focus: 0.5,
      stressRegulation: 0.2,
      mood: 0.2,
    },
    baseFriction: 0.34,
    followUpMinutes: 30,
    action: ({ needs, tone }) => {
      const duration = needs.socialMediaReduction > 0.75 ? 45 : 30;
      return tone === "supportive"
        ? `Set a ${duration}-minute social media block now (Instagram/TikTok/X/Shorts), then do one small offline action.`
        : `Block social media for ${duration} minutes now. Immediately switch to one offline task for 10 minutes.`;
    },
    fallback: "If you cannot block apps, put the phone in another room for 15 minutes.",
    evidenceNote:
      "Reducing access to high-cue apps lowers compulsive checking and improves sustained attention in the next task window.",
    toolHint: "Start an app/site blocker profile for 30-45 minutes and launch one offline next action.",
  },
  {
    id: "focus-sprint",
    objectives: {
      focus: 1,
      socialMediaReduction: 0.4,
      mood: 0.2,
    },
    effects: {
      focus: 0.9,
      socialMediaReduction: 0.3,
      mood: 0.2,
      stressRegulation: 0.2,
    },
    baseFriction: 0.3,
    followUpMinutes: 35,
    action: ({ needs, tone }) => {
      const minutes = needs.energy > 0.8 ? 15 : 25;
      return tone === "supportive"
        ? `Run one ${minutes}-minute focus sprint on the smallest meaningful task. Start with a 90-second setup only.`
        : `Start one ${minutes}-minute deep-focus sprint now. Single task, notifications off, no social tabs.`;
    },
    fallback: "If focus is very low, do a 5-minute starter sprint and report what was completed.",
    evidenceNote:
      "Time-boxed single-task sprints reduce initiation friction and can decrease procrastination through clear stopping points.",
    toolHint:
      "Start a single-task timer (15-25 minutes), close social tabs, and keep only the current task visible.",
  },
  {
    id: "breathing",
    objectives: {
      stressRegulation: 1,
      mood: 0.4,
      focus: 0.3,
    },
    effects: {
      stressRegulation: 0.85,
      mood: 0.3,
      focus: 0.25,
      energy: 0.1,
    },
    baseFriction: 0.16,
    followUpMinutes: 15,
    action: ({ tone }) =>
      tone === "supportive"
        ? "Do 3 minutes of 4-6 breathing now (inhale 4s, exhale 6s), then drink water."
        : "Do 3 minutes of 4-6 breathing right now. Then send a one-line check-in.",
    fallback: "If breathing feels hard, do 90 seconds of slow exhales only.",
    evidenceNote:
      "Slow exhale breathing can reduce acute sympathetic arousal and improve short-term emotional regulation.",
    toolHint: "Use a breath timer/metronome for 3 minutes with 4-second inhale and 6-second exhale cadence.",
  },
  {
    id: "hydration",
    objectives: {
      energy: 1,
      mood: 0.35,
      focus: 0.3,
      movement: 0.25,
    },
    effects: {
      energy: 0.65,
      mood: 0.25,
      focus: 0.25,
      movement: 0.2,
      stressRegulation: 0.15,
    },
    baseFriction: 0.14,
    followUpMinutes: 20,
    action: ({ tone }) =>
      tone === "supportive"
        ? "Drink a full glass of water, stand up for 2 minutes, and open a window or get daylight."
        : "Hydrate now: one full glass of water, 2 minutes standing, then one concrete next task.",
    fallback: "If water is not available, do the 2-minute stand + daylight reset first.",
    evidenceNote:
      "Hydration plus a brief posture/light reset can improve perceived alertness and readiness for cognitive work.",
    toolHint: "Set a 2-minute stand timer, drink water, then write the next task in one sentence.",
  },
  {
    id: "sora-visualization",
    objectives: {
      mood: 0.9,
      focus: 0.5,
      socialMediaReduction: 0.5,
      stressRegulation: 0.35,
    },
    effects: {
      mood: 0.45,
      focus: 0.3,
      socialMediaReduction: 0.35,
      stressRegulation: 0.2,
    },
    baseFriction: 0.5,
    followUpMinutes: 40,
    action: ({ tone }) =>
      tone === "supportive"
        ? "Watch a short future-self visualization (or imagine it for 60 seconds), then take the first tiny action immediately."
        : "Use a 20-40s future-self visualization, then execute the first concrete action within 60 seconds.",
    fallback: "If video generation is unavailable, run a 60-second guided mental visualization instead.",
    evidenceNote:
      "Future-self visualization can increase motivation when paired with an immediate concrete follow-through step.",
    toolHint:
      "Generate a short desired-state video or run a 60-second mental scene, then trigger a 5-minute action timer.",
  },
];

const INTERVENTION_BY_ID: Record<LifeCoachInterventionId, InterventionSpec> = INTERVENTIONS.reduce(
  (acc, spec) => {
    acc[spec.id] = spec;
    return acc;
  },
  {} as Record<LifeCoachInterventionId, InterventionSpec>,
);

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

function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    if (
      content &&
      typeof content === "object" &&
      "text" in content &&
      typeof (content as { text?: unknown }).text === "string"
    ) {
      return (content as { text: string }).text;
    }
    return "";
  }
  const chunks: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const typed = item as { type?: unknown; text?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") {
      chunks.push(typed.text);
    }
  }
  return chunks.join("\n");
}

async function loadTranscriptMessages(sessionFile?: string): Promise<TranscriptMessage[]> {
  if (!sessionFile) {
    return [];
  }
  try {
    const raw = await fs.readFile(sessionFile, "utf-8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const messages: TranscriptMessage[] = [];
    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") {
        continue;
      }
      const entry = parsed as {
        type?: unknown;
        message?: { role?: unknown; content?: unknown; timestamp?: unknown };
        timestamp?: unknown;
      };
      if (entry.type !== "message" || !entry.message) {
        continue;
      }
      const roleRaw = entry.message.role;
      const role: TranscriptRole | null =
        roleRaw === "user" ? "user" : roleRaw === "assistant" ? "assistant" : null;
      if (!role) {
        continue;
      }
      const text = extractTextFromContent(entry.message.content).trim();
      if (!text) {
        continue;
      }
      const timestampRaw =
        typeof entry.message.timestamp === "number"
          ? entry.message.timestamp
          : typeof entry.timestamp === "number"
            ? entry.timestamp
            : undefined;
      messages.push({ role, text: text.toLowerCase(), timestamp: timestampRaw });
    }
    return messages;
  } catch {
    return [];
  }
}

function emptyStats(): LifeCoachStats {
  return {
    walk: { sent: 0, completed: 0, ignored: 0, rejected: 0 },
    "social-block": { sent: 0, completed: 0, ignored: 0, rejected: 0 },
    "focus-sprint": { sent: 0, completed: 0, ignored: 0, rejected: 0 },
    breathing: { sent: 0, completed: 0, ignored: 0, rejected: 0 },
    hydration: { sent: 0, completed: 0, ignored: 0, rejected: 0 },
    "sora-visualization": { sent: 0, completed: 0, ignored: 0, rejected: 0 },
  };
}

function emptyPreferenceModel(): LifeCoachPreferenceModel {
  return {
    objectiveBias: {
      mood: 0,
      energy: 0,
      focus: 0,
      movement: 0,
      socialMediaReduction: 0,
      stressRegulation: 0,
    },
    interventionAffinity: {
      walk: 0,
      "social-block": 0,
      "focus-sprint": 0,
      breathing: 0,
      hydration: 0,
      "sora-visualization": 0,
    },
    supportiveToneBias: 0,
    lastLearnedMessageTs: 0,
  };
}

function normalizeStateFile(raw: unknown, now: number): LifeCoachStateFile {
  const base: LifeCoachStateFile = {
    version: 2,
    updatedAt: now,
    history: [],
    stats: emptyStats(),
    preferences: emptyPreferenceModel(),
  };
  if (!raw || typeof raw !== "object") {
    return base;
  }
  const value = raw as Partial<LifeCoachStateFile>;
  const normalized: LifeCoachStateFile = {
    version: 2,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : now,
    history: Array.isArray(value.history)
      ? value.history.filter((entry): entry is LifeCoachHistoryEntry => {
          if (!entry || typeof entry !== "object") {
            return false;
          }
          const candidate = entry as Partial<LifeCoachHistoryEntry>;
          return (
            typeof candidate.id === "string" &&
            typeof candidate.sentAt === "number" &&
            typeof candidate.intervention === "string" &&
            (candidate.followUpSentAt === undefined || typeof candidate.followUpSentAt === "number") &&
            (candidate.tone === undefined || candidate.tone === "supportive" || candidate.tone === "direct") &&
            (candidate.status === "sent" ||
              candidate.status === "completed" ||
              candidate.status === "ignored" ||
              candidate.status === "rejected")
          );
        })
      : [],
    stats: emptyStats(),
    preferences: emptyPreferenceModel(),
  };
  const sourceStats = value.stats;
  if (sourceStats && typeof sourceStats === "object") {
    for (const spec of INTERVENTIONS) {
      const entry = (sourceStats as Record<string, unknown>)[spec.id];
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const typed = entry as Partial<LifeCoachStats[LifeCoachInterventionId]>;
      normalized.stats[spec.id] = {
        sent: Number.isFinite(typed.sent) ? Math.max(0, Math.floor(typed.sent as number)) : 0,
        completed: Number.isFinite(typed.completed)
          ? Math.max(0, Math.floor(typed.completed as number))
          : 0,
        ignored: Number.isFinite(typed.ignored)
          ? Math.max(0, Math.floor(typed.ignored as number))
          : 0,
        rejected: Number.isFinite(typed.rejected)
          ? Math.max(0, Math.floor(typed.rejected as number))
          : 0,
      };
    }
  }
  const sourcePreferences = (value as { preferences?: unknown }).preferences;
  if (sourcePreferences && typeof sourcePreferences === "object") {
    const typed = sourcePreferences as Partial<LifeCoachPreferenceModel>;
    const objectiveBias = typed.objectiveBias as Partial<Record<LifeCoachObjective, number>> | undefined;
    const interventionAffinity = typed.interventionAffinity as
      | Partial<Record<LifeCoachInterventionId, number>>
      | undefined;
    for (const objective of Object.keys(normalized.preferences.objectiveBias) as LifeCoachObjective[]) {
      const valueForObjective = objectiveBias?.[objective];
      if (typeof valueForObjective === "number") {
        normalized.preferences.objectiveBias[objective] = clampSigned(valueForObjective);
      }
    }
    for (const intervention of Object.keys(
      normalized.preferences.interventionAffinity,
    ) as LifeCoachInterventionId[]) {
      const valueForIntervention = interventionAffinity?.[intervention];
      if (typeof valueForIntervention === "number") {
        normalized.preferences.interventionAffinity[intervention] = clampSigned(valueForIntervention);
      }
    }
    if (typeof typed.supportiveToneBias === "number") {
      normalized.preferences.supportiveToneBias = clampSigned(typed.supportiveToneBias);
    }
    if (typeof typed.lastLearnedMessageTs === "number" && typed.lastLearnedMessageTs > 0) {
      normalized.preferences.lastLearnedMessageTs = typed.lastLearnedMessageTs;
    }
  }
  return normalized;
}

function resolveFollowUpAction(params: {
  intervention: LifeCoachInterventionId;
  tone: ResolvedTone;
  actionContract: {
    enabled: boolean;
    doneToken: string;
    helpToken: string;
  };
}): string {
  const directPrefix = "Follow-up check now:";
  const supportivePrefix = "Quick check-in:";
  const prefix = params.tone === "supportive" ? supportivePrefix : directPrefix;
  const doneToken = params.actionContract.enabled ? params.actionContract.doneToken : "done";
  const helpToken = params.actionContract.enabled ? params.actionContract.helpToken : "need help";
  switch (params.intervention) {
    case "walk":
      return `${prefix} did you complete the walk? If not, do a 7-minute version now and reply ${doneToken}.`;
    case "social-block":
      return `${prefix} are distracting social apps still blocked? If not, block for 20 minutes now and reply ${doneToken} or ${helpToken}.`;
    case "focus-sprint":
      return `${prefix} did the focus sprint happen? If not, run a 10-minute sprint now and send one line of progress.`;
    case "breathing":
      return `${prefix} take 2 minutes of slow breathing now and confirm when finished.`;
    case "hydration":
      return `${prefix} drink one full glass of water now and reply ${doneToken}.`;
    case "sora-visualization":
      return `${prefix} run the 60-second desired-state visualization and start one immediate action, then reply ${doneToken}.`;
    default:
      return `${prefix} complete the next tiny step now and reply ${doneToken}.`;
  }
}

function findDueFollowUp(
  state: LifeCoachStateFile,
  now: number,
): LifeCoachHistoryEntry | undefined {
  return [...state.history].toReversed().find((entry) => {
    if (entry.status !== "sent" || typeof entry.sentAt !== "number") {
      return false;
    }
    if (typeof entry.followUpSentAt === "number") {
      return false;
    }
    const followUpMs = Math.max(5, entry.followUpMinutes) * 60_000;
    return now - entry.sentAt >= followUpMs;
  });
}

function resolveStatePath(
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const stateDir = resolveStateDir(env, homedir);
  return path.join(stateDir, "agents", normalizeAgentId(agentId), "life-coach-state.json");
}

async function loadLifeCoachState(agentId: string, now: number): Promise<LifeCoachStateFile> {
  const statePath = resolveStatePath(agentId);
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    return normalizeStateFile(JSON.parse(raw) as unknown, now);
  } catch {
    return normalizeStateFile(undefined, now);
  }
}

async function saveLifeCoachState(agentId: string, state: LifeCoachStateFile): Promise<void> {
  const statePath = resolveStatePath(agentId);
  const dir = path.dirname(statePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function resolveObjectives(cfg?: HeartbeatLifeCoachConfig): Record<LifeCoachObjective, number> {
  const merged = {
    ...DEFAULT_OBJECTIVES,
    ...cfg?.objectives,
  };
  for (const key of Object.keys(merged) as LifeCoachObjective[]) {
    merged[key] = Math.max(0, Math.min(2, Number(merged[key] ?? DEFAULT_OBJECTIVES[key])));
  }
  return merged;
}

function applyObjectivePreferenceBias(params: {
  objectives: Record<LifeCoachObjective, number>;
  preferences: LifeCoachPreferenceModel;
}): Record<LifeCoachObjective, number> {
  const merged = { ...params.objectives };
  for (const objective of Object.keys(merged) as LifeCoachObjective[]) {
    const bias = params.preferences.objectiveBias[objective] ?? 0;
    merged[objective] = Math.max(0, Math.min(2, round2(merged[objective] * (1 + bias * 0.35))));
  }
  return merged;
}

function applyPreferenceDecay(state: LifeCoachStateFile, now: number): void {
  const elapsedMs = Math.max(0, now - state.updatedAt);
  if (elapsedMs <= 0) {
    return;
  }
  const elapsedDays = elapsedMs / (24 * 60 * 60_000);
  if (elapsedDays < 0.25) {
    return;
  }
  const retention = Math.pow(0.96, elapsedDays);
  for (const objective of Object.keys(state.preferences.objectiveBias) as LifeCoachObjective[]) {
    state.preferences.objectiveBias[objective] = round2(
      clampSigned(state.preferences.objectiveBias[objective] * retention),
    );
  }
  for (const intervention of Object.keys(
    state.preferences.interventionAffinity,
  ) as LifeCoachInterventionId[]) {
    state.preferences.interventionAffinity[intervention] = round2(
      clampSigned(state.preferences.interventionAffinity[intervention] * retention),
    );
  }
  state.preferences.supportiveToneBias = round2(
    clampSigned(state.preferences.supportiveToneBias * retention),
  );
}

function resolveActionContract(cfg?: HeartbeatLifeCoachConfig): {
  enabled: boolean;
  doneToken: string;
  helpToken: string;
} {
  const enabled = cfg?.actionContract?.enabled ?? true;
  const doneToken = cfg?.actionContract?.doneToken?.trim() || DEFAULT_DONE_TOKEN;
  const helpToken = cfg?.actionContract?.helpToken?.trim() || DEFAULT_HELP_TOKEN;
  return { enabled, doneToken, helpToken };
}

function resolveTone(params: {
  cfg: HeartbeatLifeCoachConfig | undefined;
  needs: LifeCoachNeedScores;
  affect: LifeCoachAffectScores;
  preferences: LifeCoachPreferenceModel;
}): ResolvedTone {
  const cfg = params.cfg;
  if (cfg?.tone === "supportive") {
    return "supportive";
  }
  if (cfg?.tone === "direct") {
    return "direct";
  }
  if (
    params.affect.distress >= 0.65 ||
    params.affect.frustration >= 0.6 ||
    params.preferences.supportiveToneBias >= 0.35
  ) {
    return "supportive";
  }
  if (params.preferences.supportiveToneBias <= -0.35 && params.affect.distress < 0.45) {
    return "direct";
  }
  const stressLoad = (params.needs.stressRegulation + params.needs.mood) / 2;
  return stressLoad >= 0.6 ? "supportive" : "direct";
}

function resolveActiveInterventions(cfg?: HeartbeatLifeCoachConfig): InterventionSpec[] {
  const allow = new Set(cfg?.interventions?.allow ?? []);
  const deny = new Set(cfg?.interventions?.deny ?? []);
  return INTERVENTIONS.filter((spec) => {
    if (spec.id === "sora-visualization" && cfg?.allowSoraVisualization === false) {
      return false;
    }
    if (allow.size > 0 && !allow.has(spec.id)) {
      return false;
    }
    if (deny.has(spec.id)) {
      return false;
    }
    return true;
  });
}

function estimateNeeds(messages: TranscriptMessage[]): LifeCoachNeedScores {
  const recentUsers = messages.filter((msg) => msg.role === "user").slice(-24);
  if (recentUsers.length === 0) {
    return {
      mood: 0.45,
      energy: 0.5,
      focus: 0.5,
      movement: 0.5,
      socialMediaReduction: 0.55,
      stressRegulation: 0.45,
    };
  }

  const positiveHits = countMentions(recentUsers, POSITIVE_HINTS);
  const stressHits = countMentions(recentUsers, STRESS_HINTS);
  const lowEnergyHits = countMentions(recentUsers, LOW_ENERGY_HINTS);
  const lowFocusHits = countMentions(recentUsers, LOW_FOCUS_HINTS);
  const lowMoodHits = countMentions(recentUsers, LOW_MOOD_HINTS);
  const socialHits = countMentions(recentUsers, SOCIAL_URGE_HINTS);
  const movementHits = countMentions(recentUsers, MOVEMENT_HINTS);
  const denom = Math.max(1, recentUsers.length * 2);

  const stress = clamp01(stressHits / denom + lowFocusHits / (denom * 2));
  const lowMood = clamp01(lowMoodHits / denom + stress / 3 - positiveHits / (denom * 2));
  const lowEnergy = clamp01(lowEnergyHits / denom + stress / 4 - positiveHits / (denom * 3));
  const lowFocus = clamp01(lowFocusHits / denom + socialHits / (denom * 1.5));
  const socialUrge = clamp01(socialHits / denom + lowFocus / 4);
  const movementNeed = clamp01(0.55 + socialUrge / 5 + lowEnergy / 5 - movementHits / denom);

  return {
    mood: round2(lowMood),
    energy: round2(lowEnergy),
    focus: round2(lowFocus),
    movement: round2(movementNeed),
    socialMediaReduction: round2(socialUrge),
    stressRegulation: round2(stress),
  };
}

function estimateAffect(
  messages: TranscriptMessage[],
  needs: LifeCoachNeedScores,
): LifeCoachAffectScores {
  const recentUsers = messages.filter((msg) => msg.role === "user").slice(-20);
  if (recentUsers.length === 0) {
    return {
      frustration: round2(clamp01((needs.focus + needs.stressRegulation) / 2.6)),
      distress: round2(clamp01((needs.stressRegulation + needs.mood) / 2)),
      momentum: round2(clamp01(0.35 - needs.focus * 0.2 + (1 - needs.energy) * 0.1)),
    };
  }
  const denom = Math.max(1, recentUsers.length * 2);
  const frustrationHits =
    countMentions(recentUsers, FRUSTRATION_HINTS) + countMentions(recentUsers, REJECTION_HINTS);
  const distressHits = countMentions(recentUsers, STRESS_HINTS) + countMentions(recentUsers, LOW_MOOD_HINTS);
  const positiveHits = countMentions(recentUsers, POSITIVE_HINTS) + countMentions(recentUsers, COMPLETION_HINTS);
  const frustration = clamp01(frustrationHits / denom + needs.focus / 4 + needs.stressRegulation / 4);
  const distress = clamp01(
    distressHits / denom + needs.stressRegulation * 0.4 + needs.mood * 0.3 - positiveHits / (denom * 2),
  );
  const momentum = clamp01(
    positiveHits / denom + (1 - needs.focus) * 0.3 + (1 - needs.energy) * 0.2 - frustration / 4,
  );
  return {
    frustration: round2(frustration),
    distress: round2(distress),
    momentum: round2(momentum),
  };
}

function countNudgesInWindow(state: LifeCoachStateFile, now: number, windowMs: number): number {
  return state.history.filter((entry) => now - entry.sentAt <= windowMs).length;
}

function completionProbability(
  stats: LifeCoachStats[LifeCoachInterventionId],
  tone: ResolvedTone,
): number {
  const total = stats.sent;
  if (total <= 0) {
    return tone === "supportive" ? 0.62 : 0.58;
  }
  const successRate = (stats.completed + 1) / (total + 2);
  const rejectRate = stats.rejected / Math.max(1, total);
  return clamp01(successRate * (tone === "supportive" ? 1.04 : 1) - rejectRate * 0.25);
}

function rejectionRisk(stats: LifeCoachStats[LifeCoachInterventionId]): number {
  if (stats.sent <= 0) {
    return 0.12;
  }
  return clamp01(stats.rejected / stats.sent);
}

function learnPreferencesFromMessages(params: {
  state: LifeCoachStateFile;
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

    for (const objective of Object.keys(OBJECTIVE_KEYWORDS) as LifeCoachObjective[]) {
      const mentions = countHintMatches(text, OBJECTIVE_KEYWORDS[objective]);
      if (mentions <= 0) {
        continue;
      }
      const upDelta = positiveCueHits > 0 ? 0.03 * mentions * positiveCueHits : 0;
      const downDelta = avoidCueHits > 0 ? 0.02 * mentions * avoidCueHits : 0;
      params.state.preferences.objectiveBias[objective] = round2(
        clampSigned(params.state.preferences.objectiveBias[objective] + upDelta - downDelta),
      );
    }
    for (const intervention of Object.keys(INTERVENTION_KEYWORDS) as LifeCoachInterventionId[]) {
      const mentions = countHintMatches(text, INTERVENTION_KEYWORDS[intervention]);
      if (mentions <= 0) {
        continue;
      }
      let delta = 0;
      if (positiveCueHits > 0) {
        delta += 0.03 * positiveCueHits;
      }
      if (avoidCueHits > 0) {
        delta -= 0.05 * avoidCueHits;
      }
      if (completionHits > 0) {
        delta += 0.04;
      }
      if (frustrationHits > 0) {
        delta -= 0.02 * frustrationHits;
      }
      params.state.preferences.interventionAffinity[intervention] = round2(
        clampSigned(params.state.preferences.interventionAffinity[intervention] + delta * mentions),
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

function learnPreferencesFromOutcome(params: {
  state: LifeCoachStateFile;
  intervention: LifeCoachInterventionId;
  status: LifeCoachHistoryEntry["status"];
  tone?: ResolvedTone;
}): void {
  if (params.status === "sent") {
    return;
  }
  const affinityDelta =
    params.status === "completed" ? 0.08 : params.status === "ignored" ? -0.04 : -0.1;
  params.state.preferences.interventionAffinity[params.intervention] = round2(
    clampSigned(params.state.preferences.interventionAffinity[params.intervention] + affinityDelta),
  );
  const spec = INTERVENTION_BY_ID[params.intervention];
  if (spec) {
    for (const objective of Object.keys(spec.effects) as LifeCoachObjective[]) {
      const effect = spec.effects[objective] ?? 0;
      const delta = params.status === "completed" ? effect * 0.03 : params.status === "rejected" ? -effect * 0.02 : 0;
      if (!delta) {
        continue;
      }
      params.state.preferences.objectiveBias[objective] = round2(
        clampSigned(params.state.preferences.objectiveBias[objective] + delta),
      );
    }
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

function computeInterventionFatigue(
  state: LifeCoachStateFile,
  intervention: LifeCoachInterventionId,
): number {
  const recent = state.history
    .filter((entry) => entry.intervention === intervention)
    .toReversed()
    .slice(0, 5);
  if (recent.length === 0) {
    return 0;
  }
  let penalty = 0;
  for (let i = 0; i < recent.length; i += 1) {
    const entry = recent[i];
    const weight = Math.max(0.2, 1 - i * 0.18);
    if (entry.status === "rejected") {
      penalty += 0.36 * weight;
    } else if (entry.status === "ignored") {
      penalty += 0.24 * weight;
    } else if (entry.status === "sent") {
      penalty += 0.1 * weight;
    } else if (entry.status === "completed") {
      penalty -= 0.18 * weight;
    }
  }
  return clamp01(penalty);
}

function adjustFollowUpMinutes(baseFollowUpMinutes: number, affect: LifeCoachAffectScores): number {
  let followUp = baseFollowUpMinutes;
  if (affect.frustration > 0.65) {
    followUp += 10;
  }
  if (affect.distress > 0.7) {
    followUp += 5;
  }
  if (affect.momentum > 0.7) {
    followUp -= 5;
  }
  return Math.max(10, Math.min(120, followUp));
}

function resolveSoraPrompt(decision: {
  intervention: LifeCoachInterventionId;
  needs: LifeCoachNeedScores;
  affect: LifeCoachAffectScores;
}): string | undefined {
  if (decision.intervention !== "sora-visualization") {
    return undefined;
  }
  const topNeed = (Object.entries(decision.needs) as Array<[LifeCoachObjective, number]>).toSorted(
    (a, b) => b[1] - a[1],
  )[0]?.[0];
  const openingBeat =
    topNeed === "socialMediaReduction"
      ? "phone is placed face down in another room"
      : topNeed === "focus"
        ? "single task is opened with notifications off"
        : topNeed === "stressRegulation"
          ? "breath slows and shoulders relax"
          : topNeed === "movement"
            ? "user steps outside and begins walking"
            : "user starts one clear, immediate action";
  const emotionalTone =
    decision.affect.distress > 0.65
      ? "gentle, grounded, emotionally safe"
      : decision.affect.momentum > 0.65
        ? "energizing, forward-moving, practical"
        : "calm, confident, non-preachy";
  return (
    "Create a 20-30 second grounded first-person scene where the user shifts from friction to action: " +
    `${openingBeat}, followed by one visible next step that starts within 60 seconds. ` +
    `Tone: ${emotionalTone}, realistic pacing, no flashy effects, emphasize immediate execution.`
  );
}

function updatePendingOutcomes(params: {
  state: LifeCoachStateFile;
  messages: TranscriptMessage[];
  now: number;
  actionContract: {
    enabled: boolean;
    doneToken: string;
    helpToken: string;
  };
}): void {
  const pending = [...params.state.history]
    .toReversed()
    .find((entry) => entry.status === "sent" && typeof entry.sentAt === "number");
  if (!pending) {
    return;
  }

  const relevantMessages = params.messages.filter((msg) => {
    if (msg.role !== "user") {
      return false;
    }
    if (typeof msg.timestamp !== "number") {
      return true;
    }
    return msg.timestamp >= pending.sentAt;
  });

  let nextStatus: LifeCoachHistoryEntry["status"] | null = null;
  const doneToken = params.actionContract.doneToken.trim().toLowerCase();
  const helpToken = params.actionContract.helpToken.trim().toLowerCase();
  for (const message of relevantMessages) {
    const text = message.text;
    if (doneToken && text.includes(doneToken)) {
      nextStatus = "completed";
      break;
    }
    if (helpToken && text.includes(helpToken)) {
      nextStatus = "rejected";
      break;
    }
    if (countHintMatches(text, COMPLETION_HINTS) > 0) {
      nextStatus = "completed";
      break;
    }
    if (countHintMatches(text, REJECTION_HINTS) > 0) {
      nextStatus = "rejected";
      break;
    }
  }

  if (!nextStatus) {
    const followUpMs = Math.max(5, pending.followUpMinutes) * 60_000;
    const ignoreAfterMs =
      typeof pending.followUpSentAt === "number"
        ? pending.followUpSentAt + followUpMs
        : pending.sentAt + followUpMs * 2;
    if (params.now > ignoreAfterMs) {
      nextStatus = "ignored";
    }
  }
  if (!nextStatus) {
    return;
  }

  pending.status = nextStatus;
  const stat = params.state.stats[pending.intervention];
  if (nextStatus === "completed") {
    stat.completed += 1;
  } else if (nextStatus === "ignored") {
    stat.ignored += 1;
  } else if (nextStatus === "rejected") {
    stat.rejected += 1;
  }
  learnPreferencesFromOutcome({
    state: params.state,
    intervention: pending.intervention,
    status: nextStatus,
    tone: pending.tone,
  });
}

function selectIntervention(params: {
  activeInterventions: InterventionSpec[];
  needs: LifeCoachNeedScores;
  affect: LifeCoachAffectScores;
  objectives: Record<LifeCoachObjective, number>;
  state: LifeCoachStateFile;
  preferences: LifeCoachPreferenceModel;
  tone: ResolvedTone;
  relapsePressure: number;
  now: number;
}): LifeCoachDecision | undefined {
  let best:
    | {
        spec: InterventionSpec;
        score: number;
        rationale: string;
      }
    | undefined;

  for (const spec of params.activeInterventions) {
    const stats = params.state.stats[spec.id];
    const completionProb = completionProbability(stats, params.tone);
    const reactance = rejectionRisk(stats);
    const preferenceAffinity = params.preferences.interventionAffinity[spec.id] ?? 0;
    const fatigue = computeInterventionFatigue(params.state, spec.id);

    let expectedGain = 0;
    for (const objective of Object.keys(params.objectives) as LifeCoachObjective[]) {
      const need = params.needs[objective] ?? 0;
      const objectiveWeight = params.objectives[objective] ?? 1;
      const effect = spec.effects[objective] ?? 0;
      const alignment = spec.objectives[objective] ?? 0.2;
      expectedGain += need * objectiveWeight * effect * alignment;
    }

    const friction =
      spec.baseFriction +
      (params.needs.energy > 0.75 ? 0.08 : 0) +
      (params.affect.frustration > 0.55 && spec.baseFriction > 0.28 ? 0.1 : 0);
    const relapseBoost =
      params.relapsePressure > 0.45 && params.needs.socialMediaReduction > 0.6
        ? spec.id === "walk" || spec.id === "breathing"
          ? 0.12
          : spec.id === "social-block"
            ? 0.05
            : 0
        : 0;
    const distressBoost =
      params.affect.distress > 0.55 &&
      (spec.id === "breathing" || spec.id === "walk" || spec.id === "hydration")
        ? 0.1
        : 0;
    const momentumBoost =
      params.affect.momentum > 0.6 && (spec.id === "focus-sprint" || spec.id === "social-block")
        ? 0.08
        : 0;
    const score =
      expectedGain * (0.6 + completionProb) -
      friction -
      reactance * 0.35 -
      fatigue * 0.24 +
      relapseBoost +
      distressBoost +
      momentumBoost +
      preferenceAffinity * 0.18;
    const rationale =
      `expectedGain=${round2(expectedGain)}, completion=${round2(completionProb)}, ` +
      `friction=${round2(friction)}, reactance=${round2(reactance)}, fatigue=${round2(fatigue)}, ` +
      `affinity=${round2(preferenceAffinity)}, relapse=${round2(params.relapsePressure)}, ` +
      `frustration=${round2(params.affect.frustration)}, distress=${round2(params.affect.distress)}`;

    if (!best || score > best.score) {
      best = { spec, score, rationale };
    }
  }

  if (!best || best.score < 0.02) {
    return undefined;
  }

  const action = best.spec.action({ needs: params.needs, tone: params.tone });
  const followUpMinutes = adjustFollowUpMinutes(best.spec.followUpMinutes, params.affect);
  return {
    phase: "initial",
    intervention: best.spec.id,
    score: round2(best.score),
    rationale: best.rationale,
    action,
    fallback: best.spec.fallback,
    followUpMinutes,
    tone: params.tone,
    soraPrompt: resolveSoraPrompt({
      intervention: best.spec.id,
      needs: params.needs,
      affect: params.affect,
    }),
    needs: params.needs,
    affect: params.affect,
    evidenceNote: best.spec.evidenceNote,
    toolHint: best.spec.toolHint,
  };
}

function createFollowUpDecision(params: {
  pending: LifeCoachHistoryEntry;
  needs: LifeCoachNeedScores;
  affect: LifeCoachAffectScores;
  tone: ResolvedTone;
  actionContract: {
    enabled: boolean;
    doneToken: string;
    helpToken: string;
  };
}): LifeCoachDecision {
  const spec = INTERVENTION_BY_ID[params.pending.intervention];
  return {
    phase: "follow-up",
    intervention: params.pending.intervention,
    score: 1,
    rationale: "due follow-up for pending intervention",
    action: resolveFollowUpAction({
      intervention: params.pending.intervention,
      tone: params.tone,
      actionContract: params.actionContract,
    }),
    fallback: "If completion is blocked, ask for a smaller 5-minute fallback and keep the tone supportive.",
    followUpMinutes: Math.max(5, params.pending.followUpMinutes),
    tone: params.tone,
    needs: params.needs,
    affect: params.affect,
    evidenceNote: spec?.evidenceNote ?? "Keep the follow-up action simple, specific, and low-friction.",
    toolHint: spec?.toolHint ?? "Offer a timer-based 5-minute fallback if the user is blocked.",
  };
}

function formatPreferenceSnapshot(preferences: LifeCoachPreferenceModel): string {
  const entries = Object.entries(preferences.interventionAffinity)
    .map(([key, value]) => [key, round2(value)] as const)
    .toSorted((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 3)
    .map(([key, value]) => `${key}=${value}`);
  if (!entries.length) {
    return "no learned preferences yet";
  }
  return `${entries.join(", ")}; toneBias=${round2(preferences.supportiveToneBias)}`;
}

function buildPrompt(params: {
  basePrompt: string;
  decision?: LifeCoachDecision;
  needs: LifeCoachNeedScores;
  affect: LifeCoachAffectScores;
  preferences: LifeCoachPreferenceModel;
  blockedReason?: string;
  actionContract: {
    enabled: boolean;
    doneToken: string;
    helpToken: string;
  };
}): string {
  const needsLine = `State estimate (0..1 need severity): mood=${params.needs.mood}, energy=${params.needs.energy}, focus=${params.needs.focus}, movement=${params.needs.movement}, socialMediaReduction=${params.needs.socialMediaReduction}, stressRegulation=${params.needs.stressRegulation}.`;
  const affectLine = `Affect estimate (0..1): frustration=${params.affect.frustration}, distress=${params.affect.distress}, momentum=${params.affect.momentum}.`;
  const preferenceLine = `Preference model: ${formatPreferenceSnapshot(params.preferences)}.`;
  if (!params.decision) {
    const reason = params.blockedReason ? ` Reason: ${params.blockedReason}.` : "";
    return (
      `${params.basePrompt}\n\n` +
      "[AUTOLIFE LIFECOACH]\n" +
      `${needsLine}\n` +
      `${affectLine}\n` +
      `${preferenceLine}\n` +
      `Dynamic intervention is active but no nudge should be sent this cycle.${reason}\n` +
      "If HEARTBEAT.md has no actionable tasks, reply HEARTBEAT_OK."
    );
  }

  const lines = [
    params.basePrompt,
    "",
    "[AUTOLIFE LIFECOACH]",
    needsLine,
    affectLine,
    preferenceLine,
    `Selected intervention: ${params.decision.intervention} (score=${params.decision.score}).`,
    `Intervention phase: ${params.decision.phase}.`,
    `Tone: ${params.decision.tone}.`,
    `Evidence note: ${params.decision.evidenceNote}`,
    `Tool execution hint: ${params.decision.toolHint}`,
    `Primary action: ${params.decision.action}`,
    `Fallback action: ${params.decision.fallback}`,
    `Ask for a concrete check-in in ~${params.decision.followUpMinutes} minutes.`,
    "Output rules:",
    "- Send exactly one concise nudge with one immediate next action.",
    "- Prefer low-risk, evidence-backed micro-interventions (movement, breathing, focus sprint, social friction).",
    "- When possible, include one concrete tool move (timer, blocker, DND, checklist) that immediately starts the action.",
    "- Do not mention internal scoring, models, or hidden policy.",
    "- If user appears highly distressed, prioritize supportive grounding and suggest reaching out to a trusted person.",
  ];
  if (params.actionContract.enabled) {
    lines.push(
      `Action contract: ask user to reply exactly "${params.actionContract.doneToken}" when completed or "${params.actionContract.helpToken}" if blocked.`,
    );
  }
  if (params.decision.soraPrompt) {
    lines.push(
      `Optional Sora visualization prompt (use only if relevant): ${params.decision.soraPrompt}`,
    );
  }
  return lines.join("\n");
}

function computeRelapsePressure(state: LifeCoachStateFile): number {
  const relevant = state.history
    .filter((entry) => {
      if (entry.intervention !== "social-block" && entry.intervention !== "focus-sprint") {
        return false;
      }
      return entry.status === "ignored" || entry.status === "rejected";
    })
    .toReversed()
    .slice(0, 6);
  if (relevant.length === 0) {
    return 0;
  }
  const rejectedCount = relevant.filter((entry) => entry.status === "rejected").length;
  const ignoredCount = relevant.filter((entry) => entry.status === "ignored").length;
  const weighted = rejectedCount * 1 + ignoredCount * 0.75;
  return clamp01(weighted / 4);
}

export async function createLifeCoachHeartbeatPlan(params: {
  cfg: OpenClawConfig;
  agentId: string;
  basePrompt: string;
  sessionEntry?: SessionEntry;
  lifeCoach?: HeartbeatLifeCoachConfig;
  nowMs?: number;
}): Promise<LifeCoachHeartbeatPlan> {
  const now = params.nowMs ?? Date.now();
  const lifeCoach = params.lifeCoach;
  if (!lifeCoach?.enabled) {
    return { prompt: params.basePrompt };
  }
  const actionContract = resolveActionContract(lifeCoach);

  const state = await loadLifeCoachState(params.agentId, now);
  applyPreferenceDecay(state, now);
  const messages = await loadTranscriptMessages(params.sessionEntry?.sessionFile);
  updatePendingOutcomes({
    state,
    messages,
    now,
    actionContract,
  });
  learnPreferencesFromMessages({
    state,
    messages,
  });

  const needs = estimateNeeds(messages);
  const affect = estimateAffect(messages, needs);
  const objectives = applyObjectivePreferenceBias({
    objectives: resolveObjectives(lifeCoach),
    preferences: state.preferences,
  });
  const tone = resolveTone({
    cfg: lifeCoach,
    needs,
    affect,
    preferences: state.preferences,
  });
  const relapsePressure = computeRelapsePressure(state);

  const dueFollowUp = findDueFollowUp(state, now);
  if (dueFollowUp) {
    const followUpDecision = createFollowUpDecision({
      pending: dueFollowUp,
      needs,
      affect,
      tone,
      actionContract,
    });
    state.updatedAt = now;
    await saveLifeCoachState(params.agentId, state);
    return {
      prompt: buildPrompt({
        basePrompt: params.basePrompt,
        decision: followUpDecision,
        needs,
        affect,
        preferences: state.preferences,
        actionContract,
      }),
      decision: followUpDecision,
    };
  }

  const cooldownMinutes = Math.max(1, lifeCoach.cooldownMinutes ?? DEFAULT_COOLDOWN_MINUTES);
  const maxNudgesPerDay = Math.max(1, lifeCoach.maxNudgesPerDay ?? DEFAULT_MAX_NUDGES_PER_DAY);

  const mostRecentSent = [...state.history]
    .toReversed()
    .find((entry) => typeof entry.sentAt === "number");
  if (mostRecentSent && now - mostRecentSent.sentAt < cooldownMinutes * 60_000) {
    state.updatedAt = now;
    await saveLifeCoachState(params.agentId, state);
    return {
      prompt: buildPrompt({
        basePrompt: params.basePrompt,
        needs,
        affect,
        preferences: state.preferences,
        blockedReason: `cooldown active for ${cooldownMinutes}m`,
        actionContract,
      }),
    };
  }

  if (countNudgesInWindow(state, now, 24 * 60 * 60_000) >= maxNudgesPerDay) {
    state.updatedAt = now;
    await saveLifeCoachState(params.agentId, state);
    return {
      prompt: buildPrompt({
        basePrompt: params.basePrompt,
        needs,
        affect,
        preferences: state.preferences,
        blockedReason: `daily nudge cap reached (${maxNudgesPerDay})`,
        actionContract,
      }),
    };
  }

  const activeInterventions = resolveActiveInterventions({
    ...lifeCoach,
    allowSoraVisualization: lifeCoach.allowSoraVisualization ?? DEFAULT_ALLOW_SORA,
  });
  const decision = selectIntervention({
    activeInterventions,
    needs,
    affect,
    objectives,
    state,
    preferences: state.preferences,
    tone,
    relapsePressure,
    now,
  });

  state.updatedAt = now;
  await saveLifeCoachState(params.agentId, state);
  return {
    prompt: buildPrompt({
      basePrompt: params.basePrompt,
      decision,
      needs,
      affect,
      preferences: state.preferences,
      blockedReason: decision ? undefined : "no intervention cleared score threshold",
      actionContract,
    }),
    decision,
  };
}

export async function recordLifeCoachDispatch(params: {
  agentId: string;
  decision?: LifeCoachDecision;
  nowMs?: number;
}): Promise<void> {
  if (!params.decision) {
    return;
  }
  const now = params.nowMs ?? Date.now();
  const state = await loadLifeCoachState(params.agentId, now);
  if (params.decision.phase === "follow-up") {
    const pending = [...state.history].toReversed().find(
      (entry) =>
        entry.status === "sent" &&
        !entry.followUpSentAt &&
        entry.intervention === params.decision?.intervention,
    );
    if (pending) {
      pending.followUpSentAt = now;
    }
    state.updatedAt = now;
    await saveLifeCoachState(params.agentId, state);
    return;
  }
  const stat = state.stats[params.decision.intervention];
  stat.sent += 1;
  state.history.push({
    id: `${params.decision.intervention}-${now}-${Math.round(Math.random() * 1e6)}`,
    intervention: params.decision.intervention,
    sentAt: now,
    status: "sent",
    followUpMinutes: params.decision.followUpMinutes,
    tone: params.decision.tone,
    note: params.decision.action,
  });
  state.history = state.history.slice(-200);
  state.updatedAt = now;
  await saveLifeCoachState(params.agentId, state);
}

export const __lifeCoachTestUtils = {
  estimateNeeds,
  estimateAffect,
  resolveObjectives,
  applyObjectivePreferenceBias,
  resolveActiveInterventions,
  selectIntervention,
  normalizeStateFile,
  computeRelapsePressure,
};
