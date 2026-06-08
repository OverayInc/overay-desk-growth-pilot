import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractEmails,
  pickBusinessEmail,
  extractUrls,
  rankLinksForContact,
  htmlToText,
} from "../src/discovery/enrich.mjs";
import { candidateKey, dedupeCandidates, markKnown, runDiscovery } from "../src/discovery/pipeline.mjs";
import { fetchYoutubeChannelsByIds, fetchYoutubeFeatured } from "../src/discovery/sources.mjs";
import { normalizeCreatorAnalysis, normalizeSeedList } from "../src/marketingAgent.mjs";
import { discoverySeeds, discoveryConfigFromEnv, parseHhmm, discoveryWindow, inWindow, clampSessionMinutes } from "../src/discovery/config.mjs";

// --- enrich: email extraction ----------------------------------------------
test("extractEmails finds a plain address and lowercases it", () => {
  assert.deepEqual(extractEmails("Business: HELLO@Studio.GG for keys"), ["hello@studio.gg"]);
});

test("extractEmails de-obfuscates [at] and (dot)", () => {
  assert.deepEqual(extractEmails("contact me at jane [at] example dot net"), ["jane@example.net"]);
});

test("extractEmails drops image-file and placeholder matches", () => {
  const found = extractEmails("logo@2x.png and foo@example.com and real@studio.io");
  assert.deepEqual(found, ["real@studio.io"]);
});

test("extractEmails dedupes case-insensitively", () => {
  assert.deepEqual(extractEmails("a@b.com A@B.com"), ["a@b.com"]);
});

test("pickBusinessEmail prefers a business address", () => {
  assert.equal(pickBusinessEmail(["me@gmail.com", "business@studio.gg"]), "business@studio.gg");
});

test("pickBusinessEmail falls back to the first when none look business", () => {
  assert.equal(pickBusinessEmail(["me@gmail.com", "alt@gmail.com"]), "me@gmail.com");
});

test("pickBusinessEmail returns '' for empty input", () => {
  assert.equal(pickBusinessEmail([]), "");
});

// --- enrich: urls + html ----------------------------------------------------
test("extractUrls pulls links and strips trailing punctuation", () => {
  assert.deepEqual(extractUrls("see https://linktr.ee/me, and https://x.com/me."), [
    "https://linktr.ee/me",
    "https://x.com/me",
  ]);
});

test("rankLinksForContact drops platform walls and ranks contact pages first", () => {
  const ranked = rankLinksForContact([
    "https://youtube.com/@me",
    "https://twitch.tv/me",
    "https://mysite.com/about",
    "https://linktr.ee/me",
  ]);
  assert.ok(!ranked.includes("https://youtube.com/@me"));
  assert.equal(ranked[0], "https://linktr.ee/me");
  assert.ok(ranked.includes("https://mysite.com/about"));
});

test("htmlToText surfaces mailto targets and strips tags", () => {
  const text = htmlToText('<a href="mailto:biz@studio.gg?subject=hi">Email</a><script>x()</script><p>Hello</p>');
  assert.ok(text.includes("biz@studio.gg"));
  assert.ok(text.includes("Hello"));
  assert.ok(!text.includes("x()"));
});

test("htmlToText decodes @ and . entities used to hide emails", () => {
  assert.ok(extractEmails(htmlToText("name&#64;studio&#46;gg")).includes("name@studio.gg"));
});

// --- pipeline: keys + dedupe ------------------------------------------------
test("candidateKey uses platform:externalId when present", () => {
  assert.equal(candidateKey({ platform: "YouTube", externalId: "UC123" }), "youtube:uc123");
});

test("candidateKey falls back to url", () => {
  assert.equal(candidateKey({ url: "https://site.com/me/" }), "https://site.com/me");
});

test("dedupeCandidates merges the same channel from two sources", () => {
  const merged = dedupeCandidates([
    { source: "youtube", platform: "YouTube", externalId: "UC1", description: "short", recentTitles: ["a"], links: [], subscribers: 10 },
    { source: "web", platform: "YouTube", externalId: "UC1", description: "a much longer description", recentTitles: ["b"], links: ["https://s.com"], subscribers: 5 },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].description, "a much longer description");
  assert.deepEqual(merged[0].recentTitles.sort(), ["a", "b"]);
  assert.deepEqual(merged[0].sources.sort(), ["web", "youtube"]);
  assert.equal(merged[0].subscribers, 10);
});

test("markKnown flags candidates already in the roster by url", () => {
  const known = [{ channels: [{ url: "https://www.youtube.com/channel/UC1" }], email: "", handle: "" }];
  const out = markKnown([{ url: "https://www.youtube.com/channel/UC1/" }, { url: "https://new.com" }], known);
  assert.equal(out[0].isKnown, true);
  assert.equal(out[1].isKnown, false);
});

test("markKnown flags by email match", () => {
  const out = markKnown([{ url: "https://x.com", email: "Biz@Studio.GG" }], [{ email: "biz@studio.gg" }]);
  assert.equal(out[0].isKnown, true);
});

// --- analysis normalizer ----------------------------------------------------
test("normalizeCreatorAnalysis clamps fitScore and keeps fields", () => {
  const a = normalizeCreatorAnalysis({
    email: "BIZ@Studio.GG",
    channelType: " Twitch streamer ",
    fitScore: 142,
    tags: ["horror", "horror", " indie "],
  });
  assert.equal(a.email, "biz@studio.gg");
  assert.equal(a.channelType, "Twitch streamer");
  assert.equal(a.fitScore, 100);
  assert.deepEqual(a.tags, ["horror", "indie"]);
});

test("normalizeCreatorAnalysis drops a malformed email and defaults score", () => {
  const a = normalizeCreatorAnalysis({ email: "not-an-email", fitScore: "n/a" });
  assert.equal(a.email, "");
  assert.equal(a.fitScore, 0);
  assert.deepEqual(a.tags, []);
});

// --- config -----------------------------------------------------------------
test("discoverySeeds honors an explicit list, then env, then default", () => {
  assert.deepEqual(discoverySeeds(["a", "b"]), ["a", "b"]);
  assert.deepEqual(discoverySeeds([], { LP_DISCOVERY_SEEDS: "x | y |  " }), ["x", "y"]);
  assert.ok(discoverySeeds([], {}).length > 0);
});

test("discoveryConfigFromEnv maps env into source configs", () => {
  const cfg = discoveryConfigFromEnv({ YOUTUBE_API_KEY: "k", WEB_SEARCH_PROVIDER: "brave", WEB_SEARCH_API_KEY: "w" });
  assert.equal(cfg.youtube.apiKey, "k");
  assert.equal(cfg.web.provider, "brave");
  assert.equal(cfg.twitch.clientId, "");
});

// --- hybrid: seed-list normalizer -------------------------------------------
test("normalizeSeedList trims, dedupes, drops noise, and caps", () => {
  const out = normalizeSeedList(["  Exit 8  ", "exit 8", "", "x".repeat(200), "관찰 게임"], { max: 5 });
  assert.deepEqual(out, ["Exit 8", "관찰 게임"]);
});

test("normalizeSeedList caps to max", () => {
  assert.equal(normalizeSeedList(["a", "b", "c", "d"], { max: 2 }).length, 2);
});

test("normalizeSeedList tolerates non-array input", () => {
  assert.deepEqual(normalizeSeedList(undefined), []);
  assert.deepEqual(normalizeSeedList("not an array"), []);
});

// --- scheduling window ------------------------------------------------------
test("parseHhmm parses valid times and rejects bad ones", () => {
  assert.equal(parseHhmm("02:00"), 120);
  assert.equal(parseHhmm("09:30"), 570);
  assert.equal(parseHhmm("24:00"), null);
  assert.equal(parseHhmm("9am"), null);
});

test("discoveryWindow defaults to 02:00-09:00 (no crossing)", () => {
  const w = discoveryWindow({});
  assert.equal(w.startMin, 120);
  assert.equal(w.endMin, 540);
  assert.equal(w.crossesMidnight, false);
});

test("inWindow handles a normal window", () => {
  const w = discoveryWindow({ DISCOVERY_WINDOW_START: "02:00", DISCOVERY_WINDOW_END: "09:00" });
  assert.equal(inWindow(3 * 60, w), true); // 03:00 inside
  assert.equal(inWindow(9 * 60, w), false); // 09:00 is the exclusive end
  assert.equal(inWindow(1 * 60, w), false); // 01:00 before
});

test("inWindow handles a midnight-crossing window", () => {
  const w = discoveryWindow({ DISCOVERY_WINDOW_START: "22:00", DISCOVERY_WINDOW_END: "06:00" });
  assert.equal(w.crossesMidnight, true);
  assert.equal(inWindow(23 * 60, w), true); // 23:00 inside
  assert.equal(inWindow(2 * 60, w), true); // 02:00 inside
  assert.equal(inWindow(12 * 60, w), false); // noon outside
});

test("clampSessionMinutes clamps to 5..360 and rejects junk", () => {
  assert.equal(clampSessionMinutes(30), 30);
  assert.equal(clampSessionMinutes(180), 180);
  assert.equal(clampSessionMinutes(1000), 360);
  assert.equal(clampSessionMinutes(2), 5);
  assert.equal(clampSessionMinutes(0), 0);
  assert.equal(clampSessionMinutes("nope"), 0);
});

// --- pipeline: API budget guards -------------------------------------------
test("runDiscovery stops immediately on a quota error", async () => {
  // YouTube returns a 403 quota error → discoverAll records it → pipeline bails.
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    json: async () => ({ error: { message: "Quota exceeded for quota metric 'Search Queries'" } }),
  });
  const res = await runDiscovery(["a", "b", "c"], {
    config: { youtube: { apiKey: "k", fetchImpl } },
    analyze: false,
    enrich: false,
  });
  assert.equal(res.stats.quotaHit, true);
  assert.equal(res.stats.searched, 1); // stopped after the first search, not all 3
});

test("runDiscovery respects maxSearches cap", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ items: [] }) });
  const res = await runDiscovery(["a", "b", "c", "d", "e"], {
    config: { youtube: { apiKey: "k", fetchImpl } },
    analyze: false,
    enrich: false,
    maxSearches: 2,
  });
  assert.equal(res.stats.searched, 2);
  assert.equal(res.stats.quotaHit, false);
});

// --- YouTube cheap-endpoint enrichment + metrics ----------------------------
const ytResp = (body) => ({ ok: true, status: 200, json: async () => body });
function ytFetch(url) {
  const u = String(url);
  if (u.includes("/search")) {
    return ytResp({ items: [{ snippet: { channelId: "UC1" } }] });
  }
  if (u.includes("/channels")) {
    return ytResp({
      items: [
        {
          id: "UC1",
          snippet: { title: "Chan", description: "d", customUrl: "@chan", country: "US" },
          statistics: { subscriberCount: "1000", viewCount: "50000", videoCount: "40" },
          contentDetails: { relatedPlaylists: { uploads: "UU1" } },
        },
      ],
    });
  }
  if (u.includes("/playlistItems")) {
    return ytResp({ items: [{ contentDetails: { videoId: "v1" } }, { contentDetails: { videoId: "v2" } }] });
  }
  if (u.includes("/videos")) {
    return ytResp({
      items: [
        { snippet: { title: "T1", publishedAt: "2026-05-01T00:00:00Z" }, statistics: { viewCount: "1000", likeCount: "100", commentCount: "10" } },
        { snippet: { title: "T2", publishedAt: "2026-05-11T00:00:00Z" }, statistics: { viewCount: "3000", likeCount: "200", commentCount: "20" } },
      ],
    });
  }
  if (u.includes("/channelSections")) {
    return ytResp({ items: [{ contentDetails: { channels: ["UCa", "UCb"] } }, { contentDetails: { channels: ["UCb", "UCc"] } }] });
  }
  return ytResp({ items: [] });
}

test("fetchYoutubeChannelsByIds builds a candidate with real metrics (no search.list)", async () => {
  const cands = await fetchYoutubeChannelsByIds(["UC1"], { apiKey: "k", fetchImpl: ytFetch });
  assert.equal(cands.length, 1);
  const c = cands[0];
  assert.equal(c.subscribers, 1000);
  assert.equal(c.metrics.avgViews, 2000); // (1000+3000)/2
  assert.equal(c.metrics.medianViews, 2000);
  assert.equal(c.metrics.engagementRate, 8.25); // (330/4000)*100
  assert.equal(c.metrics.uploadsPerMonth, 6); // 2 uploads over 10 days → 6/month
  assert.deepEqual(c.recentTitles, ["T1", "T2"]);
});

test("fetchYoutubeFeatured returns deduped featured channel IDs", async () => {
  const ids = await fetchYoutubeFeatured("UC1", { apiKey: "k", fetchImpl: ytFetch });
  assert.deepEqual(ids.sort(), ["UCa", "UCb", "UCc"]);
});

test("runDiscovery skips creators already in the roster (skipKnown)", async () => {
  const known = [{ channels: [{ url: "https://www.youtube.com/channel/UC1" }], email: "", handle: "" }];
  const res = await runDiscovery(["q"], {
    config: { youtube: { apiKey: "k", fetchImpl: ytFetch } },
    knownProfiles: known,
    analyze: false,
    enrich: false,
  });
  assert.equal(res.stats.knownSkipped, 1);
  assert.equal(res.candidates.length, 0);
});

test("runDiscovery keeps the creator when not in the roster", async () => {
  const res = await runDiscovery(["q"], {
    config: { youtube: { apiKey: "k", fetchImpl: ytFetch } },
    knownProfiles: [],
    analyze: false,
    enrich: false,
  });
  assert.equal(res.stats.knownSkipped, 0);
  assert.equal(res.candidates.length, 1);
});
