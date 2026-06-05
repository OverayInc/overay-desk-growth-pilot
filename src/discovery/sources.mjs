// Discovery — retrieval layer (the part that actually "searches the internet").
//
// gemma4 cannot browse, so finding candidate creators is done here with real
// APIs. Each source is independent and DEGRADES GRACEFULLY: if its credentials
// are missing it returns [] (with a note) instead of throwing, so the pipeline
// can run on whatever is configured. No import of server.mjs (that file starts
// an HTTP server on import) — we keep a tiny self-contained fetch helper.
//
// Every source returns candidates in one shared shape:
//   { source, platform, externalId, channelName, handle, url, description,
//     recentTitles[], links[], subscribers }

async function getJson(url, { fetchImpl = fetch, headers = {}, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { Accept: "application/json", ...headers }, signal: controller.signal });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = body?.error?.message || body?.message || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return body || {};
  } finally {
    clearTimeout(timer);
  }
}

async function postForm(url, form, { fetchImpl = fetch, headers = {}, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(form).toString(),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error_description || body?.error || body?.message || `HTTP ${res.status}`);
    return body || {};
  } finally {
    clearTimeout(timer);
  }
}

// --- YouTube (Data API v3) --------------------------------------------------
// search.list finds channels by query; channels.list then fetches description +
// stats (search snippets are thin). One channels.list call batches up to 50 ids.
export async function discoverYouTube(query, { apiKey, max = 10, fetchImpl = fetch, regionCode } = {}) {
  if (!apiKey) return { source: "youtube", skipped: "YOUTUBE_API_KEY 없음", candidates: [] };
  const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
  searchUrl.search = new URLSearchParams({
    part: "snippet",
    q: query,
    type: "channel",
    maxResults: String(Math.min(50, max)),
    key: apiKey,
    ...(regionCode ? { regionCode } : {}),
  }).toString();

  const search = await getJson(searchUrl.toString(), { fetchImpl });
  const ids = (search.items || []).map((i) => i.snippet?.channelId || i.id?.channelId).filter(Boolean);
  if (!ids.length) return { source: "youtube", candidates: [] };

  const chUrl = new URL("https://www.googleapis.com/youtube/v3/channels");
  chUrl.search = new URLSearchParams({
    part: "snippet,statistics,contentDetails",
    id: ids.join(","),
    key: apiKey,
    maxResults: "50",
  }).toString();
  const channels = await getJson(chUrl.toString(), { fetchImpl });

  const candidates = [];
  for (const item of channels.items || []) {
    let recentTitles = [];
    const uploads = item.contentDetails?.relatedPlaylists?.uploads;
    if (uploads) {
      try {
        const plUrl = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
        plUrl.search = new URLSearchParams({ part: "snippet", playlistId: uploads, maxResults: "8", key: apiKey }).toString();
        const pl = await getJson(plUrl.toString(), { fetchImpl });
        recentTitles = (pl.items || []).map((p) => p.snippet?.title).filter(Boolean);
      } catch {
        /* recent titles are optional */
      }
    }
    candidates.push({
      source: "youtube",
      platform: "YouTube",
      externalId: item.id,
      channelName: item.snippet?.title || "",
      handle: item.snippet?.customUrl || "",
      url: `https://www.youtube.com/channel/${item.id}`,
      description: item.snippet?.description || "",
      recentTitles,
      links: [],
      subscribers: Number(item.statistics?.subscriberCount || 0),
    });
  }
  return { source: "youtube", candidates };
}

// --- Twitch (Helix) ---------------------------------------------------------
// Needs an app access token (client-credentials grant). search/channels gives
// the broadcaster; users gives the channel description ("About").
export async function discoverTwitch(query, { clientId, clientSecret, appToken, max = 10, fetchImpl = fetch } = {}) {
  if (!clientId || (!clientSecret && !appToken)) {
    return { source: "twitch", skipped: "TWITCH_CLIENT_ID/SECRET 없음", candidates: [] };
  }
  let token = appToken;
  if (!token) {
    const tok = await postForm("https://id.twitch.tv/oauth2/token", {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }, { fetchImpl });
    token = tok.access_token;
  }
  const headers = { "Client-Id": clientId, Authorization: `Bearer ${token}` };

  const searchUrl = `https://api.twitch.tv/helix/search/channels?query=${encodeURIComponent(query)}&first=${Math.min(100, max)}`;
  const search = await getJson(searchUrl, { fetchImpl, headers });
  const items = (search.data || []).slice(0, max);
  const ids = items.map((i) => i.id).filter(Boolean);

  // users endpoint carries the long-form description + offline metadata.
  let userById = new Map();
  if (ids.length) {
    const usersUrl = `https://api.twitch.tv/helix/users?${ids.map((id) => `id=${id}`).join("&")}`;
    try {
      const users = await getJson(usersUrl, { fetchImpl, headers });
      userById = new Map((users.data || []).map((u) => [u.id, u]));
    } catch {
      /* description is optional */
    }
  }

  const candidates = items.map((i) => {
    const u = userById.get(i.id);
    return {
      source: "twitch",
      platform: "Twitch",
      externalId: i.id,
      channelName: i.display_name || i.broadcaster_login || "",
      handle: i.broadcaster_login || "",
      url: `https://www.twitch.tv/${i.broadcaster_login || ""}`,
      description: u?.description || i.title || "",
      recentTitles: i.title ? [i.title] : [],
      links: [],
      subscribers: 0, // Helix doesn't expose follower count without a scoped token.
    };
  });
  return { source: "twitch", candidates };
}

// --- Web search (Brave or SerpAPI) ------------------------------------------
// A general-web fan-out for blogs / niche sites / creators the platform APIs
// miss. Returns lightweight candidates (url + snippet); enrich() scrapes them.
export async function discoverWeb(query, { provider, apiKey, max = 10, fetchImpl = fetch } = {}) {
  if (!apiKey || !provider) return { source: "web", skipped: "WEB_SEARCH_PROVIDER/API_KEY 없음", candidates: [] };

  let results = [];
  if (provider === "brave") {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(20, max)}`;
    const body = await getJson(url, { fetchImpl, headers: { "X-Subscription-Token": apiKey } });
    results = (body.web?.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.description || "" }));
  } else if (provider === "serpapi") {
    const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&num=${Math.min(20, max)}&api_key=${apiKey}`;
    const body = await getJson(url, { fetchImpl });
    results = (body.organic_results || []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet || "" }));
  } else {
    return { source: "web", skipped: `알 수 없는 provider: ${provider}`, candidates: [] };
  }

  const candidates = results.slice(0, max).map((r) => ({
    source: "web",
    platform: "Web",
    externalId: r.url,
    channelName: r.title || r.url,
    handle: "",
    url: r.url,
    description: r.snippet || "",
    recentTitles: [],
    links: [r.url],
    subscribers: 0,
  }));
  return { source: "web", candidates };
}

// Run every configured source for one query and merge. Sources that are not
// configured contribute a `skipped` note (surfaced to the caller) and no rows.
// One failing source is logged into `errors` but never aborts the others.
export async function discoverAll(query, config = {}) {
  const tasks = [
    discoverYouTube(query, config.youtube || {}),
    discoverTwitch(query, config.twitch || {}),
    discoverWeb(query, config.web || {}),
  ];
  const settled = await Promise.allSettled(tasks);
  const candidates = [];
  const skipped = [];
  const errors = [];
  for (const r of settled) {
    if (r.status === "fulfilled") {
      candidates.push(...(r.value.candidates || []));
      if (r.value.skipped) skipped.push(`${r.value.source}: ${r.value.skipped}`);
    } else {
      errors.push(String(r.reason?.message || r.reason));
    }
  }
  return { query, candidates, skipped, errors };
}
