export type VideoProvider = "auto" | "local" | "sora";
export type SoraModel = "sora-2" | "sora-2-pro";

export type RunOptions = {
  source?: string;
  agentId: string;
  stateDir?: string;
  traceFile?: string;
  videoOut?: string;
  videoProvider: VideoProvider;
  soraModel?: SoraModel;
  soraSize?: string;
  renderVideo: boolean;
  cooldownMinutes?: number;
  maxNudgesPerDay?: number;
  record: boolean;
};

/** The whole number a flag was given, refused naming the flag and the text when it is not one. */
function wholeNumber(flag: string, given: string): number {
  const value = Number(given);
  if (!Number.isInteger(value)) {
    throw new Error(`${flag} takes a whole number; it was given "${given}"`);
  }
  return value;
}

/** The video provider --video-provider names, refused with the text it was given. */
function videoProvider(flag: string, given: string): VideoProvider {
  const named = given.toLowerCase();
  switch (named) {
    case "auto":
    case "local":
    case "sora":
      return named;
    default:
      throw new Error(`${flag} takes auto, local or sora; it was given "${given}"`);
  }
}

/** The Sora model --sora-model names, refused with the text it was given. */
function soraModel(flag: string, given: string): SoraModel {
  const named = given.toLowerCase();
  switch (named) {
    case "sora-2":
    case "sora-2-pro":
      return named;
    default:
      throw new Error(`${flag} takes sora-2 or sora-2-pro; it was given "${given}"`);
  }
}

/** The run's options read from its command words; a flag missing its value or given a wrong one is refused by name. */
export function parseArgs(argv: readonly string[]): RunOptions {
  const opts: RunOptions = {
    agentId: "main",
    videoProvider: "auto",
    renderVideo: true,
    record: false,
  };
  const rest = [...argv];
  const valueOf = (flag: string): string => {
    const value = rest.shift();
    if (value === undefined) {
      throw new Error(`${flag} needs a value after it`);
    }
    return value;
  };

  for (;;) {
    const arg = rest.shift();
    if (arg === undefined) {
      return opts;
    }
    switch (arg) {
      case "--":
        break;
      case "--source":
        opts.source = valueOf(arg);
        break;
      case "--agent":
        opts.agentId = valueOf(arg);
        break;
      case "--state-dir":
        opts.stateDir = valueOf(arg);
        break;
      case "--trace-file":
        opts.traceFile = valueOf(arg);
        break;
      case "--video-out":
        opts.videoOut = valueOf(arg);
        break;
      case "--video-provider":
        opts.videoProvider = videoProvider(arg, valueOf(arg));
        break;
      case "--sora-model":
        opts.soraModel = soraModel(arg, valueOf(arg));
        break;
      case "--sora-size":
        opts.soraSize = valueOf(arg);
        break;
      case "--no-render-video":
        opts.renderVideo = false;
        break;
      case "--cooldown-minutes":
        opts.cooldownMinutes = wholeNumber(arg, valueOf(arg));
        break;
      case "--max-nudges-per-day":
        opts.maxNudgesPerDay = wholeNumber(arg, valueOf(arg));
        break;
      case "--record":
        opts.record = true;
        break;
      default:
        throw new Error(`unknown argument "${arg}"`);
    }
  }
}
