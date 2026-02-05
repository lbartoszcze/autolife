import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SoraVideoPlan } from "../../contracts.js";

export type LocalVideoRenderInput = {
  plan: SoraVideoPlan;
  traceId: string;
  outputFile?: string;
  outputDir?: string;
  width?: number;
  height?: number;
  fps?: number;
  ffmpegPath?: string;
  fontFile?: string;
};

export type LocalVideoRenderResult = {
  outputFile: string;
  sceneCount: number;
  durationSeconds: number;
};

const DEFAULT_FONT_FILE = "/System/Library/Fonts/Supplemental/Arial.ttf";
const SCENE_COLORS = ["0x0f172a", "0x111827", "0x1e293b", "0x1f2937", "0x312e81"];

function normalizeId(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "video"
  );
}

function sanitizeText(value: string): string {
  return value
    .replace(/\r/g, " ")
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .trim();
}

function wrapText(value: string, lineLength = 52): string {
  const words = sanitizeText(value).split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "";
  }
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= lineLength) {
      current = next;
      continue;
    }
    if (current) {
      lines.push(current);
    }
    current = word;
  }
  if (current) {
    lines.push(current);
  }
  return lines.join("\n");
}

function sceneDurations(totalSeconds: number, count: number): number[] {
  const safeCount = Math.max(1, count);
  const safeTotal = Math.max(safeCount, Math.round(totalSeconds));
  const base = Math.floor(safeTotal / safeCount);
  let remainder = safeTotal % safeCount;
  const durations = Array.from({ length: safeCount }, () => base);
  for (let index = 0; index < durations.length; index += 1) {
    if (remainder <= 0) {
      break;
    }
    durations[index] += 1;
    remainder -= 1;
  }
  return durations;
}

function runCommand(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "pipe",
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed (${cmd}) exit=${code}: ${stderr.slice(-600)}`));
    });
  });
}

function buildSceneTexts(plan: SoraVideoPlan): string[] {
  const scenes = (plan.storyboard ?? []).map((entry) => sanitizeText(entry)).filter(Boolean);
  if (scenes.length > 0) {
    return scenes;
  }
  return [
    `${plan.title}`,
    `Target action: ${plan.callToAction}`,
    "Execute the first action now.",
  ];
}

export async function renderSoraPlanToVideo(input: LocalVideoRenderInput): Promise<LocalVideoRenderResult> {
  const ffmpegPath = input.ffmpegPath ?? "ffmpeg";
  const width = Math.max(640, input.width ?? 1280);
  const height = Math.max(360, input.height ?? 720);
  const fps = Math.max(24, input.fps ?? 30);
  const fontFile = input.fontFile ?? process.env.AUTLIFE_VIDEO_FONT_FILE ?? DEFAULT_FONT_FILE;

  const traceId = normalizeId(input.traceId).slice(0, 24);
  const defaultOutputDir = input.outputDir ? path.resolve(input.outputDir) : path.resolve(process.cwd(), ".autlife", "videos");
  await fs.mkdir(defaultOutputDir, { recursive: true });

  const outputFile = input.outputFile
    ? path.resolve(input.outputFile)
    : path.join(defaultOutputDir, `${traceId || "autlife"}-${Date.now()}.mp4`);

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "autlife-video-"));
  try {
    const sceneTexts = buildSceneTexts(input.plan);
    const durations = sceneDurations(input.plan.durationSeconds || 12, sceneTexts.length);

    const sceneFiles: string[] = [];
    for (let index = 0; index < sceneTexts.length; index += 1) {
      const sceneText = sceneTexts[index];
      const formatted = wrapText(sceneText, 54);
      const sceneFile = path.join(tempDir, `scene-${index + 1}.txt`);
      await fs.writeFile(sceneFile, formatted, "utf-8");
      sceneFiles.push(sceneFile);
    }

    const args: string[] = ["-y"];
    for (let index = 0; index < sceneFiles.length; index += 1) {
      const color = SCENE_COLORS[index % SCENE_COLORS.length];
      args.push(
        "-f",
        "lavfi",
        "-i",
        `color=c=${color}:s=${width}x${height}:d=${durations[index]}`,
      );
    }

    const filterStages: string[] = [];
    const concatInputs: string[] = [];
    for (let index = 0; index < sceneFiles.length; index += 1) {
      const label = `v${index}`;
      concatInputs.push(`[${label}]`);
      filterStages.push(
        `[${index}:v]` +
          `drawbox=x=48:y=64:w=${width - 96}:h=${height - 128}:color=0x00000066:t=fill,` +
          `drawtext=fontfile=${fontFile}:textfile=${sceneFiles[index]}:fontcolor=white:fontsize=40:line_spacing=12:x=(w-text_w)/2:y=(h-text_h)/2,` +
          `drawtext=fontfile=${fontFile}:text='Autlife':fontcolor=0xC7D2FE:fontsize=28:x=48:y=24[` +
          `${label}]`,
      );
    }

    const filterComplex =
      `${filterStages.join(";")};` +
      `${concatInputs.join("")}concat=n=${sceneFiles.length}:v=1:a=0,format=yuv420p[vout]`;

    args.push(
      "-filter_complex",
      filterComplex,
      "-map",
      "[vout]",
      "-c:v",
      "libx264",
      "-r",
      String(fps),
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outputFile,
    );

    await runCommand(ffmpegPath, args);
    return {
      outputFile,
      sceneCount: sceneFiles.length,
      durationSeconds: durations.reduce((sum, value) => sum + value, 0),
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
