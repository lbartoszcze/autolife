import type { CurrentStateAssessment, Forecast, InterventionPlan, MentorComparison, SoraVideoPlan } from "../../contracts.js";

export type VideoAgentInput = {
  intervention: Pick<InterventionPlan, "id" | "objectiveIds" | "action" | "expectedImpact" | "followUpMinutes">;
  state: Pick<CurrentStateAssessment, "needs" | "affect">;
  forecast: Forecast;
  mentorComparison?: MentorComparison;
  queue?: boolean;
  webhookUrl?: string;
  now?: number;
  fetchImpl?: typeof fetch;
};

type QueueResponse = {
  id?: string;
  jobId?: string;
  status?: string;
};

function objectiveLabel(id: string): string {
  return id.replace(/-/g, " ");
}

function pickTopObjective(intervention: VideoAgentInput["intervention"]): string {
  return intervention.objectiveIds[0] ?? "consistency";
}

function durationSeconds(followUpMinutes: number): number {
  if (followUpMinutes <= 90) {
    return 12;
  }
  if (followUpMinutes <= 240) {
    return 16;
  }
  return 20;
}

function buildStoryboard(input: VideoAgentInput, topic: string): string[] {
  const distress = input.state.affect.distress;
  const frustration = input.state.affect.frustration;
  const openingTone =
    distress >= 0.6
      ? "Scene 1: stressed desk environment with clear overload cues, then one deep breath and camera stabilization."
      : frustration >= 0.55
        ? "Scene 1: fragmented attempts, tabs switching fast, then abrupt stop and reset."
        : "Scene 1: calm but distracted start, subtle friction cues, then intentional posture reset.";

  const mentorScene = input.mentorComparison
    ? `Scene 2: split-screen with ${input.mentorComparison.figure} as a symbolic reference and caption about ${input.mentorComparison.topic}.`
    : "Scene 2: abstract progress metaphor showing small steps compounding over time.";

  const actionScene = `Scene 3: immediate execution of "${input.intervention.action}" with timer overlay and focus lock.`;
  const outcomeScene = `Scene 4: tangible improvement snapshot tied to ${topic}, ending with a checklist tick and next follow-up reminder.`;

  return [openingTone, mentorScene, actionScene, outcomeScene];
}

function buildPrompt(input: VideoAgentInput, topic: string, storyboard: string[]): string {
  const mentorClause = input.mentorComparison
    ? `Include a subtle mentor analogy to ${input.mentorComparison.figure} (${input.mentorComparison.context}).`
    : "No named mentor required; keep comparison symbolic and non-specific.";

  return [
    "Create a realistic motivational Sora video.",
    `Topic: ${topic}.`,
    `Target behavior: ${input.intervention.action}`,
    `Forecast delta: baseline="${input.forecast.baseline}" vs with intervention="${input.forecast.withIntervention}".`,
    mentorClause,
    "Style: cinematic but practical, no hype, no fantasy effects unless explicitly grounded.",
    `Storyboard: ${storyboard.join(" ")}`,
    "End with one concrete call-to-action and timer visual.",
  ].join(" ");
}

async function queueSoraPlan(params: {
  plan: SoraVideoPlan;
  webhookUrl: string;
  fetchImpl: typeof fetch;
}): Promise<{ status: "queued" | "ready"; jobId?: string }> {
  try {
    const response = await params.fetchImpl(params.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(params.plan),
    });
    if (!response.ok) {
      return { status: "ready" };
    }
    const payload = (await response.json().catch(() => ({}))) as QueueResponse;
    const jobId = payload.id ?? payload.jobId;
    return {
      status: jobId ? "queued" : "ready",
      jobId,
    };
  } catch {
    return { status: "ready" };
  }
}

export async function buildSoraVideoPlan(input: VideoAgentInput): Promise<SoraVideoPlan> {
  const topObjective = pickTopObjective(input.intervention);
  const topic = objectiveLabel(topObjective);
  const storyboard = buildStoryboard(input, topic);
  const prompt = buildPrompt(input, topic, storyboard);

  const plan: SoraVideoPlan = {
    provider: "sora",
    status: "ready",
    title: `Autlife ${topic} intervention preview`,
    prompt,
    storyboard,
    durationSeconds: durationSeconds(input.intervention.followUpMinutes),
    callToAction: `Start now: ${input.intervention.action}`,
  };

  const webhook = input.webhookUrl?.trim() || process.env.AUTLIFE_SORA_WEBHOOK_URL?.trim();
  if (!input.queue || !webhook) {
    return plan;
  }

  const queueResult = await queueSoraPlan({
    plan,
    webhookUrl: webhook,
    fetchImpl: input.fetchImpl ?? fetch,
  });
  return {
    ...plan,
    status: queueResult.status,
    jobId: queueResult.jobId,
  };
}
