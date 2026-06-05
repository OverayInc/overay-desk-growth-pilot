import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractEmails,
  pickBusinessEmail,
  extractUrls,
  rankLinksForContact,
  htmlToText,
} from "../src/discovery/enrich.mjs";
import { candidateKey, dedupeCandidates, markKnown } from "../src/discovery/pipeline.mjs";
import { normalizeCreatorAnalysis } from "../src/marketingAgent.mjs";
import { discoverySeeds, discoveryConfigFromEnv } from "../src/discovery/config.mjs";

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
