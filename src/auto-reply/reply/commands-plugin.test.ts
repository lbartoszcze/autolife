import { beforeEach, describe, expect, it } from "vitest";
import type { ClawdbotConfig } from "../../config/config.js";
import { clearPluginCommands, registerPluginCommand } from "../../plugins/commands.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { handlePluginCommand } from "./commands-plugin.js";

describe("handlePluginCommand", () => {
  beforeEach(() => {
    clearPluginCommands();
  });

  it("skips plugin commands when text commands are disabled", async () => {
    registerPluginCommand("plugin-core", {
      name: "ping",
      description: "Ping",
      handler: () => ({ text: "pong" }),
    });

    const params = {
      command: {
        commandBodyNormalized: "/ping",
        senderId: "user-1",
        channel: "test",
        isAuthorizedSender: true,
      },
      cfg: {} as ClawdbotConfig,
    } as HandleCommandsParams;

    const result = await handlePluginCommand(params, false);
    expect(result).toBeNull();
  });

  it("executes plugin commands when text commands are enabled", async () => {
    registerPluginCommand("plugin-core", {
      name: "ping",
      description: "Ping",
      handler: () => ({ text: "pong" }),
    });

    const params = {
      command: {
        commandBodyNormalized: "/ping",
        senderId: "user-1",
        channel: "test",
        isAuthorizedSender: true,
      },
      cfg: {} as ClawdbotConfig,
    } as HandleCommandsParams;

    const result = await handlePluginCommand(params, true);
    expect(result?.reply?.text).toBe("pong");
  });
});
