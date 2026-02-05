import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

function workspaceRoot(): string {
  return path.resolve(process.cwd(), "..");
}

async function importFromWorkspace<T>(...segments: string[]): Promise<T> {
  const filePath = path.resolve(workspaceRoot(), ...segments);
  const moduleUrl = pathToFileURL(filePath).href;
  return (await import(moduleUrl)) as T;
}

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
    const prefModule = await importFromWorkspace<{
      buildUserPreferenceProfile: (input: {
        messages: Array<{ role: "user" | "assistant"; text: string; timestamp?: number }>;
        now?: number;
      }) => {
        objectiveWeights: Record<string, number>;
      };
    }>("autolife-pref", "src", "agents", "preferences", "preference-agent.ts");

    const stateModule = await importFromWorkspace<{
      assessCurrentState: (input: {
        transcript: Array<{ role: "user" | "assistant"; text: string; timestamp?: number }>;
        now?: number;
      }) => {
        needs: Record<string, number>;
      };
    }>("autolife-state", "src", "agents", "state", "state-agent.ts");

    const now = Date.UTC(2026, 1, 5, 15, 0, 0);

    const profile = prefModule.buildUserPreferenceProfile({
      now,
      messages: [
        {
          role: "user",
          timestamp: now - 60_000,
          text: "I want consistent violin practice and smoother bow control every morning.",
        },
      ],
    });

    const state = stateModule.assessCurrentState({
      now,
      transcript: [
        {
          role: "user",
          timestamp: now - 30_000,
          text: "My violin practice gets derailed when I lose warmup momentum.",
        },
      ],
    });

    expect(Object.keys(profile.objectiveWeights).some((id) => id.includes("violin"))).toBe(true);
    expect(Object.keys(state.needs).some((id) => id.includes("violin"))).toBe(true);
  });

  it("enforces citation presence with real links in evidence findings", async () => {
    const evidenceModule = await importFromWorkspace<{
      buildEvidenceFindings: (input: {
        topics: Array<string | { query: string }>;
        fetchImpl?: typeof fetch;
      }) => Promise<
        Array<{
          references: Array<{ title: string; url: string }>;
          confidence: number;
        }>
      >;
    }>("autolife-evidence", "src", "agents", "evidence", "evidence-agent.ts");

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

    const findings = await evidenceModule.buildEvidenceFindings({
      topics: ["sleep quality"],
      fetchImpl: fetchMock,
    });

    expect(findings[0].references.length).toBeGreaterThan(0);
    expect(findings[0].references.every((ref) => ref.url.startsWith("https://"))).toBe(true);
    expect(findings[0].confidence).toBeGreaterThan(0.4);
  });

  it("checks forecast transparency requirements", async () => {
    const forecastModule = await importFromWorkspace<{
      buildForecast: (input: {
        state: {
          needs: Record<string, number>;
          affect: { frustration: number; distress: number; momentum: number };
          signals: string[];
          freshness: { capturedAt: number; ageMinutes: number; completeness: number };
        };
        horizonDays?: number;
        evidence?: Array<{ topicId: string; claim: string; confidence: number; references: unknown[] }>;
        intervention?: { id: string; objectiveIds: string[]; effort: "low" | "medium" | "high" };
      }) => {
        assumptions: string[];
        baseline: string;
        withIntervention: string;
        confidence: number;
      };
    }>("autolife-forecast", "src", "agents", "forecast", "forecast-agent.ts");

    const forecast = forecastModule.buildForecast({
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
    const orchestratorModule = await importFromWorkspace<{
      runOrchestrator: (params: {
        input: {
          agentId: string;
          messages: Array<{ role: "user" | "assistant"; text: string }>;
          now: number;
          stateFile: string;
          traceFile: string;
        };
        clients: {
          preference: () => Promise<unknown>;
          state: () => Promise<unknown>;
          evidence: () => Promise<unknown[]>;
          forecast: () => Promise<unknown>;
          intervention: () => Promise<{ selected: unknown; alternatives: unknown[] }>;
        };
      }) => Promise<{ decision: { shouldNudge: boolean; reason: string } }>;
    }>("autolife-orchestrator", "src", "orchestrator", "orchestrator.ts");

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autolife-qa-"));
    try {
      const stateFile = path.join(tmpDir, "state.json");
      const traceFile = path.join(tmpDir, "trace.jsonl");

      const result = await orchestratorModule.runOrchestrator({
        input: {
          agentId: "qa",
          messages: [{ role: "user", text: "Need help quickly" }],
          now: 5_000_000,
          stateFile,
          traceFile,
        },
        clients: {
          async preference() {
            return {
              objectiveWeights: { focus: 1 },
              interventionAffinity: {},
              toneBias: { supportive: 0.5, direct: 0.5 },
              confidence: 0.5,
            };
          },
          async state() {
            return {
              needs: { focus: 0.8 },
              affect: { frustration: 0.4, distress: 0.4, momentum: 0.4 },
              signals: ["qa"],
              freshness: { capturedAt: 5_000_000, ageMinutes: 0, completeness: 1 },
            };
          },
          async evidence() {
            return [];
          },
          async forecast() {
            return {
              horizonDays: 7,
              baseline: "",
              withIntervention: "",
              assumptions: [],
              confidence: 0.5,
            };
          },
          async intervention() {
            return {
              selected: {
                id: "dyn:bad:low",
                objectiveIds: ["focus"],
                action: "Use violence to force compliance.",
                rationale: "Unsafe by design",
                expectedImpact: "",
                effort: "low",
                followUpMinutes: 60,
                evidence: [],
              },
              alternatives: [],
            };
          },
        },
      });

      expect(result.decision.shouldNudge).toBe(false);
      expect(result.decision.reason.toLowerCase()).toContain("safety");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
