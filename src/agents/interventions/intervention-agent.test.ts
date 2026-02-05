import { describe, expect, it } from "vitest";
import { synthesizeInterventionPlan } from "./intervention-agent.js";

const INPUT = {
  state: {
    needs: {
      sleep: 0.71,
      focus: 0.79,
      stress: 0.63,
    },
    affect: {
      frustration: 0.66,
      distress: 0.61,
      momentum: 0.34,
    },
    signals: ["transcript:doomscrolling and blocked focus", "wearables:short sleep"],
    freshness: {
      capturedAt: Date.UTC(2026, 1, 5, 11, 40, 0),
      ageMinutes: 20,
      completeness: 0.81,
    },
  },
  preferences: {
    objectiveWeights: {
      focus: 0.45,
      sleep: 0.33,
      stress: 0.22,
    },
    interventionAffinity: {
      "dyn-focus-doomscrolling": 0.2,
    },
    toneBias: {
      supportive: 0.62,
      direct: 0.38,
    },
    confidence: 0.73,
  },
  evidence: [
    {
      topicId: "focus",
      claim: "activation improves task initiation",
      confidence: 0.71,
      references: [
        {
          title: "Behavioral activation trial",
          url: "https://pubmed.ncbi.nlm.nih.gov/12345678/",
          sourceType: "paper" as const,
        },
      ],
    },
    {
      topicId: "sleep",
      claim: "sleep schedule improves energy",
      confidence: 0.69,
      references: [
        {
          title: "Sleep consistency meta-analysis",
          url: "https://pubmed.ncbi.nlm.nih.gov/23456789/",
          sourceType: "meta-analysis" as const,
        },
      ],
    },
  ],
  forecast: {
    horizonDays: 14,
    baseline: "baseline",
    withIntervention: "adjusted",
    assumptions: ["assumption"],
    confidence: 0.68,
  },
};

describe("intervention-agent", () => {
  it("synthesizes and ranks dynamic intervention candidates", () => {
    const result = synthesizeInterventionPlan({ ...INPUT, maxCandidates: 4 });
    const plans = result.ranked;

    expect(plans.length).toBeGreaterThan(0);
    expect(plans[0].id.length).toBeGreaterThan(4);
    expect(plans[0].action).toContain("minute block");
    expect(plans[0].followUpMinutes).toBeGreaterThanOrEqual(20);
    expect(plans[0].score).toBeGreaterThanOrEqual(plans[plans.length - 1].score);
  });

  it("returns one selected intervention plan with measurable action and evidence links", () => {
    const selected = synthesizeInterventionPlan(INPUT).selected;
    expect(selected).toBeDefined();
    expect(selected?.action).toMatch(/\d+-minute|\d+ minute/);
    expect(selected?.objectiveIds.length).toBeGreaterThan(0);
    expect(selected?.evidence.every((reference: { url: string }) => reference.url.startsWith("https://"))).toBe(true);
  });
});
