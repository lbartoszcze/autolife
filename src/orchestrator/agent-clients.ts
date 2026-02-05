import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
  CurrentStateAssessment,
  EvidenceFinding,
  Forecast,
  InterventionPlan,
  UserPreferenceProfile,
} from "../contracts.js";
import type { OrchestratorAgentClients, TranscriptMessage } from "./orchestrator.js";

type PreferenceModule = {
  buildUserPreferenceProfile?: (input: {
    messages: TranscriptMessage[];
    outcomes?: unknown[];
    previous?: unknown;
    now?: number;
  }) => UserPreferenceProfile | Promise<UserPreferenceProfile>;
  inferUserPreferenceProfile?: (input: {
    messages: TranscriptMessage[];
    outcomes?: unknown[];
    previous?: unknown;
    now?: number;
    nowMs?: number;
  }) => UserPreferenceProfile | Promise<UserPreferenceProfile>;
};

type StateModule = {
  assessCurrentState: (input: unknown) => CurrentStateAssessment | Promise<CurrentStateAssessment>;
  createTranscriptFirstDataSourcesModel?: (input: {
    messages: TranscriptMessage[];
    nowMs?: number;
  }) => unknown;
};

type EvidenceModule = {
  buildEvidenceFindings: (input: {
    topics: Array<string | { topicId?: string; query: string }>;
    now?: Date;
  }) => EvidenceFinding[] | Promise<EvidenceFinding[]>;
};

type ForecastModule = {
  buildForecast: (input: {
    state: CurrentStateAssessment;
    preferences?: UserPreferenceProfile;
    evidence?: EvidenceFinding[];
    horizonDays?: number;
    intervention?: Pick<InterventionPlan, "id" | "objectiveIds" | "expectedImpact" | "effort">;
  }) => Forecast | Promise<Forecast>;
};

type InterventionModule = {
  buildInterventionPlan?: (input: {
    state: CurrentStateAssessment;
    preferences?: UserPreferenceProfile;
    evidence?: EvidenceFinding[];
    forecast?: Forecast;
  }) =>
    | {
        selected: InterventionPlan;
        alternatives?: InterventionPlan[];
        ranked?: Array<InterventionPlan & { score?: number }>;
      }
    | Promise<{
        selected: InterventionPlan;
        alternatives?: InterventionPlan[];
        ranked?: Array<InterventionPlan & { score?: number }>;
      }>;
  synthesizeInterventionPlan?: (input: {
    state: CurrentStateAssessment;
    preferences?: UserPreferenceProfile;
    evidence?: EvidenceFinding[];
    forecast?: Forecast;
  }) =>
    | {
        selected: InterventionPlan;
        alternatives?: InterventionPlan[];
        ranked?: Array<InterventionPlan & { score?: number }>;
      }
    | Promise<{
        selected: InterventionPlan;
        alternatives?: InterventionPlan[];
        ranked?: Array<InterventionPlan & { score?: number }>;
      }>;
};

async function importModule<T>(filePath: string): Promise<T> {
  const url = pathToFileURL(filePath).href;
  return (await import(url)) as T;
}

async function maybePromise<T>(value: T | Promise<T>): Promise<T> {
  return await value;
}

async function assessState(
  stateModule: StateModule,
  messages: TranscriptMessage[],
  now: number,
): Promise<CurrentStateAssessment> {
  if (typeof stateModule.createTranscriptFirstDataSourcesModel === "function") {
    const dataSources = stateModule.createTranscriptFirstDataSourcesModel({
      messages,
      nowMs: now,
    });
    return await maybePromise(
      stateModule.assessCurrentState({
        nowMs: now,
        dataSources,
      }),
    );
  }

  return await maybePromise(
    stateModule.assessCurrentState({
      transcript: messages,
      now,
    }),
  );
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
      return await maybePromise(
        prefBuilder({
          messages,
          now,
          nowMs: now,
        }),
      );
    },

    async state({ messages, now }) {
      return await assessState(stateModule, messages, now);
    },

    async evidence({ topics, now }) {
      return await maybePromise(
        evidenceModule.buildEvidenceFindings({
          topics: topics.map((topic) => ({ query: topic })),
          now: new Date(now),
        }),
      );
    },

    async forecast({ state, preferences, evidence }) {
      return await maybePromise(
        forecastModule.buildForecast({
          state,
          preferences,
          evidence,
        }),
      );
    },

    async intervention({ state, preferences, evidence, forecast }) {
      const buildIntervention =
        interventionModule.buildInterventionPlan ?? interventionModule.synthesizeInterventionPlan;
      if (!buildIntervention) {
        throw new Error("Intervention module does not expose a compatible planner");
      }
      const result = await maybePromise(
        buildIntervention({
          state,
          preferences,
          evidence,
          forecast,
        }),
      );

      return {
        selected: result.selected,
        alternatives: result.alternatives ?? [],
        ranked: result.ranked,
      };
    },
  };
}
