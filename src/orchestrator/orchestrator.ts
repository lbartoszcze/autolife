import { createHash } from "node:crypto";
import type { OrchestratorDecision } from "../contracts.js";
import { createDefaultAgentPorts } from "./default-agents.js";
import type { AgentPorts, OrchestratorInput, OrchestratorTrace } from "./ports.js";

const UNSAFE_ACTION_PATTERNS = [
  /stop\s+your\s+medication/i,
  /double\s+your\s+dose/i,
  /skip\s+sleep\s+entirely/i,
  /self-harm/i,
  /hurt\s+yourself/i,
  /starve\s+yourself/i,
];

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

function makeTraceId(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex").slice(0, 16);
}

function isUnsafeAction(action: string): boolean {
  return UNSAFE_ACTION_PATTERNS.some((pattern) => pattern.test(action));
}

function cooldownBlocked(input: Required<Pick<OrchestratorInput, "recentDispatches" | "cooldownMinutes">>, nowMs: number): boolean {
  const latest = [...input.recentDispatches].sort((a, b) => b.sentAt - a.sentAt)[0];
  if (!latest) {
    return false;
  }
  return nowMs - latest.sentAt < input.cooldownMinutes * 60_000;
}

function pacingBlocked(input: Required<Pick<OrchestratorInput, "recentDispatches" | "maxNudgesPerDay">>, nowMs: number): boolean {
  const dayWindowMs = 24 * 60 * 60_000;
  const count = input.recentDispatches.filter((item) => nowMs - item.sentAt <= dayWindowMs).length;
  return count >= input.maxNudgesPerDay;
}

export async function runOrchestratorDecision(params: {
  input: OrchestratorInput;
  ports?: AgentPorts;
}): Promise<{ decision: OrchestratorDecision; trace: OrchestratorTrace }> {
  const nowMs = params.input.nowMs ?? Date.now();
  const ports = params.ports ?? createDefaultAgentPorts(nowMs);
  const cooldownMinutes = Math.max(1, params.input.cooldownMinutes ?? 90);
  const maxNudgesPerDay = Math.max(1, params.input.maxNudgesPerDay ?? 6);
  const recentDispatches = params.input.recentDispatches ?? [];

  const preferences = await ports.preference.buildProfile(params.input.messages);
  const state = await ports.state.assessState(params.input.messages);
  const evidence = await ports.evidence.buildEvidence({
    state,
    preferences,
    messages: params.input.messages,
  });
  const forecast = await ports.forecast.buildForecast({ state, preferences, evidence });
  const planBundle = await ports.intervention.buildPlan({ state, preferences, evidence, forecast });

  let selected = planBundle.selected;
  const alternatives = planBundle.alternatives;

  const topNeed = Object.entries(state.needs).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (selected && topNeed && !selected.objectiveIds.includes(topNeed)) {
    const alignedAlternative = alternatives.find((plan) => plan.objectiveIds.includes(topNeed));
    if (alignedAlternative) {
      selected = alignedAlternative;
    }
  }

  const cooldownGate = cooldownBlocked({ recentDispatches, cooldownMinutes }, nowMs);
  const pacingGate = pacingBlocked({ recentDispatches, maxNudgesPerDay }, nowMs);
  const safetyGate = selected ? isUnsafeAction(selected.action) : false;

  const shouldNudge = Boolean(selected) && !cooldownGate && !pacingGate && !safetyGate;

  const tracePayload = {
    nowMs,
    cooldownMinutes,
    maxNudgesPerDay,
    shouldNudge,
    selected,
    alternatives,
    topNeed,
    forecast,
    state,
    preferences,
    evidence,
  };
  const traceId = makeTraceId(tracePayload);

  const reason = !selected
    ? "No candidate intervention was produced by the intervention agent."
    : cooldownGate
      ? `Cooldown active (${cooldownMinutes} minutes).`
      : pacingGate
        ? `Daily pacing cap reached (${maxNudgesPerDay}).`
        : safetyGate
          ? "Selected plan blocked by safety gate."
          : "Selected intervention passed arbitration, pacing, and safety gates.";

  const decision: OrchestratorDecision = {
    shouldNudge,
    reason,
    selected: shouldNudge ? selected : undefined,
    alternatives: alternatives.slice(0, 3),
    traceId,
  };

  const selectedEvidenceConfidence =
    selected && selected.evidence.length > 0
      ? selected.evidence.length / Math.max(1, evidence.flatMap((item) => item.references).length)
      : 0;

  const trace: OrchestratorTrace = {
    traceId,
    summary: reason,
    gates: {
      cooldownBlocked: cooldownGate,
      pacingBlocked: pacingGate,
      safetyBlocked: safetyGate,
    },
    scores: {
      stateCompleteness: state.freshness.completeness,
      forecastConfidence: forecast.confidence,
      selectedEvidenceConfidence,
    },
    selectedInterventionId: selected?.id,
  };

  return { decision, trace };
}
