import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OrchestratorAgentClients } from "./orchestrator.js";
import { runOrchestrator } from "./orchestrator.js";

function buildClients(selectedAction: string): OrchestratorAgentClients {
  return {
    async preference() {
      return {
        objectiveWeights: { focus: 0.7, sleep: 0.3 },
        interventionAffinity: {},
        toneBias: { supportive: 0.4, direct: 0.6 },
        confidence: 0.7,
      };
    },
    async state() {
      return {
        needs: { focus: 0.82 },
        affect: { frustration: 0.6, distress: 0.55, momentum: 0.3 },
        signals: ["transcript"],
        freshness: {
          capturedAt: Date.now(),
          ageMinutes: 10,
          completeness: 0.8,
        },
      };
    },
    async evidence() {
      return [
        {
          topicId: "focus",
          claim: "focus interventions help",
          confidence: 0.72,
          references: [
            {
              title: "Review",
              url: "https://example.org/review",
              sourceType: "review" as const,
            },
          ],
        },
      ];
    },
    async forecast() {
      return {
        horizonDays: 7,
        baseline: "baseline",
        withIntervention: "adjusted",
        assumptions: ["assume adherence"],
        confidence: 0.66,
      };
    },
    async intervention() {
      return {
        selected: {
          id: "dyn:focus:low",
          objectiveIds: ["focus"],
          action: selectedAction,
          rationale: "ranked first",
          expectedImpact: "impact",
          effort: "low" as const,
          followUpMinutes: 90,
          evidence: [],
        },
        alternatives: [],
        ranked: [],
      };
    },
  };
}

describe("orchestrator", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autolife-orchestrator-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("selects a safe intervention and records a deterministic trace", async () => {
    const stateFile = path.join(tmpDir, "state.json");
    const traceFile = path.join(tmpDir, "trace.jsonl");

    const { decision, trace } = await runOrchestrator({
      input: {
        agentId: "main",
        messages: [{ role: "user", text: "I cannot focus" }],
        now: 1_000_000,
        stateFile,
        traceFile,
      },
      clients: buildClients("Run one 15-minute focus sprint now."),
    });

    expect(decision.shouldNudge).toBe(true);
    expect(decision.selected?.id).toBe("dyn:focus:low");
    expect(decision.traceId).toHaveLength(16);
    expect(trace.reason).toContain("Selected");

    const traceRows = (await fs.readFile(traceFile, "utf-8")).trim().split("\n");
    expect(traceRows).toHaveLength(1);
  });

  it("blocks nudges during cooldown window", async () => {
    const stateFile = path.join(tmpDir, "state.json");
    const traceFile = path.join(tmpDir, "trace.jsonl");

    await runOrchestrator({
      input: {
        agentId: "main",
        messages: [{ role: "user", text: "I cannot focus" }],
        now: 1_000_000,
        cooldownMinutes: 120,
        stateFile,
        traceFile,
      },
      clients: buildClients("Run one 15-minute focus sprint now."),
    });

    const second = await runOrchestrator({
      input: {
        agentId: "main",
        messages: [{ role: "user", text: "Still distracted" }],
        now: 1_000_000 + 30 * 60_000,
        cooldownMinutes: 120,
        stateFile,
        traceFile,
      },
      clients: buildClients("Run one 15-minute focus sprint now."),
    });

    expect(second.decision.shouldNudge).toBe(false);
    expect(second.decision.reason).toContain("cooldown");
  });

  it("blocks unsafe recommendations", async () => {
    const stateFile = path.join(tmpDir, "state.json");
    const traceFile = path.join(tmpDir, "trace.jsonl");

    const { decision } = await runOrchestrator({
      input: {
        agentId: "main",
        messages: [{ role: "user", text: "Need help" }],
        now: 2_000_000,
        stateFile,
        traceFile,
      },
      clients: buildClients("Use violence to force task completion."),
    });

    expect(decision.shouldNudge).toBe(false);
    expect(decision.reason).toContain("safety");
  });
});
