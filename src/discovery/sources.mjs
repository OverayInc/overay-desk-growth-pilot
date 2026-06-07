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

// Build an AbortSignal that fires on EITHER the timeout or an external stop.
function combinedSignal(timeoutMs, external) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return external ? AbortSignal.any([timeout, external]) : timeout;
}

async function getJson(url, { fetchImpl = fetch, headers = {}, timeoutMs = 15000, signal } = {}) {
  const res = await fetchImpl(url, { headers: { Accept: "application/json", ...headers }, signal: combinedSignal(timeoutMs, signal) });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.error?.message || body?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body || {};
}

async function postForm(url, form, { fetchImpl = fetch, headers = {}, timeoutMs = 15000, signal } = {}) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(form).toString(),
    signal: combinedSignal(timeoutMs, signal),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error_description || body?.error || body?.message || `HTTP ${res.status}`);
  return body || {};
}

// --- YouTube (Data API v3) --------------------------------------------------
// Cost model (quota units): search.list = 100 (expensive!), channels.list = 1,
// playlistItems.list = 1, videos.list = 1, channelSections.list = 1. So we spend
// search.list sparingly (seeds only) and go DEEP/WIDE with the 1-unit endpoints:
// per-channel video metrics + featured-channel graph crawl.
const YT = "https://www.googleapis.com/youtube/v3";

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

// Compute real performance metrics from a channel's recent uploads.
function computeVideoMetrics(videos) {
  const views = videos.map((v) => Number(v.statistics?.viewCount || 0));
  const likes = videos.map((v) => Number(v.statistics?.likeCount || 0));
  const comments = videos.map((v) => Number(v.statistics?.commentCount || 0));
  const dates = videos.map((v) => v.snippet?.publishedAt).filter(Boolean).map((d) => new Date(d).getTime());
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const avgViews = views.length ? Math.round(sum(views) / views.length) : 0;
  const totalViews = sum(views);
  const engagementRate = totalViews ? Number((((sum(likes) + sum(comments)) / totalViews) * 100).toFixed(2)) : 0;
  let uploadsPerMonth = 0;
  let lastUploadAt = "";
  if (dates.length) {
    lastUploadAt = new Date(Math.max(...dates)).toISOString();
    const spanDays = (Math.max(...dates) - Math.min(...dates)) / 86_400_000;
    uploadsPerMonth = spanDays > 0 ? Number(((dates.length / spanDays) * 30).toFixed(1)) : dates.length;
  }
  return {
    avgViews,
    medianViews: median(views),
    avgLikes: likes.length ? Math.round(sum(likes) / likes.length) : 0,
    avgComments: comments.length ? Math.round(sum(comments) / comments.length) : 0,
    engagementRate,
    uploadsPerMonth,
    lastUploadAt,
    sampledVideos: videos.length,
  };
}

// Turn channels.list items into rich candidates: real titles + view/engagement
// metrics from each channel's recent uploads (playlistItems 1u + videos 1u each).
async function buildYoutubeCandidates(items, { apiKey, fetchImpl, signal, withMetrics = true, perChannel = 12 }) {
  const out = [];
  for (const item of items || []) {
    if (signal?.aborted) break;
    const uploads = item.contentDetails?.relatedPlaylists?.uploads;
    let recentTitles = [];
    let metrics = {};
    if (uploads) {
      try {
        const plUrl = new URL(`${YT}/playlistItems`);
        plUrl.search = new URLSearchParams({ part: "contentDetails", playlistId: uploads, maxResults: String(perChannel), key: apiKey }).toString();
        const pl = await getJson(plUrl.toString(), { fetchImpl, signal });
        const videoIds = (pl.items || []).map((p) => p.contentDetails?.videoId).filter(Boolean);
        if (videoIds.length && withMetrics) {
          const vUrl = new URL(`${YT}/videos`);
          vUrl.search = new URLSearchParams({ part: "snippet,statistics", id: videoIds.join(","), key: apiKey }).toString();
          const vids = await getJson(vUrl.toString(), { fetchImpl, signal });
          recentTitles = (vids.items || []).map((v) => v.snippet?.title).filter(Boolean);
          metrics = computeVideoMetrics(vids.items || []);
        }
      } catch {
        /* metrics are best-effort */
      }
    }
    out.push({
      source: "youtube",
      platform: "YouTube",
      externalId: item.id,
      channelName: item.snippet?.title || "",
      handle: item.snippet?.customUrl || "",
      url: `https://www.youtube.com/channel/${item.id}`,
      description: item.snippet?.description || "",
      country: item.snippet?.country || "",
      recentTitles,
      links: [],
      subscribers: Number(item.statistics?.subscriberCount || 0),
      totalViews: Number(item.statistics?.viewCount || 0),
      videoCount: Number(item.statistics?.videoCount || 0),
      uploadsPlaylistId: uploads || "",
      metrics,
    });
  }
  return out;
}

// Resolve channel IDs into candidates WITHOUT a search.list (1 unit / 50 ids).
// This is how graph expansion (featured channels, mentions) stays quota-cheap.
export async function fetchYoutubeChannelsByIds(ids, { apiKey, fetchImpl = fetch, signal, withMetrics = true } = {}) {
  const unique = [...new Set((ids || []).filter(Boolean))].slice(0, 50);
  if (!apiKey || !unique.length) return [];
  const chUrl = new URL(`${YT}/channels`);
  chUrl.search = new URLSearchParams({ part: "snippet,statistics,contentDetails", id: unique.join(","), key: apiKey, maxResults: "50" }).toString();
  const channels = await getJson(chUrl.toString(), { fetchImpl, signal });
  return buildYoutubeCandidates(channels.items, { apiKey, fetchImpl, signal, withMetrics });
}

// The channels a creator FEATURES on their page (channelSections, 1 unit) — a
// hand-curated "similar creators" graph we can crawl instead of paying 100 units
// per search. Returns channel IDs.
export async function fetchYoutubeFeatured(channelId, { apiKey, fetchImpl = fetch, signal } = {}) {
  if (!apiKey || !channelId) return [];
  try {
    const url = new URL(`${YT}/channelSections`);
    url.search = new URLSearchParams({ part: "contentDetails", channelId, key: apiKey }).toString();
    const data = await getJson(url.toString(), { fetchImpl, signal });
    const ids = new Set();
    for (const sec of data.items || []) {
      for (const cid of sec.contentDetails?.channels || []) ids.add(cid);
    }
    return [...ids];
  } catch {
    return [];
  }
}

// search.list (100 units) finds SEED channels by query; then we enrich with the
// cheap endpoints above. Used sparingly — graph expansion does the rest.
export async function discoverYouTube(query, { apiKey, max = 10, fetchImpl = fetch, regionCode, signal } = {}) {
  if (!apiKey) return { source: "youtube", skipped: "YOUTUBE_API_KEY 없음", candidates: [] };
  const searchUrl = new URL(`${YT}/search`);
  searchUrl.search = new URLSearchParams({
    part: "snippet",
    q: query,
    type: "channel",
    maxResults: String(Math.min(50, max)),
    key: apiKey,
    ...(regionCode ? { regionCode } : {}),
  }).toString();

  const search = await getJson(searchUrl.toString(), { fetchImpl, signal });
  const ids = (search.items || []).map((i) => i.snippet?.channelId || i.id?.channelId).filter(Boolean);
  if (!ids.length) return { source: "youtube", candidates: [] };

  const candidates = await fetchYoutubeChannelsByIds(ids, { apiKey, fetchImpl, signal });
  return { source: "youtube", candidates };
}

// --- Twitch (Helix) ---------------------------------------------------------
// Needs an app access token (client-credentials grant). search/channels gives
// the broadcaster; users gives the channel description ("About").
export async function discoverTwitch(query, { clientId, clientSecret, appToken, max = 10, fetchImpl = fetch, signal } = {}) {
  if (!clientId || (!clientSecret && !appToken)) {
    return { source: "twitch", skipped: "TWITCH_CLIENT_ID/SECRET 없음", candidates: [] };
  }
  let token = appToken;
  if (!token) {
    const tok = await postForm("https://id.twitch.tv/oauth2/token", {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }, { fetchImpl, signal });
    token = tok.access_token;
  }
  const headers = { "Client-Id": clientId, Authorization: `Bearer ${token}` };

  const searchUrl = `https://api.twitch.tv/helix/search/channels?query=${encodeURIComponent(query)}&first=${Math.min(100, max)}`;
  const search = await getJson(searchUrl, { fetchImpl, headers, signal });
  const items = (search.data || []).slice(0, max);
  const ids = items.map((i) => i.id).filter(Boolean);

  // users endpoint carries the long-form description + offline metadata.
  let userById = new Map();
  if (ids.length) {
    const usersUrl = `https://api.twitch.tv/helix/users?${ids.map((id) => `id=${id}`).join("&")}`;
    try {
      const users = await getJson(usersUrl, { fetchImpl, headers, signal });
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
export async function discoverWeb(query, { provider, apiKey, max = 10, fetchImpl = fetch, signal } = {}) {
  if (!apiKey || !provider) return { source: "web", skipped: "WEB_SEARCH_PROVIDER/API_KEY 없음", candidates: [] };

  let results = [];
  if (provider === "brave") {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(20, max)}`;
    const body = await getJson(url, { fetchImpl, headers: { "X-Subscription-Token": apiKey }, signal });
    results = (body.web?.results || []).map((r) => ({ title: r.title, url: r.url, snippet: r.description || "" }));
  } else if (provider === "serpapi") {
    const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(query)}&num=${Math.min(20, max)}&api_key=${apiKey}`;
    const body = await getJson(url, { fetchImpl, signal });
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
  const signal = config.signal;
  const tasks = [
    discoverYouTube(query, { ...(config.youtube || {}), signal }),
    discoverTwitch(query, { ...(config.twitch || {}), signal }),
    discoverWeb(query, { ...(config.web || {}), signal }),
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
