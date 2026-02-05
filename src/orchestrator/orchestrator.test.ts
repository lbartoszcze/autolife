import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentBundle } from "./orchestrator.js";
import { createLocalAgentBundle } from "./local-agents.js";
import { orchestrateDecision } from "./orchestrator.js";

const NOW = Date.UTC(2026, 1, 5, 12, 0, 0);
const MESSAGES = [
  { role: "user" as const, text: "I am overwhelmed and stuck with focus", timestamp: NOW - 10 * 60_000 },
  { role: "user" as const, text: "sleep has been poor all week", timestamp: NOW - 5 * 60_000 },
];

describe("orchestrator", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "autolife-orchestrator-tests-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it("produces deterministic trace ids for identical inputs", async () => {
    const bundle = createLocalAgentBundle();
    const oneDir = path.join(tmpRoot, "run-a");
    const twoDir = path.join(tmpRoot, "run-b");

    const runA = await orchestrateDecision({
      agentId: "main",
      messages: MESSAGES,
      agents: bundle,
      nowMs: NOW,
      cooldownMinutes: 0,
      stateDir: oneDir,
    });
    const runB = await orchestrateDecision({
      agentId: "main",
      messages: MESSAGES,
      agents: bundle,
      nowMs: NOW,
      cooldownMinutes: 0,
      stateDir: twoDir,
    });

    expect(runA.traceId).toBe(runB.traceId);
  });

  it("blocks nudges when cooldown is active", async () => {
    const bundle = createLocalAgentBundle();
    const stateDir = path.join(tmpRoot, "cooldown");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "orchestrator-state.json"),
      JSON.stringify(
        {
          lastDispatchByAgent: { main: NOW - 30 * 60_000 },
          dailyDispatchByAgent: { main: { date: "2026-02-05", count: 1 } },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const second = await orchestrateDecision({
      agentId: "main",
      messages: MESSAGES,
      agents: bundle,
      nowMs: NOW + 30 * 60_000,
      cooldownMinutes: 120,
      stateDir,
    });

    expect(second.shouldNudge).toBe(false);
    expect(second.reason.toLowerCase()).toContain("cooldown");
  });

  it("blocks unsafe recommendations", async () => {
    const base = createLocalAgentBundle();
    const unsafeBundle: AgentBundle = {
      ...base,
      intervention: {
        synthesize: async () => ({
          selected: {
            id: "dyn:unsafe:1",
            objectiveIds: ["focus"],
            action: "Self-harm to reset behavior.",
            rationale: "unsafe",
            expectedImpact: "unsafe",
            effort: "low",
            followUpMinutes: 30,
            evidence: [],
          },
          alternatives: [],
        }),
      },
    };

    const decision = await orchestrateDecision({
      agentId: "main",
      messages: MESSAGES,
      agents: unsafeBundle,
      nowMs: NOW,
      cooldownMinutes: 0,
      stateDir: path.join(tmpRoot, "unsafe"),
    });

    expect(decision.shouldNudge).toBe(false);
    expect(decision.reason.toLowerCase()).toContain("safety");
  });

  it("calls every agent bundle function once", async () => {
    const preference = vi.fn(async () => ({
      objectiveWeights: { focus: 0.6 },
      interventionAffinity: {},
      toneBias: { supportive: 0.6, direct: 0.4 },
      confidence: 0.7,
    }));
    const state = vi.fn(async () => ({
      needs: { focus: 0.8 },
      affect: { frustration: 0.6, distress: 0.5, momentum: 0.4 },
      signals: ["focus blocked"],
      freshness: { capturedAt: NOW, ageMinutes: 0, completeness: 0.8 },
    }));
    const evidence = vi.fn(async () => [
      {
        topicId: "focus",
        claim: "evidence",
        confidence: 0.7,
        references: [
          {
            title: "Paper",
            url: "https://pubmed.ncbi.nlm.nih.gov/12345678/",
            sourceType: "paper" as const,
          },
        ],
      },
    ]);
    const forecast = vi.fn(async () => ({
      horizonDays: 14,
      baseline: "baseline",
      withIntervention: "with",
      assumptions: ["a"],
      confidence: 0.65,
    }));
    const intervention = vi.fn(async () => ({
      selected: {
        id: "dyn:focus:1",
        objectiveIds: ["focus"],
        action: "Run one 10-minute block and log done.",
        rationale: "state+evidence",
        expectedImpact: "improved focus",
        effort: "low" as const,
        followUpMinutes: 45,
        evidence: [],
      },
      alternatives: [],
    }));

    const bundle: AgentBundle = {
      preference: { inferProfile: preference },
      state: { assess: state },
      evidence: { find: evidence },
      forecast: { project: forecast },
      intervention: { synthesize: intervention },
    };

    await orchestrateDecision({
      agentId: "main",
      messages: MESSAGES,
      agents: bundle,
      nowMs: NOW,
      cooldownMinutes: 0,
      stateDir: path.join(tmpRoot, "call-counts"),
    });

    expect(preference).toHaveBeenCalledTimes(1);
    expect(state).toHaveBeenCalledTimes(1);
    expect(evidence).toHaveBeenCalledTimes(1);
    expect(forecast).toHaveBeenCalledTimes(1);
    expect(intervention).toHaveBeenCalledTimes(1);
  });
});
