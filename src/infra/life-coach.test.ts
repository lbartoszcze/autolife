import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __lifeCoachTestUtils, createLifeCoachHeartbeatPlan } from "./life-coach.js";

describe("orchestrator life-coach wrapper", () => {
  let tmpDir: string;
  let previousStateDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autolife-orchestrator-"));
    previousStateDir = process.env.AUTLIFE_STATE_DIR;
    process.env.AUTLIFE_STATE_DIR = tmpDir;
  });

  afterEach(async () => {
    if (previousStateDir === undefined) {
      delete process.env.AUTLIFE_STATE_DIR;
    } else {
      process.env.AUTLIFE_STATE_DIR = previousStateDir;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("parses message json lines", () => {
    const parsed = __lifeCoachTestUtils.parseMessageLine(
      JSON.stringify({ role: "user", text: "Need help focusing", timestamp: 1 }),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].role).toBe("user");
  });

  it("builds orchestrator heartbeat plan", async () => {
    const sessionFile = path.join(tmpDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        JSON.stringify({ role: "user", text: "I am overwhelmed and stuck", timestamp: Date.now() - 10_000 }),
        JSON.stringify({ role: "user", text: "sleep has been poor", timestamp: Date.now() - 5_000 }),
      ].join("\n"),
      "utf-8",
    );

    const plan = await createLifeCoachHeartbeatPlan({
      cfg: {
        agents: {
          defaults: {
            workspace: tmpDir,
          },
        },
      },
      agentId: "main",
      basePrompt: "Base prompt",
      sessionEntry: { sessionFile, sessionId: "sid" },
      lifeCoach: { enabled: true, cooldownMinutes: 30, maxNudgesPerDay: 4 },
    });

    expect(plan.prompt).toContain("[AUTOLIFE ORCHESTRATOR]");
    expect(plan.prompt).toContain("traceId=");
    if (plan.decision) {
      expect(plan.decision.intervention.length).toBeGreaterThan(0);
      expect(plan.decision.followUpMinutes).toBeGreaterThan(0);
    }
  });
});
