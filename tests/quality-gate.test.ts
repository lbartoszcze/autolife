import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLifeCoachHeartbeatPlan } from "../src/infra/life-coach.js";
import type { LifeCoachConfig } from "../src/infra/life-coach.js";

function buildSessionLine(params: { role: "user" | "assistant"; text: string; timestamp?: number }) {
  return JSON.stringify({
    type: "message",
    timestamp: params.timestamp ?? Date.now(),
    message: {
      role: params.role,
      timestamp: params.timestamp ?? Date.now(),
      content: [{ type: "text", text: params.text }],
    },
  });
}

describe("qa quality gate", () => {
  let tmpDir: string;
  let previousStateDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autolife-qa-gate-"));
    previousStateDir = process.env.AUTLIFE_STATE_DIR;
    process.env.AUTLIFE_STATE_DIR = tmpDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (previousStateDir === undefined) {
      delete process.env.AUTLIFE_STATE_DIR;
    } else {
      process.env.AUTLIFE_STATE_DIR = previousStateDir;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("keeps intervention generation dynamic for unseen objective language", async () => {
    const sessionFile = path.join(tmpDir, "dynamic-objective.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        buildSessionLine({
          role: "user",
          text: "I keep postponing ultramarathon training plans and lose momentum",
        }),
        buildSessionLine({
          role: "user",
          text: "need a concrete way to start ultramarathon work this week",
        }),
      ].join("\n"),
      "utf-8",
    );

    const plan = await createLifeCoachHeartbeatPlan({
      cfg: {
        agents: { defaults: { workspace: tmpDir } },
      } as LifeCoachConfig,
      agentId: "main",
      basePrompt: "Base prompt",
      sessionEntry: { sessionFile },
      lifeCoach: { enabled: true, science: { enabled: true, mode: "dynamic" } },
    });

    expect(plan.decision).toBeDefined();
    expect(plan.decision?.intervention.startsWith("dyn:")).toBe(true);
    expect(plan.prompt.toLowerCase()).toContain("ultramarathon");
  });

  it("requires citation presence and forecast transparency for evidence-backed output", async () => {
    const catalog = [
      {
        id: "sleep-risk",
        keywords: ["sleep", "insomnia", "fatigue"],
        confidenceBias: 0.4,
        minConfidence: 0.35,
        recommendedIntervention: "dyn:sleep:micro-step",
        trajectoryForecast: "If sleep debt persists, daytime concentration is likely to degrade over the next month.",
        improvementForecast: "If sleep regularity improves this week, daytime alertness should improve over 10-14 days.",
        recommendedAction: "Set one fixed wake-up time for the next 7 days and track completion daily.",
        references: [
          {
            title: "Sleep meta-analysis",
            url: "https://pubmed.ncbi.nlm.nih.gov/12345678/",
          },
        ],
      },
    ];
    await fs.writeFile(path.join(tmpDir, "SCIENCE_TOPICS.json"), JSON.stringify(catalog, null, 2), "utf-8");

    const sessionFile = path.join(tmpDir, "science-citations.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        buildSessionLine({ role: "user", text: "insomnia and fatigue are getting worse" }),
        buildSessionLine({ role: "user", text: "sleep quality dropped and I cannot focus" }),
      ].join("\n"),
      "utf-8",
    );

    const plan = await createLifeCoachHeartbeatPlan({
      cfg: {
        agents: { defaults: { workspace: tmpDir } },
      } as LifeCoachConfig,
      agentId: "main",
      basePrompt: "Base prompt",
      sessionEntry: { sessionFile },
      lifeCoach: { enabled: true, science: { enabled: true, mode: "catalog" } },
    });

    expect(plan.prompt).toContain("[AUTOLIFE SCIENCE]");
    expect(plan.prompt).toContain("Trajectory forecast:");
    expect(plan.prompt).toContain("Improvement forecast:");
    expect(plan.prompt).toContain("https://pubmed.ncbi.nlm.nih.gov/12345678/");
  });

  it("blocks unsafe recommendation patterns in generated actions", async () => {
    const sessionFile = path.join(tmpDir, "unsafe-guard.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        buildSessionLine({
          role: "user",
          text: "I am desperate and someone told me to double my medication dose",
        }),
        buildSessionLine({
          role: "user",
          text: "what should I do tonight to stabilize",
        }),
      ].join("\n"),
      "utf-8",
    );

    const plan = await createLifeCoachHeartbeatPlan({
      cfg: {
        agents: { defaults: { workspace: tmpDir } },
      } as LifeCoachConfig,
      agentId: "main",
      basePrompt: "Base prompt",
      sessionEntry: { sessionFile },
      lifeCoach: { enabled: true, science: { enabled: true, mode: "dynamic" } },
    });

    const action = plan.decision?.action.toLowerCase() ?? "";
    expect(action.includes("double your dose")).toBe(false);
    expect(action.includes("stop your medication")).toBe(false);
    expect(action.includes("self-harm")).toBe(false);
    expect(plan.prompt).toContain("clinician guidance");
  });
});
