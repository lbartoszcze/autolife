import { describe, expect, it } from "vitest";
import {
  buildCurrentStateAssessment,
  estimateAffect,
  estimateNeeds,
  inferObjectivesFromInterventionId,
} from "./life-coach-extractors.js";

const NOW = Date.UTC(2026, 1, 5, 12, 0, 0);

describe("state extractors", () => {
  it("computes needs and affect from transcript", () => {
    const messages = [
      { role: "user" as const, text: "I am anxious and stuck with work focus" },
      { role: "user" as const, text: "sleep has been bad and I feel overwhelmed" },
    ];

    const needs = estimateNeeds(messages);
    const affect = estimateAffect(messages, needs);

    expect(Object.keys(needs).length).toBeGreaterThan(0);
    expect(needs.focus).toBeGreaterThan(0);
    expect(affect.distress).toBeGreaterThan(0);
    expect(affect.frustration).toBeGreaterThan(0);
  });

  it("builds current-state assessment with freshness and completeness", async () => {
    const assessment = await buildCurrentStateAssessment({
      nowMs: NOW,
      messages: [{ role: "user", text: "feeling blocked", timestamp: NOW - 10 * 60_000 }],
      calendar: [{ title: "deadline", startAt: NOW - 4 * 60 * 60_000 }],
      wearables: [{ capturedAt: NOW - 30 * 60_000, summary: "low sleep score" }],
    });

    expect(assessment.freshness.ageMinutes).toBeGreaterThanOrEqual(0);
    expect(assessment.freshness.completeness).toBeGreaterThan(0);
    expect(assessment.signals.length).toBeGreaterThan(0);
  });

  it("derives objective ids from intervention ids without fixed enums", () => {
    expect(inferObjectivesFromInterventionId("dyn:focus-recovery:micro-step")).toContain(
      "focus-recovery",
    );
    expect(inferObjectivesFromInterventionId("sleep-reset-plan")).toContain("sleep");
  });
});
