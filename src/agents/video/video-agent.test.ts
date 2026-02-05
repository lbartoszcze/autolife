import { describe, expect, it, vi } from "vitest";
import { buildSoraVideoPlan } from "./video-agent.js";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("video-agent", () => {
  it("builds a sora-ready video plan with storyboard and CTA", async () => {
    const plan = await buildSoraVideoPlan({
      intervention: {
        id: "dyn:focus:micro",
        objectiveIds: ["focus"],
        action: "Run one 20-minute focus block with phone outside room.",
        expectedImpact: "Improved focus and less doomscrolling.",
        followUpMinutes: 120,
      },
      state: {
        needs: { focus: 0.82 },
        affect: {
          frustration: 0.6,
          distress: 0.5,
          momentum: 0.3,
        },
      },
      forecast: {
        horizonDays: 14,
        baseline: "focus remains unstable",
        withIntervention: "focus improves",
        assumptions: ["a"],
        confidence: 0.66,
      },
    });

    expect(plan.provider).toBe("sora");
    expect(plan.status).toBe("ready");
    expect(plan.prompt.toLowerCase()).toContain("focus");
    expect(plan.storyboard.length).toBeGreaterThanOrEqual(4);
    expect(plan.callToAction).toContain("Start now");
  });

  it("queues plan to webhook when configured", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ id: "job_123" }));

    const plan = await buildSoraVideoPlan({
      intervention: {
        id: "dyn:sleep:micro",
        objectiveIds: ["sleep"],
        action: "Start wind-down now and dim screens.",
        expectedImpact: "Sleep regularity should improve.",
        followUpMinutes: 90,
      },
      state: {
        needs: { sleep: 0.78 },
        affect: {
          frustration: 0.4,
          distress: 0.35,
          momentum: 0.5,
        },
      },
      forecast: {
        horizonDays: 10,
        baseline: "sleep remains irregular",
        withIntervention: "sleep improves",
        assumptions: ["a"],
        confidence: 0.63,
      },
      queue: true,
      webhookUrl: "https://example.com/sora-hook",
      fetchImpl: fetchMock,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(plan.status).toBe("queued");
    expect(plan.jobId).toBe("job_123");
  });
});
