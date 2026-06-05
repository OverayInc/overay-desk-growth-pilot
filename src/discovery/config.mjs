// Discovery — configuration from the environment.
//
// Builds the { youtube, twitch, web } config object the pipeline/sources expect.
// Every source is optional; whatever is unset simply gets skipped at run time.

export function discoveryConfigFromEnv(env = process.env) {
  return {
    youtube: {
      apiKey: env.YOUTUBE_API_KEY || "",
      regionCode: env.LP_DISCOVERY_REGION || undefined,
    },
    twitch: {
      clientId: env.TWITCH_CLIENT_ID || "",
      clientSecret: env.TWITCH_CLIENT_SECRET || "",
    },
    web: {
      provider: env.WEB_SEARCH_PROVIDER || "", // "brave" | "serpapi"
      apiKey: env.WEB_SEARCH_API_KEY || "",
    },
  };
}

// Seed keywords: explicit arg list wins, else LP_DISCOVERY_SEEDS (|-separated),
// else a sensible default tuned for our anomaly/observation game.
export function discoverySeeds(argSeeds, env = process.env) {
  if (argSeeds && argSeeds.length) return argSeeds;
  const fromEnv = String(env.LP_DISCOVERY_SEEDS || "").trim();
  if (fromEnv) return fromEnv.split("|").map((s) => s.trim()).filter(Boolean);
  return [
    "spot the anomaly game",
    "Exit 8 gameplay",
    "observation horror indie game",
    "관찰 공포 게임 실황",
    "이상현상 찾기 게임",
  ];
}

export function discoveryGameContext(env = process.env) {
  return env.LP_DISCOVERY_GAME_CONTEXT || undefined;
}
