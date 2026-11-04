import path from "node:path";
import type { SoraVideoPlan } from "../contracts.js";
import { renderSoraPlanToVideo } from "../agents/video/local-renderer.js";
import { renderWithSoraApi } from "../agents/video/sora-api-renderer.js";
import type { RunOptions } from "./args.js";

/** The video a run made: a Sora render, or a placeholder named as one. */
export type VideoOutcome = {
  provider: string;
  file: string;
  scenes?: number;
  durationSeconds: number;
  soraVideoId?: string;
  soraModel?: string;
  soraSize?: string;
};

/**
 * Renders the plan the way the run asked. `auto` and `sora` render through
 * the Sora video API and nothing else: with no OPENAI_API_KEY the run is
 * refused, saying no Sora render was made and why, so a placeholder is never
 * passed off as the Sora video. The local slideshow is made only for
 * `--video-provider local`, and is reported as a placeholder.
 */
export async function renderVideo(
  opts: RunOptions,
  plan: SoraVideoPlan,
  traceId: string,
  apiKey: string | undefined,
): Promise<VideoOutcome> {
  const outputDir = opts.stateDir
    ? path.resolve(opts.stateDir, "videos")
    : path.resolve(process.cwd(), ".autlife", "videos");
  const outputFile = opts.videoOut ? path.resolve(opts.videoOut) : undefined;
  if (opts.videoProvider === "local") {
    const render = await renderSoraPlanToVideo({ plan, traceId, outputFile, outputDir });
    plan.outputFile = render.outputFile;
    return {
      provider: "local-placeholder (not a Sora render)",
      file: render.outputFile,
      scenes: render.sceneCount,
      durationSeconds: render.durationSeconds,
    };
  }
  if (!apiKey) {
    throw new Error(
      "no Sora render was made: OPENAI_API_KEY is not set, so the Sora video API cannot be called; set it to render through Sora, pass --video-provider local for a placeholder slideshow of the plan, or --no-render-video to skip the video",
    );
  }
  const render = await renderWithSoraApi({
    plan,
    traceId,
    outputFile,
    outputDir,
    apiKey,
    model: opts.soraModel,
    size: opts.soraSize,
  });
  plan.outputFile = render.outputFile;
  plan.jobId = render.videoId;
  plan.status = "queued";
  return {
    provider: "sora",
    file: render.outputFile,
    durationSeconds: render.seconds,
    soraVideoId: render.videoId,
    soraModel: render.model,
    soraSize: render.size,
  };
}
