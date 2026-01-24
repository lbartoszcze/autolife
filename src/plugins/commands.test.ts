import { beforeEach, describe, expect, it } from "vitest";
import type { ClawdbotConfig } from "../config/config.js";
import {
  clearPluginCommands,
  executePluginCommand,
  matchPluginCommand,
  registerPluginCommand,
  validateCommandName,
} from "./commands.js";

describe("validateCommandName", () => {
  it("rejects reserved aliases from built-in commands", () => {
    const error = validateCommandName("id");
    expect(error).toContain("reserved");
  });
});

describe("plugin command registry", () => {
  beforeEach(() => {
    clearPluginCommands();
  });

  it("normalizes command names for registration and matching", () => {
    const result = registerPluginCommand("plugin-core", {
      name: "  ping  ",
      description: "Ping",
      handler: () => ({ text: "pong" }),
    });
    expect(result.ok).toBe(true);

    const match = matchPluginCommand("/ping");
    expect(match?.command.name).toBe("ping");
  });

  it("blocks registration while a command is executing", async () => {
    let nestedResult: { ok: boolean; error?: string } | undefined;

    registerPluginCommand("plugin-core", {
      name: "outer",
      description: "Outer",
      handler: () => {
        nestedResult = registerPluginCommand("plugin-inner", {
          name: "inner",
          description: "Inner",
          handler: () => ({ text: "ok" }),
        });
        return { text: "done" };
      },
    });

    await executePluginCommand({
      command: matchPluginCommand("/outer")!.command,
      senderId: "user-1",
      channel: "test",
      isAuthorizedSender: true,
      commandBody: "/outer",
      config: {} as ClawdbotConfig,
    });

    expect(nestedResult?.ok).toBe(false);
    expect(nestedResult?.error).toContain("processing is in progress");
  });
});
