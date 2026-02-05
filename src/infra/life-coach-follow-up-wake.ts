import { normalizeAgentId } from "../routing/session-key.js";
import { requestHeartbeatNow } from "./heartbeat-wake.js";

type FollowUpWakeEntry = {
  agentId: string;
  dueAtMs: number;
  timer: NodeJS.Timeout;
};

const pendingWakeByAgent = new Map<string, FollowUpWakeEntry>();

export function scheduleLifeCoachFollowUpWake(params: {
  agentId: string;
  followUpMinutes: number;
  nowMs?: () => number;
  requestNow?: (opts?: { reason?: string; coalesceMs?: number }) => void;
}): number {
  const agentId = normalizeAgentId(params.agentId);
  const now = params.nowMs?.() ?? Date.now();
  const followUpMinutes = Math.max(1, Math.floor(params.followUpMinutes || 0));
  const dueAtMs = now + followUpMinutes * 60_000;
  const existing = pendingWakeByAgent.get(agentId);
  if (existing && existing.dueAtMs <= dueAtMs) {
    return existing.dueAtMs;
  }
  if (existing) {
    clearTimeout(existing.timer);
    pendingWakeByAgent.delete(agentId);
  }

  const delayMs = Math.max(0, dueAtMs - now);
  const requestNow = params.requestNow ?? requestHeartbeatNow;
  const timer = setTimeout(() => {
    pendingWakeByAgent.delete(agentId);
    requestNow({
      reason: `life-coach-follow-up:${agentId}`,
      coalesceMs: 0,
    });
  }, delayMs);
  timer.unref?.();

  pendingWakeByAgent.set(agentId, {
    agentId,
    dueAtMs,
    timer,
  });
  return dueAtMs;
}

export function clearLifeCoachFollowUpWake(agentId?: string): void {
  if (agentId) {
    const key = normalizeAgentId(agentId);
    const existing = pendingWakeByAgent.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      pendingWakeByAgent.delete(key);
    }
    return;
  }
  for (const entry of pendingWakeByAgent.values()) {
    clearTimeout(entry.timer);
  }
  pendingWakeByAgent.clear();
}

export const __lifeCoachFollowUpWakeTestUtils = {
  pendingDueAtMs(agentId: string): number | undefined {
    return pendingWakeByAgent.get(normalizeAgentId(agentId))?.dueAtMs;
  },
  pendingCount(): number {
    return pendingWakeByAgent.size;
  },
  clearAll(): void {
    clearLifeCoachFollowUpWake();
  },
};

