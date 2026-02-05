import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildEvidenceFindings } from "../src/agents/evidence/evidence-agent.js";
import { buildForecast } from "../src/agents/forecast/forecast-agent.js";
import { buildUserPreferenceProfile } from "../src/agents/preferences/preference-agent.js";
import {
  assessCurrentState,
  createTranscriptFirstDataSourcesModel,
} from "../src/agents/state/state-agent.js";
import { orchestrateDecision } from "../src/orchestrator/orchestrator.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("qa quality gate", () => {
  it("validates dynamic objective/need inference across preference and state agents", async () => {
    const now = Date.UTC(2026, 1, 5, 15, 0, 0);

    const profile = buildUserPreferenceProfile({
      now,
      messages: [
        {
          role: "user",
          timestamp: now - 60_000,
          text: "I want consistent violin practice and smoother bow control every morning.",
        },
      ],
    });

    const dataSources = createTranscriptFirstDataSourcesModel({
      messages: [
        {
          role: "user",
          timestamp: now - 30_000,
          text: "My violin practice gets derailed when I lose warmup momentum.",
        },
      ],
      nowMs: now,
    });

    const state = await assessCurrentState({
      nowMs: now,
      dataSources,
    });

    expect(Object.keys(profile.objectiveWeights).some((id) => id.includes("violin"))).toBe(true);
    expect(Object.keys(state.needs).some((id) => id.includes("violin"))).toBe(true);
  });

  it("enforces citation presence with real links in evidence findings", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("openalex")) {
        return jsonResponse({
          results: [
            {
              display_name: "Sleep intervention meta-analysis",
              doi: "10.5000/sleep-meta",
              publication_year: 2024,
              cited_by_count: 130,
              type: "meta-analysis",
              primary_location: {
                landing_page_url: "https://pubmed.ncbi.nlm.nih.gov/50000001/",
              },
            },
          ],
        });
      }
      return jsonResponse({
        message: {
          items: [
            {
              title: ["Sleep duration guideline update"],
              DOI: "10.5000/sleep-guide",
              URL: "https://doi.org/10.5000/sleep-guide",
              issued: {
                "date-parts": [[2023, 8, 1]],
              },
              "is-referenced-by-count": 44,
            },
          ],
        },
      });
    });

    const findings = await buildEvidenceFindings({
      topics: ["sleep quality"],
      fetchImpl: fetchMock,
    });

    expect(findings[0].references.length).toBeGreaterThan(0);
    expect(findings[0].references.every((ref) => ref.url.startsWith("https://"))).toBe(true);
    expect(findings[0].confidence).toBeGreaterThan(0.4);
  });

  it("checks forecast transparency requirements", () => {
    const forecast = buildForecast({
      horizonDays: 14,
      state: {
        needs: { focus: 0.8 },
        affect: { frustration: 0.6, distress: 0.65, momentum: 0.3 },
        signals: ["transcript"],
        freshness: {
          capturedAt: Date.UTC(2026, 1, 5, 14, 0, 0),
          ageMinutes: 90,
          completeness: 0.7,
        },
      },
      evidence: [{ topicId: "focus", claim: "", confidence: 0.72, references: [] }],
      intervention: {
        id: "dyn:focus:medium",
        objectiveIds: ["focus"],
        effort: "medium",
      },
    });

    expect(forecast.assumptions.length).toBeGreaterThanOrEqual(3);
    expect(forecast.baseline.toLowerCase()).toContain("14");
    expect(forecast.withIntervention.toLowerCase()).toContain("dyn:focus:medium");
    expect(forecast.confidence).toBeGreaterThan(0);
  });

  it("blocks unsafe recommendations in orchestrator adversarial path", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autolife-qa-"));
    try {
      const result = await orchestrateDecision({
        agentId: "qa",
        messages: [{ role: "user", text: "Need help quickly" }],
        nowMs: 5_000_000,
        stateDir: tmpDir,
        agents: {
          preference: {
            async inferProfile() {
              return {
                objectiveWeights: { focus: 1 },
                interventionAffinity: {},
                toneBias: { supportive: 0.5, direct: 0.5 },
                confidence: 0.5,
              };
            },
          },
          state: {
            async assess() {
              return {
                needs: { focus: 0.8 },
                affect: { frustration: 0.4, distress: 0.4, momentum: 0.4 },
                signals: ["qa"],
                freshness: { capturedAt: 5_000_000, ageMinutes: 0, completeness: 1 },
              };
            },
          },
          evidence: {
            async find() {
              return [];
            },
          },
          forecast: {
            async project() {
              return {
                horizonDays: 7,
                baseline: "",
                withIntervention: "",
                assumptions: [],
                confidence: 0.5,
              };
            },
          },
          intervention: {
            async synthesize() {
              return {
                selected: {
                  id: "dyn:bad:low",
                  objectiveIds: ["focus"],
                  action: "Use self-harm to force compliance.",
                  rationale: "Unsafe by design",
                  expectedImpact: "",
                  effort: "low" as const,
                  followUpMinutes: 60,
                  evidence: [],
                },
                alternatives: [],
              };
            },
          },
        },
      });

      expect(result.shouldNudge).toBe(false);
      expect(result.reason.toLowerCase()).toContain("safety");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
