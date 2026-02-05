import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { setTelegramRuntime } from "../../extensions/telegram/src/runtime.js";
import { whatsappPlugin } from "../../extensions/whatsapp/src/channel.js";
import { setWhatsAppRuntime } from "../../extensions/whatsapp/src/runtime.js";
import * as replyModule from "../auto-reply/reply.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

beforeEach(() => {
  const runtime = createPluginRuntime();
  setTelegramRuntime(runtime);
  setWhatsAppRuntime(runtime);
  setActivePluginRegistry(
    createTestRegistry([
      { pluginId: "whatsapp", plugin: whatsappPlugin, source: "test" },
      { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
    ]),
  );
});

describe("heartbeat life-coach integration", () => {
  it("injects dynamic life-coach guidance into heartbeat prompts and records dispatch", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hb-life-coach-"));
    const prevStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    const storePath = path.join(tmpDir, "sessions.json");
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const replySpy = vi.spyOn(replyModule, "getReplyFromConfig");
    try {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "whatsapp",
              lifeCoach: {
                enabled: true,
                cooldownMinutes: 1,
              },
            },
          },
        },
        channels: { whatsapp: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            [sessionKey]: {
              sessionId: "sid",
              updatedAt: Date.now(),
              sessionFile,
              lastChannel: "whatsapp",
              lastProvider: "whatsapp",
              lastTo: "+1555",
            },
          },
          null,
          2,
        ),
      );
      await fs.writeFile(
        sessionFile,
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [{ type: "text", text: "I keep doomscrolling social media and can't focus" }],
          },
        }),
      );

      replySpy.mockResolvedValue({ text: "Block social apps for 30 minutes and start one focus sprint." });
      const sendWhatsApp = vi.fn().mockResolvedValue({ messageId: "m1", toJid: "jid" });
      const nowMs = 1_000_000;
      await runHeartbeatOnce({
        cfg,
        deps: {
          sendWhatsApp,
          getQueueSize: () => 0,
          nowMs: () => nowMs,
          webAuthExists: async () => true,
          hasActiveWebListener: () => true,
        },
      });

      expect(replySpy).toHaveBeenCalled();
      const ctx = replySpy.mock.calls[0]?.[0] as { Body?: string } | undefined;
      expect(ctx?.Body).toContain("[AUTOLIFE LIFECOACH]");
      expect(sendWhatsApp).toHaveBeenCalled();

      const statePath = path.join(tmpDir, "agents", "main", "life-coach-state.json");
      const stateRaw = await fs.readFile(statePath, "utf-8");
      expect(stateRaw).toContain("\"sent\": 1");
    } finally {
      replySpy.mockRestore();
      if (prevStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = prevStateDir;
      }
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

