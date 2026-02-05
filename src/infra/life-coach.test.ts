import { describe, expect, it } from "vitest";
import {
  applyObjectivePreferenceBias,
  applyPreferenceDecay,
  inferObjectivesFromInterventionId,
  learnPreferencesFromMessages,
  resolveObjectives,
} from "./life-coach-extractors.js";

describe("preference extractors", () => {
  it("builds and decays a preference profile", () => {
    const profile = learnPreferencesFromMessages({
      messages: [
        { role: "user", text: "I want better sleep quality" },
        { role: "user", text: "Need stronger deep work sessions" },
      ],
      now: Date.UTC(2026, 1, 5),
    });

    const decayed = applyPreferenceDecay({
      profile,
      ageMinutes: 60 * 24 * 21,
      halfLifeDays: 14,
    });

    expect(Object.keys(profile.objectiveWeights).length).toBeGreaterThan(0);
    expect(decayed.confidence).toBeLessThan(profile.confidence);
  });

  it("applies objective bias and infers objectives from intervention ids", () => {
    const profile = learnPreferencesFromMessages({
      messages: [{ role: "user", text: "I want better writing focus this week" }],
      now: Date.UTC(2026, 1, 5),
    });

    const topObjectives = resolveObjectives(profile);
    const adjusted = applyObjectivePreferenceBias({
      rawObjectives: { [topObjectives[0] ?? "general"]: 0.6 },
      profile,
    });

    expect(Object.values(adjusted)[0]).toBeGreaterThan(0.6);
    expect(inferObjectivesFromInterventionId("dyn:focus-recovery:micro-step")).toContain("focus-recovery");
  });
});
