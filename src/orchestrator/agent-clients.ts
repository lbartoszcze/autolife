import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OrchestratorAgentClients, TranscriptMessage } from "./orchestrator.js";

type PreferenceModule = {
  buildUserPreferenceProfile?: (input: {
    messages: TranscriptMessage[];
    outcomes?: unknown[];
    previous?: unknown;
    now?: number;
  }) => unknown;
  inferUserPreferenceProfile?: (input: {
    messages: TranscriptMessage[];
    outcomes?: unknown[];
    previous?: unknown;
    now?: number;
    nowMs?: number;
  }) => unknown;
};

type StateModule = {
  assessCurrentState: (input: {
    transcript: TranscriptMessage[];
    now?: number;
  }) => unknown;
};

type EvidenceModule = {
  buildEvidenceFindings: (input: {
    topics: Array<string | { topicId?: string; query: string }>;
    now?: Date;
  }) => Promise<unknown>;
};

type ForecastModule = {
  buildForecast: (input: {
    state: unknown;
    preferences: unknown;
    evidence: unknown;
    horizonDays?: number;
  }) => unknown;
};

type InterventionModule = {
  buildInterventionPlan: (input: {
    state: unknown;
    preferences: unknown;
    evidence: unknown;
    forecast: unknown;
  }) => {
    selected: unknown;
    alternatives?: unknown[];
    ranked?: unknown[];
  };
};

async function importModule<T>(filePath: string): Promise<T> {
  const url = pathToFileURL(filePath).href;
  return (await import(url)) as T;
}

export async function createWorkspaceAgentClients(params?: {
  workspaceRoot?: string;
}): Promise<OrchestratorAgentClients> {
  const root = params?.workspaceRoot ?? path.resolve(process.cwd(), "..");

  const prefPath = path.resolve(root, "autolife-pref", "src", "agents", "preferences", "preference-agent.ts");
  const statePath = path.resolve(root, "autolife-state", "src", "agents", "state", "state-agent.ts");
  const evidencePath = path.resolve(root, "autolife-evidence", "src", "agents", "evidence", "evidence-agent.ts");
  const forecastPath = path.resolve(root, "autolife-forecast", "src", "agents", "forecast", "forecast-agent.ts");
  const interventionPath = path.resolve(
    root,
    "autolife-intervention",
    "src",
    "agents",
    "interventions",
    "intervention-agent.ts",
  );

  const [prefModule, stateModule, evidenceModule, forecastModule, interventionModule] = await Promise.all([
    importModule<PreferenceModule>(prefPath),
    importModule<StateModule>(statePath),
    importModule<EvidenceModule>(evidencePath),
    importModule<ForecastModule>(forecastPath),
    importModule<InterventionModule>(interventionPath),
  ]);

  const prefBuilder = prefModule.buildUserPreferenceProfile ?? prefModule.inferUserPreferenceProfile;
  if (!prefBuilder) {
    throw new Error("Preference module does not expose a compatible profile builder");
  }

  return {
    async preference({ messages, now }) {
      return prefBuilder({
        messages,
        now,
      }) as Awaited<ReturnType<OrchestratorAgentClients["preference"]>>;
    },
    async state({ messages, now }) {
      return stateModule.assessCurrentState({
        transcript: messages,
        now,
      }) as Awaited<ReturnType<OrchestratorAgentClients["state"]>>;
    },
    async evidence({ topics, now }) {
      return (await evidenceModule.buildEvidenceFindings({
        topics: topics.map((topic) => ({ query: topic })),
        now: new Date(now),
      })) as Awaited<ReturnType<OrchestratorAgentClients["evidence"]>>;
    },
    async forecast({ state, preferences, evidence }) {
      return forecastModule.buildForecast({
        state,
        preferences,
        evidence,
      }) as Awaited<ReturnType<OrchestratorAgentClients["forecast"]>>;
    },
    async intervention({ state, preferences, evidence, forecast }) {
      return interventionModule.buildInterventionPlan({
        state,
        preferences,
        evidence,
        forecast,
      }) as Awaited<ReturnType<OrchestratorAgentClients["intervention"]>>;
    },
  };
}
