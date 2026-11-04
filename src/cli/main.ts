#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkspaceAgentClients, runOrchestrator } from "../orchestrator/index.js";
import { parseArgs, type RunOptions } from "./args.js";
import {
  dataSourceKinds,
  evidenceLinks,
  forecastSummary,
  mentorSummary,
  readLastTracePayload,
  soraSummary,
  topNeeds,
} from "./summary.js";
import { loadMessages } from "./transcript.js";
import { renderVideo, type VideoOutcome } from "./video.js";

/**
 * Where the run keeps the orchestrator's state, and whether that place is the
 * run's own to remove. The orchestrator keeps its state in the directory of the
 * file it is given, under a fixed name, so an unrecorded run gets a directory
 * of its own: a file named per process inside a shared directory would still
 * share that directory's state, and one run's cooldown would gate the next.
 */
async function stateFile(opts: RunOptions): Promise<{ file: string; scratch?: string }> {
  if (!opts.record) {
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "autlife-orchestrator-state-"));
    return { file: path.join(scratch, "orchestrator-state.json"), scratch };
  }
  const base = opts.stateDir ? path.resolve(opts.stateDir) : path.resolve(process.cwd(), ".autlife");
  return { file: path.resolve(base, "orchestrator-state.json") };
}

function traceFile(opts: RunOptions): string {
  if (opts.traceFile) {
    return path.resolve(opts.traceFile);
  }
  const base = opts.stateDir ? path.resolve(opts.stateDir) : path.resolve(process.cwd(), ".autlife");
  return path.resolve(base, "orchestrator-trace.jsonl");
}

/** Prints `name=value` for a field the run has; a field it does not have is not printed. */
function field(name: string, value: string | number | boolean | undefined): void {
  if (value !== undefined) {
    console.log(`${name}=${String(value)}`);
  }
}

/** Prints `name=a<sep>b…` for a list the run has entries in; an empty list is not printed. */
function fields(name: string, values: string[], separator: string): void {
  if (values.length > 0) {
    console.log(`${name}=${values.join(separator)}`);
  }
}

/** One intervention run over a transcript: orchestrate, render the video the run asks for, print the summary and trace. */
export async function runIntervention(argv: readonly string[]): Promise<void> {
  const opts = parseArgs(argv);
  if (!opts.source) {
    throw new Error("--source /absolute/path/to/transcript is required: it names the transcript the run reads");
  }
  const sourcePath = path.resolve(opts.source);
  const messages = await loadMessages(sourcePath);
  if (messages.length === 0) {
    throw new Error(`no messages were read from ${sourcePath}: it holds no user or assistant message`);
  }
  const traces = traceFile(opts);
  const clients = await createWorkspaceAgentClients();
  const state = await stateFile(opts);
  const { decision, trace } = await runOrchestrator({
    input: {
      agentId: opts.agentId,
      messages,
      cooldownMinutes: opts.cooldownMinutes,
      maxNudgesPerDay: opts.maxNudgesPerDay,
      stateFile: state.file,
      traceFile: traces,
      sessionId: path.basename(sourcePath),
    },
    clients,
  }).finally(() => (state.scratch ? fs.rm(state.scratch, { recursive: true, force: true }) : undefined));

  const plan = decision.selected?.videoPlan;
  const video: VideoOutcome | undefined =
    opts.renderVideo && plan ? await renderVideo(opts, plan, decision.traceId, process.env.OPENAI_API_KEY) : undefined;

  const payload = await readLastTracePayload(traces);
  const forecast = forecastSummary(payload);
  const mentor = mentorSummary(payload);
  const sora = soraSummary(payload);
  console.log("Autlife orchestration run complete.");
  field("source", sourcePath);
  field("agent", opts.agentId);
  field("messages", messages.length);
  field("should_nudge", decision.shouldNudge);
  field("reason", decision.reason);
  field("trace_id", decision.traceId);
  field("selected_id", decision.selected?.id);
  field("selected_action", decision.selected?.action);
  field("follow_up_minutes", decision.selected?.followUpMinutes);
  console.log("--- summary ---");
  fields("state_top_needs", topNeeds(payload), ", ");
  fields("data_sources", dataSourceKinds(payload), ", ");
  field("forecast_baseline", forecast.baseline);
  field("forecast_with_intervention", forecast.withIntervention);
  fields("evidence_links", evidenceLinks(payload), " | ");
  field("mentor_figure", mentor.figure);
  field("mentor_topic", mentor.topic);
  field("mentor_takeaway", mentor.takeaway);
  fields("mentor_links", mentor.links, " | ");
  field("sora_status", sora.status);
  field("sora_title", sora.title);
  field("sora_job_id", sora.jobId);
  field("sora_call_to_action", sora.callToAction);
  field("sora_prompt", sora.prompt);
  field("video_provider", video?.provider);
  field("video_file", video?.file);
  field("video_scenes", video?.scenes);
  field("video_duration_seconds", video?.durationSeconds);
  field("sora_video_id", video?.soraVideoId);
  field("sora_model", video?.soraModel);
  field("sora_size", video?.soraSize);
  console.log("--- trace ---");
  console.log(JSON.stringify(trace, null, "\t"));
}

// The `run:intervention` command enters here. A refusal prints its own
// sentence on stderr, with no stack trace, and the process exits non-zero.
const [, , ...words] = process.argv;
try {
  await runIntervention(words);
} catch (error) {
  console.error(`run:intervention: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
