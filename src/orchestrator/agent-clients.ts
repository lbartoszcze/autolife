import { buildEvidenceFindings } from "../agents/evidence/evidence-agent.js";
import { buildForecast } from "../agents/forecast/forecast-agent.js";
import { synthesizeInterventionPlan } from "../agents/interventions/intervention-agent.js";
import { buildUserPreferenceProfile } from "../agents/preferences/preference-agent.js";
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
      const dataSources = createTranscriptFirstDataSourcesModel({
        messages: normalized,
        nowMs: now,
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
      return synthesizeInterventionPlan({
        state,
        preferences,
        evidence,
        forecast,
      });
    },
  };
}
