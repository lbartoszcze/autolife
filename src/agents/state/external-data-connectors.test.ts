import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadExternalDataAdapters, parseExternalDataSourcesConfig } from "./external-data-connectors.js";

describe("external-data-connectors", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "autlife-connectors-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("parses connector config safely", () => {
    const parsed = parseExternalDataSourcesConfig({
      health: { path: "/tmp/health.json", weight: 0.7, format: "json" },
      custom: [{ path: "/tmp/custom.txt", kind: "notion", format: "text" }],
    });

    expect(parsed.health?.path).toContain("health.json");
    expect(parsed.custom?.length).toBe(1);
    expect(parsed.custom?.[0].kind).toBe("notion");
  });

  it("loads file-backed adapters for health/gmail/messenger style sources", async () => {
    const now = Date.UTC(2026, 1, 5, 18, 0, 0);
    const healthPath = path.join(tmpDir, "health.json");
    const gmailPath = path.join(tmpDir, "gmail.jsonl");
    const messengerPath = path.join(tmpDir, "messenger.txt");
    const cfgPath = path.join(tmpDir, "data-sources.json");

    await fs.writeFile(
      healthPath,
      JSON.stringify(
        [
          { timestamp: "2026-02-05T17:10:00Z", steps: 8214, sleepHours: 6.2, restingHr: 66 },
          { timestamp: "2026-02-05T12:10:00Z", steps: 4100, sleepHours: 6.2, restingHr: 68 },
        ],
        null,
        2,
      ),
      "utf-8",
    );

    await fs.writeFile(
      gmailPath,
      [
        JSON.stringify({ timestamp: "2026-02-05T16:30:00Z", subject: "Demo deadline", from: "teammate@example.com" }),
        JSON.stringify({ timestamp: "2026-02-05T16:40:00Z", subject: "Hackathon judging slot", from: "organizer@example.com" }),
      ].join("\n"),
      "utf-8",
    );

    await fs.writeFile(
      messengerPath,
      "2026-02-05 16:45 friend: walk in 20 minutes?\n2026-02-05 17:05 friend: sending deck draft",
      "utf-8",
    );

    await fs.writeFile(
      cfgPath,
      JSON.stringify(
        {
          health: { path: healthPath, format: "json" },
          gmail: { path: gmailPath, format: "jsonl" },
          messenger: { path: messengerPath, format: "text" },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const adapters = await loadExternalDataAdapters({
      configPath: cfgPath,
      nowMs: now,
    });

    expect(adapters.length).toBe(3);

    const signals = (await Promise.all(adapters.map((adapter) => adapter.ingest()))).flat();
    const kinds = new Set(signals.map((signal) => signal.kind));

    expect(kinds.has("health")).toBe(true);
    expect(kinds.has("gmail")).toBe(true);
    expect(kinds.has("messenger")).toBe(true);
    expect(signals.some((signal) => signal.text.toLowerCase().includes("steps"))).toBe(true);
    expect(signals.some((signal) => signal.text.toLowerCase().includes("hackathon"))).toBe(true);
  });
});
