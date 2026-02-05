import { describe, expect, it } from "vitest";
import {
  assessCurrentState,
  createAppUsageAdapter,
  createCalendarAdapter,
  createDataSourcesModel,
  createLocationAdapter,
  createTranscriptAdapter,
  createWearablesAdapter,
} from "./state-agent.js";

const NOW = Date.UTC(2026, 1, 5, 12, 0, 0);

describe("state-agent", () => {
  it("ingests transcript first and returns dynamic needs", async () => {
    const assessment = await assessCurrentState({
      nowMs: NOW,
      dataSources: createDataSourcesModel([
        createTranscriptAdapter({
          nowMs: NOW,
          messages: [
            {
              role: "user",
              text: "I feel overwhelmed and my sleep rhythm is broken",
              timestamp: NOW - 15 * 60_000,
            },
            {
              role: "user",
              text: "focus at work is stuck and frustrating",
              timestamp: NOW - 5 * 60_000,
            },
          ],
        }),
      ]),
    });

    expect(Object.keys(assessment.needs).length).toBeGreaterThan(0);
    expect(assessment.needs["sleep"]).toBeGreaterThan(0);
    expect(assessment.needs["focus"]).toBeGreaterThan(0);
    expect(assessment.affect.distress).toBeGreaterThan(0);
    expect(assessment.freshness.completeness).toBeGreaterThan(0);
  });

  it("supports extensible adapters for calendar, wearables, app usage, and location", async () => {
    const assessment = await assessCurrentState({
      nowMs: NOW,
      dataSources: createDataSourcesModel([
        createTranscriptAdapter({ messages: [{ role: "user", text: "rough day" }], nowMs: NOW }),
        createCalendarAdapter({ events: [{ title: "late meeting", startAt: NOW - 2 * 60 * 60_000 }] }),
        createWearablesAdapter({ samples: [{ capturedAt: NOW - 60 * 60_000, summary: "high resting heart rate" }] }),
        createAppUsageAdapter({ samples: [{ capturedAt: NOW - 30 * 60_000, summary: "2h social media" }] }),
        createLocationAdapter({ samples: [{ capturedAt: NOW - 20 * 60_000, summary: "home all day" }] }),
      ]),
    });

    expect(assessment.signals.length).toBeGreaterThan(3);
    expect(assessment.freshness.completeness).toBeGreaterThan(0.5);
  });
});
