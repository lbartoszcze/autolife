import { describe, expect, it } from "vitest";
import { buildForecast } from "./forecast-agent.js";

const STATE = {
  needs: {
    sleep: 0.72,
    focus: 0.68,
    stress: 0.61,
  },
  affect: {
    frustration: 0.64,
    distress: 0.66,
    momentum: 0.31,
  },
  signals: ["transcript:blocked", "wearables:short sleep"],
  freshness: {
    capturedAt: Date.UTC(2026, 1, 5, 10, 0, 0),
    ageMinutes: 20,
    completeness: 0.78,
  },
};

describe("forecast-agent", () => {
  it("produces baseline and intervention-adjusted forecasts with assumptions", () => {
    const forecast = buildForecast({
      state: STATE,
      horizonDays: 21,
      intervention: {
        id: "dyn:focus:time-boxed-start",
        objectiveIds: ["focus", "sleep"],
        expectedImpact: "higher execution consistency",
        effort: "medium",
      },
      evidence: [
        {
          topicId: "focus",
          claim: "behavioral activation improves execution",
          confidence: 0.72,
          references: [],
        },
      ],
    });

    expect(forecast.horizonDays).toBe(21);
    expect(forecast.baseline.length).toBeGreaterThan(20);
    expect(forecast.withIntervention).toContain("dyn:focus:time-boxed-start");
    expect(forecast.assumptions.length).toBeGreaterThanOrEqual(3);
    expect(forecast.confidence).toBeGreaterThan(0);
  });

  it("returns a non-prescriptive baseline-only forecast when no intervention is provided", () => {
    const forecast = buildForecast({
      state: STATE,
      horizonDays: 10,
      evidence: [],
    });

    expect(forecast.withIntervention).toContain("With a targeted intervention");
    expect(forecast.baseline).toContain("Without intervention");
    expect(forecast.confidence).toBeGreaterThan(0);
  });
});
