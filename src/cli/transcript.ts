import fs from "node:fs/promises";
import type { TranscriptMessage } from "../orchestrator/index.js";

type Role = TranscriptMessage["role"];

/** Every role a transcript message carries, as the orchestrator's TranscriptMessage type declares them. */
const ROLES: Record<Role, Role> = { user: "user", assistant: "assistant" };

function roleOf(value: unknown): Role | undefined {
  return typeof value === "string" && Object.hasOwn(ROLES, value) ? ROLES[value as Role] : undefined;
}

/** The text of a message's content blocks, joined in order. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((entry: unknown) =>
      entry && typeof entry === "object" && "text" in entry && typeof entry.text === "string" ? entry.text : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** The message a JSON transcript record carries: `{role, text}` or `{type: "message", message: {role, content}}`. */
function recordMessages(record: object): TranscriptMessage[] {
  const plain = "role" in record ? roleOf(record.role) : undefined;
  const at = "timestamp" in record && typeof record.timestamp === "number" ? record.timestamp : Date.now();
  if (plain && "text" in record && typeof record.text === "string") {
    return [{ role: plain, text: record.text.trim(), timestamp: at }];
  }
  if ("message" in record && record.message && typeof record.message === "object") {
    const message = record.message;
    const speaker = "role" in message ? roleOf(message.role) : undefined;
    const text = "content" in message ? contentText(message.content) : "";
    const stamped = "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : Date.now();
    return speaker && text ? [{ role: speaker, text, timestamp: stamped }] : [];
  }
  return [];
}

/** A plain text line: `<role>: …` names its speaker, any other line is the user's. */
function textMessage(line: string): TranscriptMessage {
  const lowered = line.toLowerCase();
  for (const speaker of Object.values(ROLES)) {
    const prefix = `${speaker}:`;
    if (lowered.startsWith(prefix)) {
      return { role: speaker, text: line.slice(prefix.length).trim(), timestamp: Date.now() };
    }
  }
  return { role: ROLES.user, text: line, timestamp: Date.now() };
}

/**
 * The messages of a transcript file: JSON records (a line starting with `{`)
 * and plain text lines. A line that starts as JSON but does not parse is
 * refused with its line number and the parser's cause, never read as text.
 */
export async function loadMessages(sourcePath: string): Promise<TranscriptMessage[]> {
  const raw = await fs.readFile(sourcePath, "utf-8");
  return raw.split(/\r?\n/).flatMap((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return [];
    }
    if (!trimmed.startsWith("{")) {
      return [textMessage(trimmed)];
    }
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(
        `${sourcePath} line ${index + 1} starts as a JSON record but does not parse: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return record && typeof record === "object" ? recordMessages(record) : [];
  });
}
