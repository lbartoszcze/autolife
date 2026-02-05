import fs from "node:fs/promises";
import path from "node:path";
import type { SoraVideoPlan } from "../../contracts.js";

export type SoraApiRenderInput = {
  plan: SoraVideoPlan;
  traceId: string;
  outputFile?: string;
  outputDir?: string;
  apiKey?: string;
  model?: "sora-2" | "sora-2-pro";
  size?: string;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
};

export type SoraApiRenderResult = {
  outputFile: string;
  videoId: string;
  model: string;
  size: string;
  seconds: number;
};

type CreateVideoResponse = {
  id?: string;
  status?: string;
  model?: string;
  size?: string;
  seconds?: number | string;
};

type VideoStatusResponse = {
  id?: string;
  status?: string;
  model?: string;
  size?: string;
  seconds?: number | string;
  progress?: number;
  error?: {
    message?: string;
    code?: string;
  };
};

function normalizeId(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "video"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseSeconds(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.round(value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return Math.max(1, Math.round(parsed));
    }
  }
  return fallback;
}

function parseSize(value: string | undefined, fallback: string): string {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim();
  if (!/^\d+x\d+$/i.test(normalized)) {
    return fallback;
  }
  return normalized.toLowerCase();
}

function resolveOutputFile(params: {
  outputFile?: string;
  outputDir?: string;
  traceId: string;
}): string {
  if (params.outputFile?.trim()) {
    return path.resolve(params.outputFile.trim());
  }
  const directory = params.outputDir?.trim() ? path.resolve(params.outputDir.trim()) : path.resolve(process.cwd(), ".autlife", "videos");
  const filename = `${normalizeId(params.traceId).slice(0, 24)}-${Date.now()}-sora.mp4`;
  return path.join(directory, filename);
}

function assertOk(response: Response, context: string): void {
  if (!response.ok) {
    throw new Error(`${context} failed (${response.status} ${response.statusText})`);
  }
}

export async function renderWithSoraApi(input: SoraApiRenderInput): Promise<SoraApiRenderResult> {
  const apiKey = input.apiKey ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for Sora API rendering.");
  }

  const model = input.model ?? "sora-2";
  const size = parseSize(input.size, "1280x720");
  const seconds = Math.max(4, Math.min(20, parseSeconds(input.plan.durationSeconds, 8)));
  const pollIntervalMs = Math.max(2_000, input.pollIntervalMs ?? 10_000);
  const maxWaitMs = Math.max(30_000, input.maxWaitMs ?? 15 * 60_000);
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = (input.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/g, "");

  const outputFile = resolveOutputFile({
    outputFile: input.outputFile,
    outputDir: input.outputDir,
    traceId: input.traceId,
  });
  await fs.mkdir(path.dirname(outputFile), { recursive: true });

  const createForm = new FormData();
  createForm.set("prompt", input.plan.prompt);
  createForm.set("model", model);
  createForm.set("size", size);
  createForm.set("seconds", String(seconds));

  const createResponse = await fetchImpl(`${baseUrl}/videos`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: createForm,
  });
  assertOk(createResponse, "Sora create video");

  const created = (await createResponse.json()) as CreateVideoResponse;
  const videoId = created.id;
  if (!videoId) {
    throw new Error("Sora create response missing video id.");
  }

  const deadline = Date.now() + maxWaitMs;
  let status = created.status ?? "queued";
  let statusPayload: VideoStatusResponse = {
    id: videoId,
    status,
    model: created.model,
    size: created.size,
    seconds: created.seconds,
  };

  while (Date.now() < deadline) {
    if (status === "completed") {
      break;
    }
    if (status === "failed" || status === "cancelled") {
      const message = statusPayload.error?.message ?? `Sora render ended with status=${status}`;
      throw new Error(message);
    }

    await sleep(pollIntervalMs);
    const statusResponse = await fetchImpl(`${baseUrl}/videos/${encodeURIComponent(videoId)}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    });
    assertOk(statusResponse, "Sora get video status");
    statusPayload = (await statusResponse.json()) as VideoStatusResponse;
    status = statusPayload.status ?? status;
  }

  if (status !== "completed") {
    throw new Error(`Timed out waiting for Sora render completion (video_id=${videoId}).`);
  }

  const contentResponse = await fetchImpl(`${baseUrl}/videos/${encodeURIComponent(videoId)}/content`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "video/mp4",
    },
  });
  assertOk(contentResponse, "Sora download content");
  const arrayBuffer = await contentResponse.arrayBuffer();
  await fs.writeFile(outputFile, Buffer.from(arrayBuffer));

  return {
    outputFile,
    videoId,
    model: statusPayload.model ?? model,
    size: parseSize(statusPayload.size, size),
    seconds: parseSeconds(statusPayload.seconds, seconds),
  };
}
