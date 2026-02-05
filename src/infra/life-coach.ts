import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type LifeCoachObjective = string;

export type LifeCoachInterventionId = string;

export type HeartbeatLifeCoachConfig = {
  enabled?: boolean;
  objectives?: Partial<Record<LifeCoachObjective, number>>;
  interventions?: {
    allow?: LifeCoachInterventionId[];
    deny?: LifeCoachInterventionId[];
  };
  cooldownMinutes?: number;
  maxNudgesPerDay?: number;
  tone?: "adaptive" | "supportive" | "direct";
  allowSoraVisualization?: boolean;
  actionContract?: {
    enabled?: boolean;
    doneToken?: string;
    helpToken?: string;
  };
  science?: {
    enabled?: boolean;
    mode?: "dynamic" | "catalog" | "hybrid";
    catalogFile?: string;
    minConfidence?: number;
    maxPapers?: number;
    fetchTimeoutMs?: number;
    cacheHours?: number;
  };
};

type AgentConfigEntry = {
  id?: string;
  default?: boolean;
  workspace?: string;
};

export type LifeCoachConfig = {
  agents?: {
    defaults?: {
      workspace?: string;
    };
    list?: AgentConfigEntry[];
  };
};

export type SessionEntry = {
  sessionId?: string;
  updatedAt?: number;
  sessionFile?: string;
};

type TranscriptRole = "user" | "assistant";

type TranscriptMessage = {
  role: TranscriptRole;
  text: string;
  timestamp?: number;
};

type LifeCoachNeedScores = Record<string, number>;

type LifeCoachAffectScores = {
  frustration: number;
  distress: number;
  momentum: number;
};

const DEFAULT_AGENT_ID = "main";
const STATE_DIR_NAME = ".autlife";
const DEFAULT_WORKSPACE_DIR = path.join(os.homedir(), STATE_DIR_NAME, "workspace");
const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_DASH_RE = /^-+/;
const TRAILING_DASH_RE = /-+$/;

function resolveUserPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, os.homedir());
    return path.resolve(expanded);
  }
  return path.resolve(trimmed);
}

function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const override = env.AUTLIFE_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override);
  }
  return path.join(homedir(), STATE_DIR_NAME);
}

function normalizeAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return DEFAULT_AGENT_ID;
  }
  if (VALID_ID_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return (
    trimmed
      .toLowerCase()
      .replace(INVALID_CHARS_RE, "-")
      .replace(LEADING_DASH_RE, "")
      .replace(TRAILING_DASH_RE, "")
      .slice(0, 64) || DEFAULT_AGENT_ID
  );
}

function resolveDefaultAgentId(cfg: LifeCoachConfig): string {
  const agents = Array.isArray(cfg.agents?.list)
    ? cfg.agents.list.filter((entry): entry is AgentConfigEntry => Boolean(entry && typeof entry === "object"))
    : [];
  if (agents.length === 0) {
    return DEFAULT_AGENT_ID;
  }
  const defaults = agents.filter((entry) => entry.default === true);
  const selected = defaults[0] ?? agents[0];
  return normalizeAgentId(selected?.id);
}

function resolveAgentWorkspaceDir(cfg: LifeCoachConfig, agentId: string): string {
  const id = normalizeAgentId(agentId);
  const agents = Array.isArray(cfg.agents?.list)
    ? cfg.agents.list.filter((entry): entry is AgentConfigEntry => Boolean(entry && typeof entry === "object"))
    : [];
  const configuredAgentWorkspace = agents
    .find((entry) => normalizeAgentId(entry.id) === id)
    ?.workspace?.trim();
  if (configuredAgentWorkspace) {
    return resolveUserPath(configuredAgentWorkspace);
  }

  const defaultAgentId = resolveDefaultAgentId(cfg);
  if (id === defaultAgentId) {
    const fallbackWorkspace = cfg.agents?.defaults?.workspace?.trim();
    if (fallbackWorkspace) {
      return resolveUserPath(fallbackWorkspace);
    }
    return DEFAULT_WORKSPACE_DIR;
  }
  return path.join(os.homedir(), STATE_DIR_NAME, `workspace-${id}`);
}

type ScienceReference = {
  title: string;
  url: string;
};

type ScienceTopicSpec = {
  id: string;
  keywords: string[];
  objectiveWeights?: Record<string, number>;
  affectWeights?: Partial<Record<keyof LifeCoachAffectScores, number>>;
  confidenceBias?: number;
  minConfidence?: number;
  recommendedIntervention: LifeCoachInterventionId;
  trajectoryForecast: string;
  improvementForecast: string;
  recommendedAction: string;
  references?: ScienceReference[];
  forceInterventionAtConfidence?: number;
};

type ScienceInsight = {
  riskId: string;
  confidence: number;
  trajectoryForecast: string;
  improvementForecast: string;
  recommendedAction: string;
  recommendedIntervention: LifeCoachInterventionId;
  references: ScienceReference[];
  forceIntervention: boolean;
};

type ScienceMode = "dynamic" | "catalog" | "hybrid";

type LifeCoachInterventionStat = {
  sent: number;
  completed: number;
  ignored: number;
  rejected: number;
};

type LifeCoachStats = Record<string, LifeCoachInterventionStat>;

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
  objectiveBias: Record<string, number>;
  interventionAffinity: Record<string, number>;
  supportiveToneBias: number;
  lastLearnedMessageTs: number;
};

type InterventionStrategy = string;

type LifeCoachStateFile = {
  version: 2;
  updatedAt: number;
  history: LifeCoachHistoryEntry[];
  stats: LifeCoachStats;
  preferences: LifeCoachPreferenceModel;
};

type InterventionSpec = {
  id: LifeCoachInterventionId;
  primaryObjective: string;
  strategy: InterventionStrategy;
  objectives: Record<string, number>;
  effects: Record<string, number>;
  baseFriction: number;
  followUpMinutes: number;
  action: (params: { needs: LifeCoachNeedScores; tone: ResolvedTone }) => string;
  fallback: string;
  evidenceNote: string;
  toolHint: string;
  supportsSora: boolean;
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
  scienceInsight?: ScienceInsight;
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
const DEFAULT_SCIENCE_MIN_CONFIDENCE = 0.35;
const DEFAULT_SCIENCE_MODE: ScienceMode = "dynamic";
const DEFAULT_SCIENCE_MAX_PAPERS = 3;
const DEFAULT_SCIENCE_FETCH_TIMEOUT_MS = 3_500;
const DEFAULT_SCIENCE_CACHE_HOURS = 12;
const DEFAULT_OBJECTIVE_WEIGHT = 1;
const DEFAULT_GENERIC_OBJECTIVE = "general";

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

const SCIENCE_REFERENCE_CACHE = new Map<
  string,
  {
    expiresAt: number;
    references: ScienceReference[];
  }
>();

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

function normalizeAxisId(value: string): string {
  const compact = value
    .trim()
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return compact || DEFAULT_GENERIC_OBJECTIVE;
}

function humanizeAxisId(value: string): string {
  return normalizeAxisId(value).replaceAll("-", " ");
}

function extractMeaningfulTokensFromText(text: string): string[] {
  const tokens = text.match(/[a-z][a-z0-9'-]{2,}/g) ?? [];
  return tokens
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3 && !SCIENCE_STOPWORDS.has(token));
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

function containsAny(text: string, hints: string[]): boolean {
  return hints.some((hint) => text.includes(hint));
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

function normalizeKeywords(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const keywords = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(keywords)];
}

function normalizeScienceReferences(value: unknown): ScienceReference[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is { title?: unknown; url?: unknown } => Boolean(entry && typeof entry === "object"))
    .map((entry) => {
      const title = typeof entry.title === "string" ? entry.title.trim() : "";
      const url = typeof entry.url === "string" ? entry.url.trim() : "";
      return { title, url };
    })
    .filter((entry) => entry.title.length > 0 && entry.url.length > 0);
}

function normalizeLifeCoachObjectiveWeights(
  value: unknown,
): Record<string, number> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const normalized: Record<string, number> = {};
  for (const [objective, candidate] of Object.entries(raw)) {
    if (typeof candidate !== "number") {
      continue;
    }
    normalized[normalizeAxisId(objective)] = clamp01(candidate);
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

function normalizeAffectWeights(
  value: unknown,
): Partial<Record<keyof LifeCoachAffectScores, number>> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const keys: Array<keyof LifeCoachAffectScores> = ["frustration", "distress", "momentum"];
  const normalized: Partial<Record<keyof LifeCoachAffectScores, number>> = {};
  for (const key of keys) {
    const candidate = raw[key];
    if (typeof candidate !== "number") {
      continue;
    }
    normalized[key] = clamp01(candidate);
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

function isInterventionId(value: string): value is LifeCoachInterventionId {
  return value.trim().length > 0;
}

function normalizeScienceTopic(
  raw: unknown,
  defaultMinConfidence: number,
): ScienceTopicSpec | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const typed = raw as Record<string, unknown>;
  const id = typeof typed.id === "string" ? typed.id.trim().toLowerCase() : "";
  const recommendedInterventionRaw =
    typeof typed.recommendedIntervention === "string"
      ? typed.recommendedIntervention.trim()
      : "";
  const trajectoryForecast =
    typeof typed.trajectoryForecast === "string" ? typed.trajectoryForecast.trim() : "";
  const improvementForecast =
    typeof typed.improvementForecast === "string" ? typed.improvementForecast.trim() : "";
  const recommendedAction =
    typeof typed.recommendedAction === "string" ? typed.recommendedAction.trim() : "";
  const keywords = normalizeKeywords(typed.keywords);
  if (
    !id ||
    !recommendedInterventionRaw ||
    !isInterventionId(recommendedInterventionRaw) ||
    !trajectoryForecast ||
    !improvementForecast ||
    !recommendedAction ||
    keywords.length === 0
  ) {
    return undefined;
  }
  const confidenceBias = typeof typed.confidenceBias === "number" ? typed.confidenceBias : undefined;
  const minConfidence =
    typeof typed.minConfidence === "number"
      ? clamp01(typed.minConfidence)
      : clamp01(defaultMinConfidence);
  const forceInterventionAtConfidence =
    typeof typed.forceInterventionAtConfidence === "number"
      ? clamp01(typed.forceInterventionAtConfidence)
      : undefined;
  return {
    id,
    keywords,
    objectiveWeights: normalizeLifeCoachObjectiveWeights(typed.objectiveWeights),
    affectWeights: normalizeAffectWeights(typed.affectWeights),
    confidenceBias: typeof confidenceBias === "number" ? confidenceBias : undefined,
    minConfidence,
    recommendedIntervention: recommendedInterventionRaw,
    trajectoryForecast,
    improvementForecast,
    recommendedAction,
    references: normalizeScienceReferences(typed.references),
    forceInterventionAtConfidence,
  };
}

function normalizeScienceTopics(raw: unknown, defaultMinConfidence: number): ScienceTopicSpec[] {
  const entries = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { topics?: unknown }).topics)
      ? ((raw as { topics: unknown[] }).topics ?? [])
      : [];
  const normalized: ScienceTopicSpec[] = [];
  for (const entry of entries) {
    const topic = normalizeScienceTopic(entry, defaultMinConfidence);
    if (topic) {
      normalized.push(topic);
    }
  }
  return normalized;
}

function mergeScienceTopics(base: ScienceTopicSpec[], override: ScienceTopicSpec[]): ScienceTopicSpec[] {
  const merged = new Map<string, ScienceTopicSpec>();
  for (const topic of base) {
    merged.set(topic.id, topic);
  }
  for (const topic of override) {
    merged.set(topic.id, topic);
  }
  return [...merged.values()];
}

function resolveScienceMode(lifeCoach?: HeartbeatLifeCoachConfig): ScienceMode {
  const mode = lifeCoach?.science?.mode;
  if (mode === "catalog" || mode === "hybrid" || mode === "dynamic") {
    return mode;
  }
  return DEFAULT_SCIENCE_MODE;
}

function resolveScienceRuntime(lifeCoach?: HeartbeatLifeCoachConfig): {
  minConfidence: number;
  maxPapers: number;
  fetchTimeoutMs: number;
  cacheMs: number;
} {
  const science = lifeCoach?.science;
  const maxPapersRaw = science?.maxPapers;
  const fetchTimeoutRaw = science?.fetchTimeoutMs;
  const cacheHoursRaw = science?.cacheHours;
  const maxPapers =
    typeof maxPapersRaw === "number"
      ? Math.max(1, Math.min(10, Math.floor(maxPapersRaw)))
      : DEFAULT_SCIENCE_MAX_PAPERS;
  const fetchTimeoutMs =
    typeof fetchTimeoutRaw === "number"
      ? Math.max(500, Math.min(60_000, Math.floor(fetchTimeoutRaw)))
      : DEFAULT_SCIENCE_FETCH_TIMEOUT_MS;
  const cacheHours =
    typeof cacheHoursRaw === "number" ? Math.max(0.1, Math.min(24 * 30, cacheHoursRaw)) : DEFAULT_SCIENCE_CACHE_HOURS;
  return {
    minConfidence: clamp01(science?.minConfidence ?? DEFAULT_SCIENCE_MIN_CONFIDENCE),
    maxPapers,
    fetchTimeoutMs,
    cacheMs: cacheHours * 60 * 60_000,
  };
}

async function loadScienceTopics(params: {
  cfg: LifeCoachConfig;
  agentId: string;
  lifeCoach?: HeartbeatLifeCoachConfig;
}): Promise<ScienceTopicSpec[]> {
  const scienceCfg = params.lifeCoach?.science;
  if (scienceCfg?.enabled !== true) {
    return [];
  }
  const scienceMode = resolveScienceMode(params.lifeCoach);
  if (scienceMode === "dynamic") {
    return [];
  }
  const defaultMinConfidence = clamp01(scienceCfg?.minConfidence ?? DEFAULT_SCIENCE_MIN_CONFIDENCE);
  let topics: ScienceTopicSpec[] = [];

  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const configuredPath = scienceCfg?.catalogFile?.trim();
  const catalogCandidates = configuredPath
    ? [path.isAbsolute(configuredPath) ? configuredPath : path.join(workspaceDir, configuredPath)]
    : [
        path.join(workspaceDir, "SCIENCE_TOPICS.json"),
        path.join(workspaceDir, ".autolife", "science-topics.json"),
      ];
  for (const catalogPath of catalogCandidates) {
    try {
      const raw = await fs.readFile(catalogPath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      const customTopics = normalizeScienceTopics(parsed, defaultMinConfidence);
      if (customTopics.length > 0) {
        topics = mergeScienceTopics(topics, customTopics);
      }
      if (configuredPath) {
        break;
      }
    } catch {
      continue;
    }
  }
  return topics;
}

function extractScienceTokens(messages: TranscriptMessage[]): string[] {
  const text = messages
    .filter((msg) => msg.role === "user")
    .slice(-24)
    .map((msg) => msg.text)
    .join(" ");
  const tokens = text.match(/[a-z][a-z0-9'-]{2,}/g) ?? [];
  return tokens
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3 && !SCIENCE_STOPWORDS.has(token));
}

function summarizeRiskLabel(tokens: string[]): string {
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([token]) => token);
  if (!top.length) {
    return "behavior-pattern";
  }
  return top.join("-");
}

function buildDynamicInterventionId(params: {
  primaryObjective: string;
  strategy: InterventionStrategy;
}): LifeCoachInterventionId {
  return `dyn:${normalizeAxisId(params.primaryObjective)}:${normalizeAxisId(params.strategy)}`;
}

function parseDynamicInterventionId(
  interventionId: string,
): { primaryObjective: string; strategy: InterventionStrategy } | undefined {
  const normalized = interventionId.trim().toLowerCase();
  if (!normalized.startsWith("dyn:")) {
    return undefined;
  }
  const parts = normalized.split(":");
  if (parts.length < 3) {
    return undefined;
  }
  const objectiveRaw = normalizeAxisId(parts[1] ?? "");
  const strategyRaw = normalizeAxisId(parts.slice(2).join("-"));
  if (!objectiveRaw || !strategyRaw) {
    return undefined;
  }
  return {
    primaryObjective: objectiveRaw,
    strategy: strategyRaw,
  };
}

function inferPrimaryObjectiveFromNeeds(needs: LifeCoachNeedScores): string {
  return getPrimaryNeedKey(needs);
}

function inferPrimaryObjectiveFromMessages(
  messages: TranscriptMessage[],
  needs: LifeCoachNeedScores,
): string {
  const inferred = extractTopDimensions(messages, 3)[0];
  return inferred ?? inferPrimaryObjectiveFromNeeds(needs);
}

function extractStrategyCandidates(params: {
  messages: TranscriptMessage[];
  affect: LifeCoachAffectScores;
  primaryObjective: string;
  allowVisualization?: boolean;
}): InterventionStrategy[] {
  const recentUsers = params.messages.filter((msg) => msg.role === "user").slice(-24);
  const text = recentUsers.map((msg) => msg.text).join(" ");
  const strategyCounts = new Map<string, number>();
  for (const token of extractMeaningfulTokensFromText(text)) {
    if (token.endsWith("ing") || token.endsWith("ed") || token.length >= 6) {
      strategyCounts.set(token, (strategyCounts.get(token) ?? 0) + 1);
    }
  }
  const candidates: string[] = [];
  for (const [token] of [...strategyCounts.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, 3)) {
    if (token !== params.primaryObjective) {
      candidates.push(token);
    }
  }
  if (params.allowVisualization !== false && (text.includes("sora") || text.includes("visualiz"))) {
    candidates.unshift(`imagery-${normalizeAxisId(params.primaryObjective)}`);
  }
  if (params.affect.distress > 0.65) {
    candidates.push(`affect-distress-${Math.round(params.affect.distress * 10)}`);
  }
  if (params.affect.frustration > 0.6) {
    candidates.push(`affect-frustration-${Math.round(params.affect.frustration * 10)}`);
  }
  if (params.affect.momentum < 0.35) {
    candidates.push(`affect-momentum-${Math.round(params.affect.momentum * 10)}`);
  }
  if (!candidates.length) {
    candidates.push(`execute-${normalizeAxisId(params.primaryObjective)}`);
  }
  return [...new Set(candidates.map(normalizeAxisId))];
}

function inferStrategyFromContext(params: {
  messages: TranscriptMessage[];
  affect: LifeCoachAffectScores;
  primaryObjective: string;
  allowVisualization?: boolean;
}): InterventionStrategy {
  return (
    extractStrategyCandidates({
      messages: params.messages,
      affect: params.affect,
      primaryObjective: params.primaryObjective,
      allowVisualization: params.allowVisualization,
    })[0] ?? `execute-${normalizeAxisId(params.primaryObjective)}`
  );
}

function inferStrategyFromInterventionId(interventionId: string): InterventionStrategy | undefined {
  const parsed = parseDynamicInterventionId(interventionId);
  if (parsed) {
    return parsed.strategy;
  }
  const normalized = interventionId.toLowerCase();
  const tokens = normalized
    .split(/[^a-z0-9]+/)
    .map(normalizeAxisId)
    .filter((token) => token && token !== "dyn");
  return tokens[1] ?? tokens[0];
}

function inferScienceIntervention(
  messages: TranscriptMessage[],
  needs: LifeCoachNeedScores,
  affect: LifeCoachAffectScores,
): LifeCoachInterventionId {
  const primaryObjective = inferPrimaryObjectiveFromMessages(messages, needs);
  const strategy = inferStrategyFromContext({
    messages,
    affect,
    primaryObjective,
  });
  return buildDynamicInterventionId({
    primaryObjective,
    strategy,
  });
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<unknown | undefined> {
  if (typeof fetch !== "function") {
    return undefined;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return undefined;
    }
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchDynamicScienceReferences(params: {
  query: string;
  maxPapers: number;
  timeoutMs: number;
  cacheMs: number;
}): Promise<ScienceReference[]> {
  const cacheKey = `${params.query}|${params.maxPapers}`;
  const cached = SCIENCE_REFERENCE_CACHE.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.references;
  }
  const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&sort=relevance&retmax=${params.maxPapers}&term=${encodeURIComponent(params.query)}`;
  const searchRaw = await fetchJsonWithTimeout(searchUrl, params.timeoutMs);
  if (!searchRaw || typeof searchRaw !== "object") {
    return [];
  }
  const idList = ((searchRaw as { esearchresult?: { idlist?: unknown } }).esearchresult?.idlist ?? []) as unknown[];
  const ids = idList.filter((id): id is string => typeof id === "string" && id.trim().length > 0).slice(0, params.maxPapers);
  if (!ids.length) {
    return [];
  }
  const summaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}`;
  const summaryRaw = await fetchJsonWithTimeout(summaryUrl, params.timeoutMs);
  if (!summaryRaw || typeof summaryRaw !== "object") {
    return [];
  }
  const result = (summaryRaw as { result?: Record<string, unknown> }).result ?? {};
  const references: ScienceReference[] = [];
  for (const id of ids) {
    const entry = result[id];
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const typed = entry as { title?: unknown; pubdate?: unknown };
    const title = typeof typed.title === "string" ? typed.title.trim() : "";
    if (!title) {
      continue;
    }
    const yearMatch = typeof typed.pubdate === "string" ? typed.pubdate.match(/\b(19|20)\d{2}\b/) : null;
    const year = yearMatch?.[0];
    references.push({
      title: year ? `${title} (${year})` : title,
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
    });
  }
  SCIENCE_REFERENCE_CACHE.set(cacheKey, {
    expiresAt: now + params.cacheMs,
    references,
  });
  return references;
}

async function deriveDynamicScienceInsight(params: {
  messages: TranscriptMessage[];
  needs: LifeCoachNeedScores;
  affect: LifeCoachAffectScores;
  lifeCoach?: HeartbeatLifeCoachConfig;
}): Promise<ScienceInsight | undefined> {
  const recentUsers = params.messages.filter((msg) => msg.role === "user").slice(-24);
  if (recentUsers.length === 0) {
    return undefined;
  }
  const runtime = resolveScienceRuntime(params.lifeCoach);
  const tokens = extractScienceTokens(recentUsers);
  if (tokens.length < 2) {
    return undefined;
  }
  const riskId = summarizeRiskLabel(tokens);
  const uniqueTerms = [...new Set(tokens)].slice(0, 6);
  const query = `${uniqueTerms.join(" ")} behavior intervention randomized trial`;
  const primaryNeed = getPrimaryNeedKey(params.needs);
  const primaryNeedLabel = objectiveTitle(primaryNeed);
  const keywordDensity = uniqueTerms.length / 8;
  const confidence = clamp01(
    keywordDensity * 0.45 + (params.needs[primaryNeed] ?? 0.5) * 0.35 + params.affect.distress * 0.2,
  );
  if (confidence < runtime.minConfidence) {
    return undefined;
  }
  const recommendedIntervention = inferScienceIntervention(
    recentUsers,
    params.needs,
    params.affect,
  );
  const references = await fetchDynamicScienceReferences({
    query,
    maxPapers: runtime.maxPapers,
    timeoutMs: runtime.fetchTimeoutMs,
    cacheMs: runtime.cacheMs,
  });
  const trajectoryForecast = `If the current pattern around "${riskId}" continues, ${primaryNeedLabel} is likely to remain constrained over time.`;
  const improvementForecast = `If intervention is applied consistently and tracked, ${primaryNeedLabel} should improve in the coming weeks.`;
  const recommendedSpec = materializeInterventionSpec({
    interventionId: recommendedIntervention,
    needs: params.needs,
    affect: params.affect,
    messages: recentUsers,
    allowSoraVisualization: params.lifeCoach?.allowSoraVisualization ?? DEFAULT_ALLOW_SORA,
  });
  const recommendedAction = recommendedSpec.action({
    needs: params.needs,
    tone: params.affect.distress > 0.6 ? "supportive" : "direct",
  });
  return {
    riskId,
    confidence: round2(confidence),
    trajectoryForecast,
    improvementForecast,
    recommendedAction,
    recommendedIntervention,
    references,
    forceIntervention: confidence >= 0.8,
  };
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
  return {};
}

function emptyPreferenceModel(): LifeCoachPreferenceModel {
  return {
    objectiveBias: {},
    interventionAffinity: {},
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
    for (const [interventionId, entry] of Object.entries(sourceStats as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object" || !interventionId.trim()) {
        continue;
      }
      const typed = entry as Partial<LifeCoachInterventionStat>;
      normalized.stats[interventionId] = {
        sent: Number.isFinite(typed.sent) ? Math.max(0, Math.floor(typed.sent as number)) : 0,
        completed: Number.isFinite(typed.completed) ? Math.max(0, Math.floor(typed.completed as number)) : 0,
        ignored: Number.isFinite(typed.ignored) ? Math.max(0, Math.floor(typed.ignored as number)) : 0,
        rejected: Number.isFinite(typed.rejected) ? Math.max(0, Math.floor(typed.rejected as number)) : 0,
      };
    }
  }
  const sourcePreferences = (value as { preferences?: unknown }).preferences;
  if (sourcePreferences && typeof sourcePreferences === "object") {
    const typed = sourcePreferences as Partial<LifeCoachPreferenceModel>;
    const objectiveBias = typed.objectiveBias as Partial<Record<string, number>> | undefined;
    const interventionAffinity = typed.interventionAffinity as Partial<Record<string, number>> | undefined;
    for (const [objective, valueForObjective] of Object.entries(objectiveBias ?? {})) {
      if (!objective.trim() || typeof valueForObjective !== "number") {
        continue;
      }
      normalized.preferences.objectiveBias[normalizeAxisId(objective)] = clampSigned(valueForObjective);
    }
    for (const [intervention, valueForIntervention] of Object.entries(interventionAffinity ?? {})) {
      if (!intervention.trim() || typeof valueForIntervention !== "number") {
        continue;
      }
      normalized.preferences.interventionAffinity[intervention] = clampSigned(valueForIntervention);
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
  const interventionLabel = normalizeInterventionLabel(params.intervention);
  return (
    `${prefix} did the "${interventionLabel}" step happen? ` +
    `If blocked, run a 5-minute reduced version now and reply ${doneToken} or ${helpToken}.`
  );
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

function resolveObjectives(
  cfg: HeartbeatLifeCoachConfig | undefined,
  needs: LifeCoachNeedScores,
): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const objective of Object.keys(needs)) {
    merged[normalizeAxisId(objective)] = DEFAULT_OBJECTIVE_WEIGHT;
  }
  for (const [objective, value] of Object.entries(cfg?.objectives ?? {})) {
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

function applyObjectivePreferenceBias(params: {
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
  for (const objective of Object.keys(state.preferences.objectiveBias)) {
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
  const stressLoad = getAverageNeed(params.needs);
  return stressLoad >= 0.6 ? "supportive" : "direct";
}

function normalizeInterventionLabel(value: string): string {
  return value
    .replace(/^dyn:/, "")
    .split(":")
    .map((part) => humanizeAxisId(part))
    .join(" / ");
}

function objectiveTitle(objective: string): string {
  return humanizeAxisId(objective);
}

function createInterventionObjectiveWeights(
  primaryObjective: string,
  strategy: InterventionStrategy,
  needs: LifeCoachNeedScores,
): Record<string, number> {
  const normalizedPrimary = normalizeAxisId(primaryObjective);
  const weights: Record<string, number> = { [normalizedPrimary]: 1 };
  const secondary = Object.entries(needs)
    .toSorted((a, b) => b[1] - a[1])
    .map(([key]) => normalizeAxisId(key))
    .find((key) => key !== normalizedPrimary);
  if (secondary) {
    weights[secondary] = 0.35;
  }
  const strategyComplexity = normalizeAxisId(strategy).split("-").filter(Boolean).length;
  weights[normalizedPrimary] = Math.max(weights[normalizedPrimary] ?? 0, clamp01(0.85 + strategyComplexity * 0.03));
  return weights;
}

function createInterventionEffects(
  primaryObjective: string,
  strategy: InterventionStrategy,
  needs: LifeCoachNeedScores,
): Record<string, number> {
  const normalizedPrimary = normalizeAxisId(primaryObjective);
  const effects: Record<string, number> = {
    [normalizedPrimary]: 0.68,
  };
  const secondary = Object.entries(needs)
    .toSorted((a, b) => b[1] - a[1])
    .map(([key]) => normalizeAxisId(key))
    .find((key) => key !== normalizedPrimary);
  if (secondary) {
    effects[secondary] = 0.28;
  }
  const strategyComplexity = normalizeAxisId(strategy).split("-").filter(Boolean).length;
  effects[normalizedPrimary] = Math.max(
    effects[normalizedPrimary] ?? 0,
    clamp01(0.62 + strategyComplexity * 0.04),
  );
  return effects;
}

function baseFrictionForStrategy(strategy: InterventionStrategy): number {
  const normalized = normalizeAxisId(strategy);
  const complexity = normalized.split("-").filter(Boolean).length;
  return round2(Math.max(0.18, Math.min(0.36, 0.18 + complexity * 0.03)));
}

function followUpMinutesForStrategy(strategy: InterventionStrategy): number {
  const complexity = normalizeAxisId(strategy).split("-").filter(Boolean).length;
  return Math.max(20, Math.min(45, 22 + complexity * 4));
}

function actionTemplate(params: {
  primaryObjective: string;
  strategy: InterventionStrategy;
  tone: ResolvedTone;
}): string {
  const supportivePrefix = "Gentle next step:";
  const directPrefix = "Do this now:";
  const prefix = params.tone === "supportive" ? supportivePrefix : directPrefix;
  const strategy = normalizeAxisId(params.strategy);
  const objective = objectiveTitle(params.primaryObjective);

  if (strategy.includes("visual") || strategy.includes("imagery") || strategy.includes("sora")) {
    return `${prefix} run a short Sora-style scene of yourself executing the first minute, then immediately do that first minute in real life.`;
  }
  return `${prefix} use the "${objectiveTitle(strategy)}" approach for ${objective}: start a 12-minute timer and execute the first visible step now.`;
}

function fallbackTemplate(params: {
  primaryObjective: string;
  strategy: InterventionStrategy;
}): string {
  const label = objectiveTitle(params.primaryObjective);
  if (normalizeAxisId(params.strategy).includes("visual")) {
    return `If visualization feels heavy, skip video and execute a 3-minute real-world start aimed at ${label}.`;
  }
  return `If this feels too big, scale to a 3-5 minute version focused on ${label}.`;
}

function evidenceNoteTemplate(params: {
  primaryObjective: string;
  strategy: InterventionStrategy;
}): string {
  return (
    `Evidence note: use "${objectiveTitle(params.strategy)}" as the operational approach for ${objectiveTitle(params.primaryObjective)}. ` +
    "Keep the step concrete, low-friction, and immediately executable."
  );
}

function toolHintTemplate(params: {
  primaryObjective: string;
  strategy: InterventionStrategy;
}): string {
  if (normalizeAxisId(params.strategy).includes("visual") || normalizeAxisId(params.strategy).includes("imagery")) {
    return "Use Sora prompt generation only if it immediately leads to a concrete physical step.";
  }
  return `Use one timer and one checklist item aligned with "${objectiveTitle(params.strategy)}".`;
}

function inferInterventionSemantics(params: {
  interventionId: string;
  needs: LifeCoachNeedScores;
  affect: LifeCoachAffectScores;
  messages: TranscriptMessage[];
  allowSoraVisualization: boolean;
}): { primaryObjective: string; strategy: InterventionStrategy } {
  const parsed = parseDynamicInterventionId(params.interventionId);
  if (parsed) {
    const strategy = normalizeAxisId(parsed.strategy);
    if (strategy.includes("visual") && !params.allowSoraVisualization) {
      return {
        primaryObjective: parsed.primaryObjective,
        strategy: `execute-${normalizeAxisId(parsed.primaryObjective)}`,
      };
    }
    return parsed;
  }
  const inferredObjective =
    inferObjectivesFromInterventionId(params.interventionId)[0] ??
    inferPrimaryObjectiveFromMessages(params.messages, params.needs);
  const inferredStrategy =
    inferStrategyFromInterventionId(params.interventionId) ??
    inferStrategyFromContext({
      messages: params.messages,
      affect: params.affect,
      primaryObjective: inferredObjective,
      allowVisualization: params.allowSoraVisualization,
    });
  if (normalizeAxisId(inferredStrategy).includes("visual") && !params.allowSoraVisualization) {
    return {
      primaryObjective: inferredObjective,
      strategy: `execute-${normalizeAxisId(inferredObjective)}`,
    };
  }
  return {
    primaryObjective: inferredObjective,
    strategy: inferredStrategy,
  };
}

function materializeInterventionSpec(params: {
  interventionId: LifeCoachInterventionId;
  needs: LifeCoachNeedScores;
  affect: LifeCoachAffectScores;
  messages: TranscriptMessage[];
  allowSoraVisualization: boolean;
}): InterventionSpec {
  const semantics = inferInterventionSemantics({
    interventionId: params.interventionId,
    needs: params.needs,
    affect: params.affect,
    messages: params.messages,
    allowSoraVisualization: params.allowSoraVisualization,
  });
  return {
    id: params.interventionId,
    primaryObjective: semantics.primaryObjective,
    strategy: semantics.strategy,
    objectives: createInterventionObjectiveWeights(semantics.primaryObjective, semantics.strategy, params.needs),
    effects: createInterventionEffects(semantics.primaryObjective, semantics.strategy, params.needs),
    baseFriction: baseFrictionForStrategy(semantics.strategy),
    followUpMinutes: followUpMinutesForStrategy(semantics.strategy),
    action: ({ tone }) =>
      actionTemplate({
        primaryObjective: semantics.primaryObjective,
        strategy: semantics.strategy,
        tone,
      }),
    fallback: fallbackTemplate({
      primaryObjective: semantics.primaryObjective,
      strategy: semantics.strategy,
    }),
    evidenceNote: evidenceNoteTemplate({
      primaryObjective: semantics.primaryObjective,
      strategy: semantics.strategy,
    }),
    toolHint: toolHintTemplate({
      primaryObjective: semantics.primaryObjective,
      strategy: semantics.strategy,
    }),
    supportsSora:
      normalizeAxisId(semantics.strategy).includes("visual") ||
      normalizeAxisId(semantics.strategy).includes("imagery") ||
      normalizeAxisId(semantics.strategy).includes("sora"),
  };
}

function resolveStrategiesForObjective(params: {
  objective: string;
  affect: LifeCoachAffectScores;
  messages: TranscriptMessage[];
  allowSoraVisualization: boolean;
}): InterventionStrategy[] {
  const strategies = new Set<string>(
    extractStrategyCandidates({
      messages: params.messages,
      affect: params.affect,
      primaryObjective: params.objective,
      allowVisualization: params.allowSoraVisualization,
    }),
  );
  strategies.add(`${normalizeAxisId(params.objective)}-plan`);
  if (!strategies.size) {
    strategies.add("micro-step");
  }
  return [...strategies].slice(0, 4);
}

function buildDynamicInterventions(params: {
  messages: TranscriptMessage[];
  needs: LifeCoachNeedScores;
  affect: LifeCoachAffectScores;
  allowSoraVisualization: boolean;
  scienceInsight?: ScienceInsight;
}): InterventionSpec[] {
  const rankedObjectives = Object.entries(params.needs).toSorted((a, b) => b[1] - a[1]);
  const selectedObjectives = rankedObjectives
    .filter(([, score], idx) => score >= 0.25 || idx === 0)
    .map(([objective]) => normalizeAxisId(objective))
    .filter(Boolean)
    .filter((objective, idx, arr) => arr.indexOf(objective) === idx)
    .slice(0, 3)
    .map((objective) => objective);
  const generated = new Map<string, InterventionSpec>();

  for (const objective of selectedObjectives) {
    const strategies = resolveStrategiesForObjective({
      objective,
      affect: params.affect,
      messages: params.messages,
      allowSoraVisualization: params.allowSoraVisualization,
    });
    for (const strategy of strategies) {
      const id = buildDynamicInterventionId({
        primaryObjective: objective,
        strategy,
      });
      generated.set(
        id,
        materializeInterventionSpec({
          interventionId: id,
          needs: params.needs,
          affect: params.affect,
          messages: params.messages,
          allowSoraVisualization: params.allowSoraVisualization,
        }),
      );
    }
  }
  if (params.scienceInsight?.recommendedIntervention) {
    const recommendedId = params.scienceInsight.recommendedIntervention;
    generated.set(
      recommendedId,
      materializeInterventionSpec({
        interventionId: recommendedId,
        needs: params.needs,
        affect: params.affect,
        messages: params.messages,
        allowSoraVisualization: params.allowSoraVisualization,
      }),
    );
  }
  return [...generated.values()];
}

function resolveActiveInterventions(
  candidates: InterventionSpec[],
  cfg?: HeartbeatLifeCoachConfig,
): InterventionSpec[] {
  const allow = new Set((cfg?.interventions?.allow ?? []).map((id) => id.trim().toLowerCase()));
  const deny = new Set((cfg?.interventions?.deny ?? []).map((id) => id.trim().toLowerCase()));
  const allowSoraVisualization = cfg?.allowSoraVisualization ?? DEFAULT_ALLOW_SORA;
  return candidates.filter((spec) => {
    const specId = spec.id.trim().toLowerCase();
    if (spec.supportsSora && !allowSoraVisualization) {
      return false;
    }
    if (allow.size > 0 && !allow.has(specId)) {
      return false;
    }
    if (deny.has(specId)) {
      return false;
    }
    return true;
  });
}

function estimateNeeds(messages: TranscriptMessage[]): LifeCoachNeedScores {
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

function estimateAffect(
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

function deriveScienceInsight(params: {
  messages: TranscriptMessage[];
  needs: LifeCoachNeedScores;
  affect: LifeCoachAffectScores;
  topics: ScienceTopicSpec[];
  minConfidence: number;
}): ScienceInsight | undefined {
  const recentUsers = params.messages.filter((msg) => msg.role === "user").slice(-24);
  if (recentUsers.length === 0 || params.topics.length === 0) {
    return undefined;
  }
  const denom = Math.max(1, recentUsers.length * 1.2);
  const candidates: ScienceInsight[] = [];
  for (const topic of params.topics) {
    const keywordHits = countMentions(recentUsers, topic.keywords);
    const keywordSignal = keywordHits / denom;
    let objectiveSignal = 0;
    if (topic.objectiveWeights) {
      for (const [objective, weight] of Object.entries(topic.objectiveWeights)) {
        objectiveSignal += (params.needs[objective] ?? 0) * clamp01(weight);
      }
    }
    let affectSignal = 0;
    if (topic.affectWeights) {
      for (const [key, weight] of Object.entries(topic.affectWeights) as Array<
        [keyof LifeCoachAffectScores, number]
      >) {
        affectSignal += (params.affect[key] ?? 0) * clamp01(weight);
      }
    }
    const confidence = clamp01(keywordSignal + objectiveSignal + affectSignal + (topic.confidenceBias ?? 0));
    const threshold = clamp01(topic.minConfidence ?? params.minConfidence);
    if (confidence < threshold) {
      continue;
    }
    candidates.push({
      riskId: topic.id,
      confidence: round2(confidence),
      trajectoryForecast: topic.trajectoryForecast,
      improvementForecast: topic.improvementForecast,
      recommendedAction: topic.recommendedAction,
      recommendedIntervention: topic.recommendedIntervention,
      references: topic.references ?? [],
      forceIntervention:
        typeof topic.forceInterventionAtConfidence === "number"
          ? confidence >= clamp01(topic.forceInterventionAtConfidence)
          : false,
    });
  }

  if (candidates.length === 0) {
    return undefined;
  }
  return candidates.toSorted((a, b) => b.confidence - a.confidence)[0];
}

function countNudgesInWindow(state: LifeCoachStateFile, now: number, windowMs: number): number {
  return state.history.filter((entry) => now - entry.sentAt <= windowMs).length;
}

function emptyStat(): LifeCoachInterventionStat {
  return { sent: 0, completed: 0, ignored: 0, rejected: 0 };
}

function ensureInterventionStat(state: LifeCoachStateFile, interventionId: string): LifeCoachInterventionStat {
  if (!state.stats[interventionId]) {
    state.stats[interventionId] = emptyStat();
  }
  return state.stats[interventionId];
}

function completionProbability(
  stats: LifeCoachInterventionStat | undefined,
  tone: ResolvedTone,
): number {
  const normalized = stats ?? emptyStat();
  const total = normalized.sent;
  if (total <= 0) {
    return tone === "supportive" ? 0.62 : 0.58;
  }
  const successRate = (normalized.completed + 1) / (total + 2);
  const rejectRate = normalized.rejected / Math.max(1, total);
  return clamp01(successRate * (tone === "supportive" ? 1.04 : 1) - rejectRate * 0.25);
}

function rejectionRisk(stats: LifeCoachInterventionStat | undefined): number {
  const normalized = stats ?? emptyStat();
  if (normalized.sent <= 0) {
    return 0.12;
  }
  return clamp01(normalized.rejected / normalized.sent);
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

function inferObjectivesFromInterventionId(intervention: string): string[] {
  const parsed = parseDynamicInterventionId(intervention);
  if (parsed) {
    return [parsed.primaryObjective];
  }
  const normalized = intervention.toLowerCase();
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
      clampSigned(params.state.preferences.objectiveBias[objective] + delta),
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
  spec: InterventionSpec;
  needs: LifeCoachNeedScores;
  affect: LifeCoachAffectScores;
}): string | undefined {
  if (!decision.spec.supportsSora) {
    return undefined;
  }
  const topNeed = getPrimaryNeedKey(decision.needs);
  const openingBeat = `user starts a concrete action that improves ${objectiveTitle(topNeed)}`;
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
  const stat = ensureInterventionStat(params.state, pending.intervention);
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
  objectives: Record<string, number>;
  state: LifeCoachStateFile;
  preferences: LifeCoachPreferenceModel;
  tone: ResolvedTone;
  relapsePressure: number;
  scienceInsight?: ScienceInsight;
}): LifeCoachDecision | undefined {
  if (params.scienceInsight?.forceIntervention) {
    const prioritySpec = params.activeInterventions.find(
      (spec) => spec.id === params.scienceInsight?.recommendedIntervention,
    );
    if (prioritySpec) {
      return {
        phase: "initial",
        intervention: prioritySpec.id,
        score: round2(0.75 + params.scienceInsight.confidence * 0.2),
        rationale: `science-priority override for ${params.scienceInsight.riskId}`,
        action: prioritySpec.action({ needs: params.needs, tone: params.tone }),
        fallback: prioritySpec.fallback,
        followUpMinutes: adjustFollowUpMinutes(prioritySpec.followUpMinutes, params.affect),
        tone: params.tone,
        needs: params.needs,
        affect: params.affect,
        evidenceNote: prioritySpec.evidenceNote,
        toolHint: prioritySpec.toolHint,
        scienceInsight: params.scienceInsight,
      };
    }
  }

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
    const averageNeed = getAverageNeed(params.needs);
    const topNeed = getPrimaryNeedKey(params.needs);

    let expectedGain = 0;
    for (const objective of Object.keys(params.objectives)) {
      const need = params.needs[objective] ?? 0;
      const objectiveWeight = params.objectives[objective] ?? 1;
      const effect = spec.effects[objective] ?? 0;
      const alignment = spec.objectives[objective] ?? 0.2;
      expectedGain += need * objectiveWeight * effect * alignment;
    }

    const friction =
      spec.baseFriction +
      (averageNeed > 0.75 ? 0.08 : 0) +
      (params.affect.frustration > 0.55 && spec.baseFriction > 0.28 ? 0.1 : 0);
    const relapseBoost =
      params.relapsePressure > 0.45
        ? spec.primaryObjective === topNeed
          ? 0.1
          : spec.baseFriction <= 0.24
            ? 0.05
            : 0
        : 0;
    const distressBoost =
      params.affect.distress > 0.55 && spec.baseFriction <= 0.24
        ? 0.1
        : params.affect.distress > 0.55 && spec.primaryObjective === topNeed
          ? 0.06
        : 0;
    const momentumBoost =
      params.affect.momentum > 0.6 && spec.baseFriction <= 0.26
        ? 0.08
        : params.affect.momentum > 0.6
          ? 0.03
        : 0;
    const scienceBoost =
      params.scienceInsight?.recommendedIntervention === spec.id
        ? params.scienceInsight.confidence * 0.32 + (params.scienceInsight.forceIntervention ? 0.12 : 0)
        : 0;
    const score =
      expectedGain * (0.6 + completionProb) -
      friction -
      reactance * 0.35 -
      fatigue * 0.24 +
      relapseBoost +
      distressBoost +
      momentumBoost +
      scienceBoost +
      preferenceAffinity * 0.18;
    const rationale =
      `expectedGain=${round2(expectedGain)}, completion=${round2(completionProb)}, ` +
      `friction=${round2(friction)}, reactance=${round2(reactance)}, fatigue=${round2(fatigue)}, ` +
      `affinity=${round2(preferenceAffinity)}, relapse=${round2(params.relapsePressure)}, ` +
      `objective=${spec.primaryObjective}, strategy=${spec.strategy}, ` +
      `scienceBoost=${round2(scienceBoost)}, frustration=${round2(params.affect.frustration)}, ` +
      `distress=${round2(params.affect.distress)}`;

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
      spec: best.spec,
      needs: params.needs,
      affect: params.affect,
    }),
    needs: params.needs,
    affect: params.affect,
    evidenceNote: best.spec.evidenceNote,
    toolHint: best.spec.toolHint,
    scienceInsight: params.scienceInsight,
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
  const spec = materializeInterventionSpec({
    interventionId: params.pending.intervention,
    needs: params.needs,
    affect: params.affect,
    messages: [],
    allowSoraVisualization: true,
  });
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
    evidenceNote: spec.evidenceNote,
    toolHint: spec.toolHint,
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

function formatScienceInsight(scienceInsight: ScienceInsight): string[] {
  return [
    "[AUTOLIFE SCIENCE]",
    `Detected risk: ${scienceInsight.riskId} (confidence=${scienceInsight.confidence}).`,
    `Recommended intervention: ${scienceInsight.recommendedIntervention}.`,
    `Trajectory forecast: ${scienceInsight.trajectoryForecast}`,
    `Improvement forecast: ${scienceInsight.improvementForecast}`,
    `Evidence-backed action now: ${scienceInsight.recommendedAction}`,
    ...scienceInsight.references.map((ref) => `Paper: ${ref.title} - ${ref.url}`),
  ];
}

function buildPrompt(params: {
  basePrompt: string;
  decision?: LifeCoachDecision;
  needs: LifeCoachNeedScores;
  affect: LifeCoachAffectScores;
  preferences: LifeCoachPreferenceModel;
  scienceInsight?: ScienceInsight;
  blockedReason?: string;
  actionContract: {
    enabled: boolean;
    doneToken: string;
    helpToken: string;
  };
}): string {
  const needsLine = `State estimate (0..1 need severity): ${
    Object.entries(params.needs)
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([dimension, value]) => `${normalizeAxisId(dimension)}=${round2(value)}`)
      .join(", ") || `${DEFAULT_GENERIC_OBJECTIVE}=0.5`
  }.`;
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
      `${params.scienceInsight ? `${formatScienceInsight(params.scienceInsight).join("\n")}\n` : ""}` +
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
    ...(params.scienceInsight ? formatScienceInsight(params.scienceInsight) : []),
    "Output rules:",
    "- Send exactly one concise nudge with one immediate next action.",
    "- Prefer low-risk, evidence-backed micro-interventions derived from the user's current pattern and constraints.",
    "- When possible, include one concrete tool move (timer, blocker, DND, checklist) that immediately starts the action.",
    "- For medication-related suggestions (e.g., smoking cessation meds), advise clinician guidance and avoid prescribing.",
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
    .filter((entry) => entry.status === "ignored" || entry.status === "rejected")
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
  cfg: LifeCoachConfig;
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
    objectives: resolveObjectives(lifeCoach, needs),
    preferences: state.preferences,
  });
  const tone = resolveTone({
    cfg: lifeCoach,
    needs,
    affect,
    preferences: state.preferences,
  });
  const relapsePressure = computeRelapsePressure(state);
  const scienceEnabled = lifeCoach.science?.enabled === true;
  const scienceMode = resolveScienceMode(lifeCoach);
  let scienceInsight: ScienceInsight | undefined;
  if (scienceEnabled && scienceMode !== "dynamic") {
    const scienceTopics = await loadScienceTopics({
      cfg: params.cfg,
      agentId: params.agentId,
      lifeCoach,
    });
    if (scienceTopics.length > 0) {
      scienceInsight = deriveScienceInsight({
        messages,
        needs,
        affect,
        topics: scienceTopics,
        minConfidence: resolveScienceRuntime(lifeCoach).minConfidence,
      });
    }
  }
  if (scienceEnabled && !scienceInsight && scienceMode !== "catalog") {
    scienceInsight = await deriveDynamicScienceInsight({
      messages,
      needs,
      affect,
      lifeCoach,
    });
  }

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
        scienceInsight,
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
        scienceInsight,
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
        scienceInsight,
        blockedReason: `daily nudge cap reached (${maxNudgesPerDay})`,
        actionContract,
      }),
    };
  }

  const allowSoraVisualization = lifeCoach.allowSoraVisualization ?? DEFAULT_ALLOW_SORA;
  const generatedInterventions = buildDynamicInterventions({
    messages,
    needs,
    affect,
    allowSoraVisualization,
    scienceInsight,
  });
  const activeInterventions = resolveActiveInterventions(generatedInterventions, {
    ...lifeCoach,
    allowSoraVisualization,
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
    scienceInsight,
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
      scienceInsight,
      blockedReason: decision
        ? undefined
        : activeInterventions.length === 0
          ? "intervention filters excluded all generated candidates"
          : "no intervention cleared score threshold",
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
  const stat = ensureInterventionStat(state, params.decision.intervention);
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
  deriveScienceInsight,
  resolveObjectives,
  applyObjectivePreferenceBias,
  resolveActiveInterventions,
  selectIntervention,
  normalizeStateFile,
  computeRelapsePressure,
};
