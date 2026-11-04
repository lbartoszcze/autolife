import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..", "..");

/** Runs the real `run:intervention` entry with no OPENAI_API_KEY in its environment. */
async function runWithoutKey(extra: string[]) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "autlife-video-provider-"));
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  const run = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/cli/main.ts",
      "--source",
      "demo/demo-transcript.jsonl",
      "--agent",
      `video-provider-${process.pid}`,
      "--state-dir",
      stateDir,
      ...extra,
    ],
    { cwd: root, env, encoding: "utf8" },
  );
  const videos = await fs.readdir(path.join(stateDir, "videos")).catch(() => []);
  await fs.rm(stateDir, { recursive: true, force: true });
  return { run, videos };
}

// Each case runs the real CLI, whose orchestration calls live services and
// takes as long as they take; `timeout: 0` is vitest's "no deadline".
describe("run:intervention video provider", { timeout: 0 }, () => {
  it("refuses the default provider without a Sora key and writes no video", async () => {
    const { run, videos } = await runWithoutKey([]);
    expect(run.status, run.stdout + run.stderr).toBe(1);
    expect(run.stderr).toContain("no Sora render was made: OPENAI_API_KEY is not set");
    expect(run.stdout).not.toContain("video_file=");
    expect(videos).toEqual([]);
  });

  it("refuses --video-provider sora without a Sora key", async () => {
    const { run } = await runWithoutKey(["--video-provider", "sora"]);
    expect(run.status, run.stdout + run.stderr).toBe(1);
    expect(run.stderr).toContain("no Sora render was made");
  });

  it("finishes with --no-render-video and reports no video", async () => {
    const { run, videos } = await runWithoutKey(["--no-render-video"]);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).not.toContain("video_file=");
    expect(videos).toEqual([]);
  });
});
