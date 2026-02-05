import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

async function writeScienceCatalog(params: { dir: string; topics: unknown[] }) {
  await fs.writeFile(
    path.join(params.dir, "SCIENCE_TOPICS.json"),
    JSON.stringify(params.topics, null, 2),
    "utf-8",
  );
}

const SMOKING_TOPIC = {
  id: "smoking",
  keywords: ["smoke", "smoking", "cigarette", "cigarettes", "nicotine", "vape", "vaping", "tobacco"],
  objectiveWeights: { stressRegulation: 0.2, focus: 0.1 },
  confidenceBias: 0.25,
  minConfidence: 0.35,
  recommendedIntervention: "dyn:stressRegulation:friction",
  trajectoryForecast:
    "If smoking remains daily, long-term cohort evidence suggests roughly 7-10 years lower life expectancy on average.",
  improvementForecast:
    "If you start a structured quit plan now, cessation probability increases substantially and long-term excess mortality drops over time.",
  recommendedAction:
    "Set a quit date in the next 7 days, remove smoking cues today, and ask a clinician about first-line cessation medication plus support.",
  references: [
    {
      title: "Jha et al. (2013) 21st-Century Hazards of Smoking and Benefits of Cessation",
      url: "https://pubmed.ncbi.nlm.nih.gov/23343063/",
    },
    {
      title: "Cahill et al. (2016) Nicotine receptor partial agonists for smoking cessation",
      url: "https://pubmed.ncbi.nlm.nih.gov/27158893/",
    },
  ],
  forceInterventionAtConfidence: 0.55,
} as const;

describe("life-coach", () => {
  let tmpDir: string;
  let prevStateDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-life-coach-"));
    prevStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
      lifeCoach: { enabled: true, science: { enabled: true, mode: "catalog" } },
    });

    expect(plan.prompt).toContain("[AUTOLIFE LIFECOACH]");
    expect(plan.decision).toBeDefined();
    expect(plan.decision?.intervention).toContain("dyn:");
    const needValues = Object.values(plan.decision?.needs ?? {});
    expect(needValues.length).toBeGreaterThan(0);
    expect(Math.max(...needValues)).toBeGreaterThan(0.45);
  });

  it("injects science forecast and paper links for smoking risk", async () => {
    await writeScienceCatalog({ dir: tmpDir, topics: [SMOKING_TOPIC] });
    const sessionFile = path.join(tmpDir, "session-smoking-science.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        buildSessionLine({
          role: "user",
          text: "I keep smoking cigarettes every day and want to quit but i keep relapsing",
        }),
        buildSessionLine({
          role: "user",
          text: "nicotine cravings are strong and this is stressing me out",
        }),
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
      } as OpenClawConfig,
      agentId: "main",
      basePrompt: "Base prompt",
      sessionEntry: {
        sessionId: "sid",
        updatedAt: Date.now(),
        sessionFile,
      },
      lifeCoach: { enabled: true, science: { enabled: true, mode: "catalog" } },
    });

    expect(plan.prompt).toContain("[AUTOLIFE SCIENCE]");
    expect(plan.prompt).toContain("Detected risk: smoking");
    expect(plan.prompt).toContain("7-10 years lower life expectancy");
    expect(plan.prompt).toContain("https://pubmed.ncbi.nlm.nih.gov/23343063/");
    expect(plan.prompt).toContain("https://pubmed.ncbi.nlm.nih.gov/27158893/");
  });

  it("prioritizes science-recommended intervention when smoking risk confidence is high", async () => {
    await writeScienceCatalog({ dir: tmpDir, topics: [SMOKING_TOPIC] });
    const sessionFile = path.join(tmpDir, "session-smoking-priority.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        buildSessionLine({
          role: "user",
          text: "I smoke every day, I need to quit smoking now, cigarettes are hurting me",
        }),
        buildSessionLine({
          role: "user",
          text: "I vape and smoke, nicotine cravings are constant, please help me stop",
        }),
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
      } as OpenClawConfig,
      agentId: "main",
      basePrompt: "Base prompt",
      sessionEntry: {
        sessionId: "sid",
        updatedAt: Date.now(),
        sessionFile,
      },
      lifeCoach: { enabled: true, science: { enabled: true, mode: "catalog" } },
    });

    expect(plan.decision).toBeDefined();
    expect(plan.decision?.intervention).toBe(SMOKING_TOPIC.recommendedIntervention);
    expect(plan.decision?.scienceInsight?.riskId).toBe("smoking");
  });

  it("loads custom science topics dynamically from workspace catalog", async () => {
    await writeScienceCatalog({
      dir: tmpDir,
      topics: [
        {
          id: "gaming-binge",
          keywords: ["gaming", "league", "ranked"],
          objectiveWeights: { focus: 0.4, mood: 0.2 },
          confidenceBias: 0.2,
          minConfidence: 0.3,
          recommendedIntervention: "dyn:focus:activation",
          trajectoryForecast: "If late-night gaming keeps expanding, next-day focus and sleep stability may decline.",
          improvementForecast:
            "Time-boxed gaming windows plus startup sprints can restore task initiation consistency.",
          recommendedAction:
            "Set a hard gaming cutoff tonight and run one 20-minute focus sprint before opening games.",
          references: [
            {
              title: "Sample behavior trial",
              url: "https://example.org/gaming-study",
            },
          ],
          forceInterventionAtConfidence: 0.5,
        },
      ],
    });

    const sessionFile = path.join(tmpDir, "session-custom-science.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        buildSessionLine({
          role: "user",
          text: "I keep gaming ranked at night and can't focus in the morning",
        }),
        buildSessionLine({
          role: "user",
          text: "league queue gets me stuck and procrastinating",
        }),
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
      } as OpenClawConfig,
      agentId: "main",
      basePrompt: "Base prompt",
      sessionEntry: {
        sessionId: "sid",
        updatedAt: Date.now(),
        sessionFile,
      },
      lifeCoach: { enabled: true, science: { enabled: true, mode: "catalog" } },
    });

    expect(plan.decision).toBeDefined();
    expect(plan.decision?.scienceInsight?.riskId).toBe("gaming-binge");
    expect(plan.prompt).toContain("Detected risk: gaming-binge");
    expect(plan.prompt).toContain("https://example.org/gaming-study");
  });

  it("discovers science evidence dynamically without any catalog file", async () => {
    const searchPayload = {
      esearchresult: {
        idlist: ["11111111", "22222222"],
      },
    };
    const summaryPayload = {
      result: {
        "11111111": { uid: "11111111", title: "Behavior intervention trial A", pubdate: "2021 Jan" },
        "22222222": { uid: "22222222", title: "Behavior intervention trial B", pubdate: "2023 Mar" },
      },
    };
    const fetchMock = vi.fn().mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("esearch.fcgi")) {
        return {
          ok: true,
          json: async () => searchPayload,
        };
      }
      if (url.includes("esummary.fcgi")) {
        return {
          ok: true,
          json: async () => summaryPayload,
        };
      }
      return {
        ok: false,
        json: async () => ({}),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const sessionFile = path.join(tmpDir, "session-dynamic-science.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        buildSessionLine({
          role: "user",
          text: "I keep doomscrolling and procrastinating and this pattern is wrecking my focus",
        }),
        buildSessionLine({
          role: "user",
          text: "I need behavior change support and a practical intervention plan",
        }),
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
      } as OpenClawConfig,
      agentId: "main",
      basePrompt: "Base prompt",
      sessionEntry: {
        sessionId: "sid",
        updatedAt: Date.now(),
        sessionFile,
      },
      lifeCoach: { enabled: true, science: { enabled: true, mode: "dynamic" } },
    });

    expect(plan.prompt).toContain("[AUTOLIFE SCIENCE]");
    expect(plan.prompt).toContain("Detected risk:");
    expect(plan.prompt).toContain("https://pubmed.ncbi.nlm.nih.gov/11111111/");
    expect(fetchMock).toHaveBeenCalled();
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

  it("learns intervention affinity from outcomes and explicit user preference text", async () => {
    const sentAt = 300_000;
    const initialPlan = await createLifeCoachHeartbeatPlan({
      cfg: BASE_CFG,
      agentId: "main",
      basePrompt: "Base prompt",
      lifeCoach: { enabled: true },
      nowMs: sentAt,
    });
    expect(initialPlan.decision).toBeDefined();
    if (!initialPlan.decision) {
      return;
    }

    await recordLifeCoachDispatch({
      agentId: "main",
      decision: initialPlan.decision,
      nowMs: sentAt,
    });

    const sessionFile = path.join(tmpDir, "session-preferences.jsonl");
    await fs.writeFile(
      sessionFile,
      buildSessionLine({
        role: "user",
        text: "done, this intervention helped and i prefer this kind of nudge",
        timestamp: sentAt + 120_000,
      }),
      "utf-8",
    );

    await createLifeCoachHeartbeatPlan({
      cfg: BASE_CFG,
      agentId: "main",
      basePrompt: "Base prompt",
      sessionEntry: {
        sessionId: "sid",
        updatedAt: sentAt + 180_000,
        sessionFile,
      },
      lifeCoach: { enabled: true, cooldownMinutes: 1 },
      nowMs: sentAt + 180_000,
    });

    const statePath = path.join(tmpDir, "agents", "main", "life-coach-state.json");
    const stateRaw = await fs.readFile(statePath, "utf-8");
    const state = __lifeCoachTestUtils.normalizeStateFile(
      JSON.parse(stateRaw) as unknown,
      sentAt + 180_000,
    );

    expect(state.preferences.interventionAffinity[initialPlan.decision.intervention]).toBeGreaterThan(0);
    expect(state.preferences.lastLearnedMessageTs).toBeGreaterThan(0);
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

  it("uses supportive tone under high frustration and includes affect/evidence/tool guidance", async () => {
    const sessionFile = path.join(tmpDir, "session-frustration.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        buildSessionLine({
          role: "user",
          text: "this is frustrating and annoying, i feel overwhelmed and anxious",
        }),
        buildSessionLine({
          role: "user",
          text: "i cannot focus, i am exhausted and burned out",
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

    expect(plan.decision).toBeDefined();
    expect(plan.decision?.tone).toBe("supportive");
    expect(plan.decision?.affect.frustration).toBeGreaterThan(0.45);
    expect(plan.prompt).toContain("Affect estimate (0..1)");
    expect(plan.prompt).toContain("Evidence note:");
    expect(plan.prompt).toContain("Tool execution hint:");
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

  it("uses custom action-contract tokens in follow-up phrasing", async () => {
    const sessionFile = path.join(tmpDir, "session-followup-contract.jsonl");
    await fs.writeFile(
      sessionFile,
      buildSessionLine({
        role: "user",
        text: "i keep doomscrolling instagram and cannot focus",
      }),
      "utf-8",
    );

    const initialAt = 900_000;
    const config = {
      enabled: true,
      cooldownMinutes: 180,
      actionContract: { enabled: true, doneToken: "ALL_DONE", helpToken: "STUCK_HELP" },
    } as const;

    const initialPlan = await createLifeCoachHeartbeatPlan({
      cfg: BASE_CFG,
      agentId: "main",
      basePrompt: "Base prompt",
      sessionEntry: {
        sessionId: "sid",
        updatedAt: initialAt,
        sessionFile,
      },
      lifeCoach: config,
      nowMs: initialAt,
    });
    expect(initialPlan.decision).toBeDefined();
    if (!initialPlan.decision) {
      return;
    }

    await recordLifeCoachDispatch({
      agentId: "main",
      decision: initialPlan.decision,
      nowMs: initialAt,
    });

    const followUpAt = initialAt + (initialPlan.decision.followUpMinutes + 1) * 60_000;
    const followUpPlan = await createLifeCoachHeartbeatPlan({
      cfg: BASE_CFG,
      agentId: "main",
      basePrompt: "Base prompt",
      sessionEntry: {
        sessionId: "sid",
        updatedAt: followUpAt,
        sessionFile,
      },
      lifeCoach: config,
      nowMs: followUpAt,
    });

    expect(followUpPlan.decision?.phase).toBe("follow-up");
    expect(followUpPlan.decision?.action).toContain("ALL_DONE");
    expect(followUpPlan.decision?.action).toContain("STUCK_HELP");
  });

  it("computes relapse pressure from ignored/rejected social outcomes", () => {
    const normalized = __lifeCoachTestUtils.normalizeStateFile(
      {
        version: 1,
        updatedAt: Date.now(),
        history: [
          {
            id: "a",
            intervention: "dyn:socialMediaReduction:friction",
            sentAt: 1,
            status: "ignored",
            followUpMinutes: 30,
          },
          {
            id: "b",
            intervention: "dyn:focus:activation",
            sentAt: 2,
            status: "rejected",
            followUpMinutes: 30,
          },
          {
            id: "c",
            intervention: "dyn:movement:activation",
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

  it("maps configured help token to blocked outcome", async () => {
    const sentAt = 200_000;
    const initialPlan = await createLifeCoachHeartbeatPlan({
      cfg: BASE_CFG,
      agentId: "main",
      basePrompt: "Base prompt",
      lifeCoach: {
        enabled: true,
        actionContract: { enabled: true, doneToken: "ALL_DONE", helpToken: "STUCK_HELP" },
      },
      nowMs: sentAt,
    });
    expect(initialPlan.decision).toBeDefined();
    if (!initialPlan.decision) {
      return;
    }

    await recordLifeCoachDispatch({
      agentId: "main",
      decision: initialPlan.decision,
      nowMs: sentAt,
    });

    const sessionFile = path.join(tmpDir, "session-help-token.jsonl");
    await fs.writeFile(
      sessionFile,
      buildSessionLine({
        role: "user",
        text: "STUCK_HELP",
        timestamp: sentAt + 60_000,
      }),
      "utf-8",
    );

    await createLifeCoachHeartbeatPlan({
      cfg: BASE_CFG,
      agentId: "main",
      basePrompt: "Base prompt",
      sessionEntry: {
        sessionId: "sid",
        updatedAt: sentAt + 70_000,
        sessionFile,
      },
      lifeCoach: {
        enabled: true,
        actionContract: { enabled: true, doneToken: "ALL_DONE", helpToken: "STUCK_HELP" },
      },
      nowMs: sentAt + 70_000,
    });

    const statePath = path.join(tmpDir, "agents", "main", "life-coach-state.json");
    const stateRaw = await fs.readFile(statePath, "utf-8");
    const state = __lifeCoachTestUtils.normalizeStateFile(
      JSON.parse(stateRaw) as unknown,
      sentAt + 70_000,
    );
    expect(state.stats[initialPlan.decision.intervention].rejected).toBeGreaterThanOrEqual(1);
  });

  it("enforces daily nudge cap and allows nudges again after a full day", async () => {
    const config = {
      enabled: true,
      cooldownMinutes: 1,
      maxNudgesPerDay: 2,
    } as const;
    const firstAt = 1_000_000;
    const secondAt = firstAt + 2 * 60_000;
    const cappedAt = secondAt + 2 * 60_000;
    const nextDayAt = firstAt + 24 * 60 * 60_000 + 5 * 60_000;

    const firstPlan = await createLifeCoachHeartbeatPlan({
      cfg: BASE_CFG,
      agentId: "main",
      basePrompt: "Base prompt",
      lifeCoach: config,
      nowMs: firstAt,
    });
    expect(firstPlan.decision).toBeDefined();
    if (!firstPlan.decision) {
      return;
    }
    await recordLifeCoachDispatch({
      agentId: "main",
      decision: firstPlan.decision,
      nowMs: firstAt,
    });

    const secondPlan = await createLifeCoachHeartbeatPlan({
      cfg: BASE_CFG,
      agentId: "main",
      basePrompt: "Base prompt",
      lifeCoach: config,
      nowMs: secondAt,
    });
    expect(secondPlan.decision).toBeDefined();
    if (!secondPlan.decision) {
      return;
    }
    await recordLifeCoachDispatch({
      agentId: "main",
      decision: secondPlan.decision,
      nowMs: secondAt,
    });

    const cappedPlan = await createLifeCoachHeartbeatPlan({
      cfg: BASE_CFG,
      agentId: "main",
      basePrompt: "Base prompt",
      lifeCoach: config,
      nowMs: cappedAt,
    });
    expect(cappedPlan.decision).toBeUndefined();
    expect(cappedPlan.prompt).toContain("daily nudge cap reached (2)");

    const nextDayPlan = await createLifeCoachHeartbeatPlan({
      cfg: BASE_CFG,
      agentId: "main",
      basePrompt: "Base prompt",
      lifeCoach: config,
      nowMs: nextDayAt,
    });
    expect(nextDayPlan.decision).toBeDefined();
  });

  it("falls back to dynamic science insights in hybrid mode when catalog data is missing", async () => {
    const searchPayload = {
      esearchresult: {
        idlist: ["33333333", "44444444"],
      },
    };
    const summaryPayload = {
      result: {
        "33333333": { uid: "33333333", title: "Behavior trial C", pubdate: "2020 Apr" },
        "44444444": { uid: "44444444", title: "Behavior trial D", pubdate: "2022 Nov" },
      },
    };
    const fetchMock = vi.fn().mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("esearch.fcgi")) {
        return {
          ok: true,
          json: async () => searchPayload,
        };
      }
      if (url.includes("esummary.fcgi")) {
        return {
          ok: true,
          json: async () => summaryPayload,
        };
      }
      return {
        ok: false,
        json: async () => ({}),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const sessionFile = path.join(tmpDir, "session-hybrid-dynamic-fallback.jsonl");
    await fs.writeFile(
      sessionFile,
      [
        buildSessionLine({
          role: "user",
          text: "I keep doomscrolling, procrastinating, and cannot sustain focus",
        }),
        buildSessionLine({
          role: "user",
          text: "I need a behavior intervention plan that actually starts now",
        }),
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
      } as OpenClawConfig,
      agentId: "main",
      basePrompt: "Base prompt",
      sessionEntry: {
        sessionId: "sid",
        updatedAt: Date.now(),
        sessionFile,
      },
      lifeCoach: {
        enabled: true,
        science: {
          enabled: true,
          mode: "hybrid",
          catalogFile: ".autolife/does-not-exist.json",
        },
      },
    });

    expect(plan.prompt).toContain("[AUTOLIFE SCIENCE]");
    expect(plan.prompt).toContain("Detected risk:");
    expect(plan.prompt).toContain("https://pubmed.ncbi.nlm.nih.gov/33333333/");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("keeps life-coach state isolated by agent id", async () => {
    const initialAt = 2_000_000;
    const laterAt = initialAt + 15 * 60_000;
    const config = {
      enabled: true,
      cooldownMinutes: 120,
    } as const;

    const alphaInitial = await createLifeCoachHeartbeatPlan({
      cfg: BASE_CFG,
      agentId: "alpha",
      basePrompt: "Base prompt",
      lifeCoach: config,
      nowMs: initialAt,
    });
    expect(alphaInitial.decision).toBeDefined();
    if (!alphaInitial.decision) {
      return;
    }
    await recordLifeCoachDispatch({
      agentId: "alpha",
      decision: alphaInitial.decision,
      nowMs: initialAt,
    });

    const alphaDuringCooldown = await createLifeCoachHeartbeatPlan({
      cfg: BASE_CFG,
      agentId: "alpha",
      basePrompt: "Base prompt",
      lifeCoach: config,
      nowMs: laterAt,
    });
    expect(alphaDuringCooldown.decision).toBeUndefined();
    expect(alphaDuringCooldown.prompt).toContain("cooldown active");

    const betaPlan = await createLifeCoachHeartbeatPlan({
      cfg: BASE_CFG,
      agentId: "beta",
      basePrompt: "Base prompt",
      lifeCoach: config,
      nowMs: laterAt,
    });
    expect(betaPlan.decision).toBeDefined();
  });

  it("omits action-contract instructions when the action contract is disabled", async () => {
    const sessionFile = path.join(tmpDir, "session-action-contract-disabled.jsonl");
    await fs.writeFile(
      sessionFile,
      buildSessionLine({
        role: "user",
        text: "I keep scrolling social media instead of doing deep work",
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
          enabled: false,
        },
      },
    });

    expect(plan.decision).toBeDefined();
    expect(plan.prompt).not.toContain("Action contract:");
  });

  it("does not schedule follow-up nudges for interventions already marked completed", async () => {
    const initialAt = 3_000_000;
    const initialPlan = await createLifeCoachHeartbeatPlan({
      cfg: BASE_CFG,
      agentId: "main",
      basePrompt: "Base prompt",
      lifeCoach: { enabled: true },
      nowMs: initialAt,
    });
    expect(initialPlan.decision).toBeDefined();
    if (!initialPlan.decision) {
      return;
    }

    await recordLifeCoachDispatch({
      agentId: "main",
      decision: initialPlan.decision,
      nowMs: initialAt,
    });

    const completionFile = path.join(tmpDir, "session-completed-before-followup.jsonl");
    await fs.writeFile(
      completionFile,
      buildSessionLine({
        role: "user",
        text: "done, completed this and made progress",
        timestamp: initialAt + 60_000,
      }),
      "utf-8",
    );

    await createLifeCoachHeartbeatPlan({
      cfg: BASE_CFG,
      agentId: "main",
      basePrompt: "Base prompt",
      sessionEntry: {
        sessionId: "sid",
        updatedAt: initialAt + 120_000,
        sessionFile: completionFile,
      },
      lifeCoach: { enabled: true, cooldownMinutes: 1 },
      nowMs: initialAt + 120_000,
    });

    const dueAt = initialAt + (initialPlan.decision.followUpMinutes + 2) * 60_000;
    const duePlan = await createLifeCoachHeartbeatPlan({
      cfg: BASE_CFG,
      agentId: "main",
      basePrompt: "Base prompt",
      sessionEntry: {
        sessionId: "sid",
        updatedAt: dueAt,
        sessionFile: completionFile,
      },
      lifeCoach: { enabled: true, cooldownMinutes: 1 },
      nowMs: dueAt,
    });

    expect(duePlan.decision?.phase).not.toBe("follow-up");
    const statePath = path.join(tmpDir, "agents", "main", "life-coach-state.json");
    const stateRaw = await fs.readFile(statePath, "utf-8");
    const state = __lifeCoachTestUtils.normalizeStateFile(JSON.parse(stateRaw) as unknown, dueAt);
    const completedEntry = state.history.find(
      (entry) => entry.intervention === initialPlan.decision?.intervention && entry.status === "completed",
    );
    expect(completedEntry).toBeDefined();
  });

  it("rehydrates saved intervention affinity values from persisted state", () => {
    const normalized = __lifeCoachTestUtils.normalizeStateFile(
      {
        version: 2,
        updatedAt: 123,
        history: [],
        stats: {},
        preferences: {
          objectiveBias: {
            "doomscrolling": 0,
            "deep-work": 0,
          },
          interventionAffinity: {
            "dyn:focus:activation": 0.7,
            "dyn:movement:activation": -0.4,
          },
          supportiveToneBias: 0,
          lastLearnedMessageTs: 100,
        },
      },
      Date.now(),
    );

    expect(normalized.preferences.interventionAffinity["dyn:focus:activation"]).toBe(0.7);
    expect(normalized.preferences.interventionAffinity["dyn:movement:activation"]).toBe(-0.4);
  });
});
