import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithSoraApi } from "./sora-api-renderer.js";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("sora-api-renderer", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autlife-sora-api-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates, polls, and downloads an mp4 via Sora API", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        jsonResponse({
          id: "vid_123",
          status: "queued",
          model: "sora-2",
          size: "1280x720",
          seconds: 8,
        }),
      )
      .mockImplementationOnce(async () =>
        jsonResponse({
          id: "vid_123",
          status: "completed",
          model: "sora-2",
          size: "1280x720",
          seconds: 8,
        }),
      )
      .mockImplementationOnce(async () => new Response(Buffer.from("FAKE-MP4-BYTES"), { status: 200 }));

    const outputFile = path.join(tmpDir, "sora.mp4");
    const result = await renderWithSoraApi({
      apiKey: "test-key",
      traceId: "trace-1",
      outputFile,
      pollIntervalMs: 1,
      fetchImpl: fetchMock,
      plan: {
        provider: "sora",
        status: "ready",
        title: "test",
        prompt: "render this",
        storyboard: ["scene 1", "scene 2"],
        durationSeconds: 8,
        callToAction: "act",
      },
      baseUrl: "https://api.openai.com/v1",
    });

    const bytes = await fs.readFile(outputFile);
    expect(bytes.length).toBeGreaterThan(0);
    expect(result.outputFile).toBe(outputFile);
    expect(result.videoId).toBe("vid_123");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
