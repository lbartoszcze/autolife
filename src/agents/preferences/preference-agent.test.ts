import { describe, expect, it } from "vitest";
import { applyRecencyDecay, buildUserPreferenceProfile } from "./preference-agent.js";

function weightForMatch(weights: Record<string, number>, fragment: string): number {
  return Object.entries(weights).find(([id]) => id.includes(fragment))?.[1] ?? 0;
}

describe("preference agent", () => {
  it("infers dynamic objective ids from user language", () => {
    const profile = buildUserPreferenceProfile({
      now: 2_000_000,
      messages: [
        {
          role: "user",
          text: "I want better sleep quality and I need stronger deep work sessions",
          timestamp: 1_990_000,
        },
        {
          role: "user",
          text: "Trying to reduce doomscrolling because I lose momentum",
          timestamp: 1_995_000,
        },
      ],
    });

    expect(weightForMatch(profile.objectiveWeights, "sleep")).toBeGreaterThan(0);
    expect(weightForMatch(profile.objectiveWeights, "deep-work")).toBeGreaterThan(0);
    expect(weightForMatch(profile.objectiveWeights, "doomscroll")).toBeGreaterThan(0);
  });

  it("updates intervention affinity from outcome feedback", () => {
    const profile = buildUserPreferenceProfile({
      now: 4_000_000,
      previous: {
        objectiveWeights: { focus: 1 },
        interventionAffinity: {
          "breath-work": 0.8,
        },
        toneBias: {
          supportive: 0.5,
          direct: 0.5,
        },
        confidence: 0.8,
      },
      messages: [{ role: "user", text: "Need direct prompts", timestamp: 3_999_900 }],
      outcomes: [
        { interventionId: "breath-work", outcome: "rejected", timestamp: 3_999_950 },
        { interventionId: "focus-sprint", outcome: "completed", timestamp: 3_999_980 },
      ],
    });

    expect(profile.interventionAffinity["breath-work"]).toBeLessThan(0.8);
    expect(profile.interventionAffinity["focus-sprint"]).toBeGreaterThan(0.5);
  });

  it("weights recent language above stale language", () => {
    const profile = buildUserPreferenceProfile({
      now: Date.UTC(2026, 0, 31),
      messages: [
        {
          role: "user",
          text: "I want to improve sleep consistency",
          timestamp: Date.UTC(2025, 11, 1),
        },
        {
          role: "user",
          text: "I need better focus this week",
          timestamp: Date.UTC(2026, 0, 30),
        },
      ],
    });

    expect(weightForMatch(profile.objectiveWeights, "focus")).toBeGreaterThan(
      weightForMatch(profile.objectiveWeights, "sleep"),
    );
  });

  it("applies profile-level recency decay", () => {
    const decayed = applyRecencyDecay(
      {
        objectiveWeights: {
          focus: 0.7,
          sleep: 0.3,
        },
        interventionAffinity: {
          "focus-sprint": 0.9,
        },
        toneBias: {
          supportive: 0.9,
          direct: 0.2,
        },
        confidence: 0.9,
      },
      60 * 24 * 20,
      14,
    );

    expect(decayed.interventionAffinity["focus-sprint"]).toBeLessThan(0.9);
    expect(decayed.confidence).toBeLessThan(0.9);
    expect(decayed.objectiveWeights.focus + decayed.objectiveWeights.sleep).toBeCloseTo(1, 5);
  });
});
