import { buildEvidenceFindings } from "../agents/evidence/evidence-agent.js";
import { buildForecast } from "../agents/forecast/forecast-agent.js";
import { synthesizeInterventionPlanDynamic } from "../agents/interventions/intervention-agent.js";
import { buildUserPreferenceProfile } from "../agents/preferences/preference-agent.js";
import { loadExternalDataAdapters } from "../agents/state/external-data-connectors.js";
import {
  assessCurrentState,
  createTranscriptFirstDataSourcesModel,
  type TranscriptMessage as StateTranscriptMessage,
} from "../agents/state/state-agent.js";
import type { OrchestratorAgentClients, TranscriptMessage } from "./orchestrator.js";

function toStateMessages(messages: TranscriptMessage[]): StateTranscriptMessage[] {
  return messages.map((message) => ({
    role: message.role,
    text: message.text,
    timestamp: message.timestamp,
  }));
}

export async function createWorkspaceAgentClients(): Promise<OrchestratorAgentClients> {
  return {
    async preference({ messages, now }) {
      return buildUserPreferenceProfile({
        messages,
        now,
      });
    },

    async state({ messages, now }) {
      const normalized = toStateMessages(messages);
      const externalAdapters = await loadExternalDataAdapters({ nowMs: now });
      const dataSources = createTranscriptFirstDataSourcesModel({
        messages: normalized,
        nowMs: now,
        additionalAdapters: externalAdapters,
      });
      return assessCurrentState({
        nowMs: now,
        dataSources,
      });
    },

    async evidence({ topics, now }) {
      return buildEvidenceFindings({
        topics: topics.map((topic) => ({ query: topic })),
        now: new Date(now),
      });
    },

    async forecast({ state, preferences, evidence }) {
      return buildForecast({
        state,
        preferences,
        evidence,
      });
    },

    async intervention({ state, preferences, evidence, forecast }) {
      return synthesizeInterventionPlanDynamic(
        {
          state,
          preferences,
          evidence,
          forecast,
        },
        {
          includeMentorComparison: process.env.AUTLIFE_ENABLE_MENTOR_COMPARISON !== "0",
          includeSoraVideoPlan: process.env.AUTLIFE_ENABLE_SORA_PLAN !== "0",
          queueSoraVideo: process.env.AUTLIFE_QUEUE_SORA === "1",
          soraWebhookUrl: process.env.AUTLIFE_SORA_WEBHOOK_URL,
        },
      );
    },
  };
}
