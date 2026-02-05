export type TranscriptRole = "user" | "assistant";

export type TranscriptMessage = {
  role: TranscriptRole;
  text: string;
  timestamp?: number;
};

export function parseTranscriptLine(raw: string): TranscriptMessage[] {
  const line = raw.trim();
  if (!line) {
    return [];
  }

  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if ((parsed.role === "user" || parsed.role === "assistant") && typeof parsed.text === "string") {
      return [{ role: parsed.role, text: parsed.text, timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : undefined }];
    }
    if (parsed.type === "message" && parsed.message && typeof parsed.message === "object") {
      const message = parsed.message as { role?: unknown; timestamp?: unknown; content?: unknown };
      if (message.role !== "user" && message.role !== "assistant") {
        return [];
      }
      if (!Array.isArray(message.content)) {
        return [];
      }
      const text = message.content
        .map((entry) => {
          if (!entry || typeof entry !== "object") {
            return "";
          }
          const maybeText = (entry as { text?: unknown }).text;
          return typeof maybeText === "string" ? maybeText : "";
        })
        .filter(Boolean)
        .join("\n")
        .trim();

      if (!text) {
        return [];
      }

      return [
        {
          role: message.role,
          text,
          timestamp: typeof message.timestamp === "number" ? message.timestamp : undefined,
        },
      ];
    }
  } catch {
    return [{ role: "user", text: line }];
  }

  return [];
}
