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

// "HH:MM" → minutes since local midnight, or null when malformed.
export function parseHhmm(value) {
  const m = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Nightly run window. Defaults to 02:00–09:00 local. A window where start > end
// (e.g. 22:00–06:00) is treated as crossing midnight.
export function discoveryWindow(env = process.env) {
  const start = parseHhmm(env.DISCOVERY_WINDOW_START || "02:00") ?? 120;
  const end = parseHhmm(env.DISCOVERY_WINDOW_END || "09:00") ?? 540;
  return { startMin: start, endMin: end, crossesMidnight: start > end };
}

// Is `minOfDay` (0–1439) inside the window? Handles the midnight-crossing case.
export function inWindow(minOfDay, win) {
  if (win.crossesMidnight) return minOfDay >= win.startMin || minOfDay < win.endMin;
  return minOfDay >= win.startMin && minOfDay < win.endMin;
}

export function discoveryUseRenderer(env = process.env) {
  return env.DISCOVERY_USE_RENDERER === "true";
}

// Allowed manual session lengths (minutes). Mirrors the 30m/1h/2h/3h UI choices.
export function clampSessionMinutes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.max(5, Math.min(360, Math.round(n)));
}
