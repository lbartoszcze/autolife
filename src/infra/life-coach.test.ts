import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { __lifeCoachTestUtils, createLifeCoachHeartbeatPlan, recordLifeCoachDispatch } from "./life-coach.js";

const BASE_CFG = {} as OpenClawConfig;

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

describe("life-coach", () => {
  let tmpDir: string;
  let prevStateDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-life-coach-"));
    prevStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;
  });

  afterEach(async () => {
    if (prevStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = prevStateDir;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("estimates high social-media and focus need from doomscroll context", async () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        buildSessionLine({
          role: "user",
          text: "I keep doomscrolling Instagram and cannot focus on work",
        }),
        buildSessionLine({
          role: "user",
          text: "Still scrolling social media and procrastinating",
        }),
      ].join("\n"),
      "utf-8",
    );

    const plan = await createLifeCoachHeartbeatPlan({
      cfg: BASE_CFG,
      agentId: "main",
      basePrompt: "Base prompt",
      sessionEntry: {
        sessionId: "sid",
        updatedAt: Date.now(),
        sessionFile,
      },
      lifeCoach: { enabled: true },
    });

    expect(plan.prompt).toContain("[AUTOLIFE LIFECOACH]");
    expect(plan.decision).toBeDefined();
    expect(plan.decision?.intervention).toBe("social-block");
    expect(plan.decision?.needs.socialMediaReduction).toBeGreaterThan(0.5);
    expect(plan.decision?.needs.focus).toBeGreaterThan(0.45);
  });

  it("respects cooldown between nudges", async () => {
    const nowMs = 100_000;
    const planA = await createLifeCoachHeartbeatPlan({
      cfg: BASE_CFG,
      agentId: "main",
      basePrompt: "Base prompt",
      lifeCoach: { enabled: true, cooldownMinutes: 60 },
      nowMs,
    });
    expect(planA.decision).toBeDefined();

    await recordLifeCoachDispatch({
      agentId: "main",
      decision: planA.decision,
      nowMs,
    });

    const planB = await createLifeCoachHeartbeatPlan({
      cfg: BASE_CFG,
      agentId: "main",
      basePrompt: "Base prompt",
      lifeCoach: { enabled: true, cooldownMinutes: 60 },
      nowMs: nowMs + 15 * 60_000,
    });

    expect(planB.decision).toBeUndefined();
    expect(planB.prompt).toContain("cooldown active");
  });

  it("updates completion stats from user follow-up messages", async () => {
    const sentAt = 500_000;
    const firstPlan = await createLifeCoachHeartbeatPlan({
      cfg: BASE_CFG,
      agentId: "main",
      basePrompt: "Base prompt",
      lifeCoach: { enabled: true },
      nowMs: sentAt,
    });
    expect(firstPlan.decision).toBeDefined();

    await recordLifeCoachDispatch({
      agentId: "main",
      decision: firstPlan.decision,
      nowMs: sentAt,
    });

    const sessionFile = path.join(tmpDir, "session-followup.jsonl");
    await fs.writeFile(
      sessionFile,
      buildSessionLine({
        role: "user",
        text: "done, i did it and feel better now",
        timestamp: sentAt + 5 * 60_000,
      }),
      "utf-8",
    );

    await createLifeCoachHeartbeatPlan({
      cfg: BASE_CFG,
      agentId: "main",
      basePrompt: "Base prompt",
      sessionEntry: {
        sessionId: "sid",
        updatedAt: sentAt + 6 * 60_000,
        sessionFile,
      },
      lifeCoach: { enabled: true, cooldownMinutes: 1 },
      nowMs: sentAt + 6 * 60_000,
    });

    const statePath = path.join(tmpDir, "agents", "main", "life-coach-state.json");
    const stateRaw = await fs.readFile(statePath, "utf-8");
    const state = __lifeCoachTestUtils.normalizeStateFile(
      JSON.parse(stateRaw) as unknown,
      sentAt + 6 * 60_000,
    );
    const interventionId = firstPlan.decision?.intervention;
    expect(interventionId).toBeDefined();
    if (!interventionId) {
      return;
    }
    expect(state.stats[interventionId].completed).toBeGreaterThanOrEqual(1);
  });

  it("generates one due follow-up and records follow-up send on pending intervention", async () => {
    const initialNow = 1_000_000;
    const initialPlan = await createLifeCoachHeartbeatPlan({
      cfg: BASE_CFG,
      agentId: "main",
      basePrompt: "Base prompt",
      lifeCoach: { enabled: true, cooldownMinutes: 180 },
      nowMs: initialNow,
    });
    expect(initialPlan.decision).toBeDefined();
    if (!initialPlan.decision) {
      return;
    }
    expect(initialPlan.decision.phase).toBe("initial");

    await recordLifeCoachDispatch({
      agentId: "main",
      decision: initialPlan.decision,
      nowMs: initialNow,
    });

    const followUpNow = initialNow + (initialPlan.decision.followUpMinutes + 1) * 60_000;
    const followUpPlan = await createLifeCoachHeartbeatPlan({
      cfg: BASE_CFG,
      agentId: "main",
      basePrompt: "Base prompt",
      lifeCoach: { enabled: true, cooldownMinutes: 180 },
      nowMs: followUpNow,
    });
    expect(followUpPlan.decision).toBeDefined();
    expect(followUpPlan.decision?.phase).toBe("follow-up");
    expect(followUpPlan.decision?.intervention).toBe(initialPlan.decision.intervention);

    if (!followUpPlan.decision) {
      return;
    }
    await recordLifeCoachDispatch({
      agentId: "main",
      decision: followUpPlan.decision,
      nowMs: followUpNow,
    });

    const statePath = path.join(tmpDir, "agents", "main", "life-coach-state.json");
    const stateRaw = await fs.readFile(statePath, "utf-8");
    const state = __lifeCoachTestUtils.normalizeStateFile(
      JSON.parse(stateRaw) as unknown,
      followUpNow,
    );
    const pending = state.history.find(
      (entry) =>
        entry.intervention === initialPlan.decision?.intervention && entry.status === "sent",
    );
    expect(pending).toBeDefined();
    expect(typeof pending?.followUpSentAt).toBe("number");
    expect(state.history.length).toBe(1);
  });

  it("includes configurable action-contract tokens in generated prompts", async () => {
    const sessionFile = path.join(tmpDir, "session-contract.jsonl");
    await fs.writeFile(
      sessionFile,
      buildSessionLine({
        role: "user",
        text: "i am distracted by social media and cannot focus",
      }),
      "utf-8",
    );

    const plan = await createLifeCoachHeartbeatPlan({
      cfg: BASE_CFG,
      agentId: "main",
      basePrompt: "Base prompt",
      sessionEntry: {
        sessionId: "sid",
        updatedAt: Date.now(),
        sessionFile,
      },
      lifeCoach: {
        enabled: true,
        actionContract: {
          enabled: true,
          doneToken: "ALL_DONE",
          helpToken: "STUCK_HELP",
        },
      },
    });

    expect(plan.decision).toBeDefined();
    expect(plan.prompt).toContain('Action contract: ask user to reply exactly "ALL_DONE"');
    expect(plan.prompt).toContain('"STUCK_HELP"');
  });

  it("computes relapse pressure from ignored/rejected social outcomes", () => {
    const normalized = __lifeCoachTestUtils.normalizeStateFile(
      {
        version: 1,
        updatedAt: Date.now(),
        history: [
          {
            id: "a",
            intervention: "social-block",
            sentAt: 1,
            status: "ignored",
            followUpMinutes: 30,
          },
          {
            id: "b",
            intervention: "focus-sprint",
            sentAt: 2,
            status: "rejected",
            followUpMinutes: 30,
          },
          {
            id: "c",
            intervention: "walk",
            sentAt: 3,
            status: "ignored",
            followUpMinutes: 30,
          },
        ],
      },
      Date.now(),
    );
    const pressure = __lifeCoachTestUtils.computeRelapsePressure(normalized);
    expect(pressure).toBeGreaterThan(0);
    expect(pressure).toBeLessThanOrEqual(1);
  });
});
