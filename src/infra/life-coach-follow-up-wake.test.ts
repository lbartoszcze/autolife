import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __lifeCoachFollowUpWakeTestUtils,
  scheduleLifeCoachFollowUpWake,
} from "./life-coach-follow-up-wake.js";

describe("life-coach follow-up wake", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    __lifeCoachFollowUpWakeTestUtils.clearAll();
  });

  afterEach(() => {
    __lifeCoachFollowUpWakeTestUtils.clearAll();
    vi.useRealTimers();
  });

  it("schedules targeted follow-up wake and fires request", async () => {
    const requestNow = vi.fn();
    const dueAt = scheduleLifeCoachFollowUpWake({
      agentId: "main",
      followUpMinutes: 10,
      requestNow,
    });
    expect(dueAt).toBe(10 * 60_000);
    expect(__lifeCoachFollowUpWakeTestUtils.pendingCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    expect(requestNow).toHaveBeenCalledTimes(1);
    expect(requestNow).toHaveBeenCalledWith({
      reason: "life-coach-follow-up:main",
      coalesceMs: 0,
    });
    expect(__lifeCoachFollowUpWakeTestUtils.pendingCount()).toBe(0);
  });

  it("keeps earlier pending wake when a later one is requested", () => {
    const requestNow = vi.fn();
    const firstDue = scheduleLifeCoachFollowUpWake({
      agentId: "main",
      followUpMinutes: 5,
      requestNow,
    });
    const secondDue = scheduleLifeCoachFollowUpWake({
      agentId: "main",
      followUpMinutes: 30,
      requestNow,
    });
    expect(secondDue).toBe(firstDue);
    expect(__lifeCoachFollowUpWakeTestUtils.pendingCount()).toBe(1);
    expect(__lifeCoachFollowUpWakeTestUtils.pendingDueAtMs("main")).toBe(firstDue);
  });
});

