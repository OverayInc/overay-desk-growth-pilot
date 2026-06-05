// Discovery — orchestration.
//
// Ties the layers together for one run:
//   seeds → discoverAll (retrieval) → dedupe → enrich (scrape) → analyze (gemma4)
//   → discovered candidates (status "discovered", NOT contacted).
//
// This module NEVER sends email. Its only output is a list of structured
// candidates ready to be reviewed by a human and upserted into creatorProfiles.
// Sending stays behind the existing manual contact queue by design.

import { discoverAll } from "./sources.mjs";
import { enrichCandidate } from "./enrich.mjs";
import { analyzeCreatorChannel } from "../marketingAgent.mjs";

// Stable identity for a raw candidate, used to dedupe within a run and against
// already-known creators. Platform+externalId is the strongest key; URL/name
// are fallbacks for web hits that have no platform id.
export function candidateKey(c) {
  if (c.platform && c.externalId) return `${c.platform}:${c.externalId}`.toLowerCase();
  if (c.url) return c.url.toLowerCase().replace(/\/+$/, "");
  return `${c.platform || "?"}:${(c.channelName || "").toLowerCase()}`;
}

// Collapse duplicate candidates (same channel found via multiple seeds/sources),
// keeping the richest record. Two records merge when they share a key OR when an
// email matches. The first-seen source order wins for scalar fields.
export function dedupeCandidates(candidates) {
  const byKey = new Map();
  for (const c of candidates) {
    const key = candidateKey(c);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...c, sources: [c.source] });
      continue;
    }
    // Merge: keep longer description, union recentTitles/links, remember sources.
    if ((c.description || "").length > (existing.description || "").length) existing.description = c.description;
    existing.recentTitles = [...new Set([...(existing.recentTitles || []), ...(c.recentTitles || [])])];
    existing.links = [...new Set([...(existing.links || []), ...(c.links || [])])];
    existing.subscribers = Math.max(existing.subscribers || 0, c.subscribers || 0);
    if (!existing.sources.includes(c.source)) existing.sources.push(c.source);
  }
  return [...byKey.values()];
}

// Mark which candidates are already in our roster (by externalId, url, or email)
// so the UI/caller can show "new" vs "known" and skip re-contacting.
export function markKnown(candidates, knownProfiles = []) {
  const ids = new Set();
  const urls = new Set();
  const emails = new Set();
  for (const p of knownProfiles) {
    for (const ch of p.channels || []) if (ch.url) urls.add(ch.url.toLowerCase().replace(/\/+$/, ""));
    if (p.handle) ids.add(String(p.handle).toLowerCase());
    if (p.email) emails.add(String(p.email).toLowerCase());
  }
  return candidates.map((c) => {
    const known =
      (c.url && urls.has(c.url.toLowerCase().replace(/\/+$/, ""))) ||
      (c.handle && ids.has(String(c.handle).toLowerCase())) ||
      (c.email && emails.has(String(c.email).toLowerCase()));
    return { ...c, isKnown: Boolean(known) };
  });
}

// Run the full pipeline over a list of seed queries.
//
// opts:
//   config        — { youtube, twitch, web } source configs (see sources.mjs)
//   gameContext   — string passed to the analyzer for fit scoring
//   knownProfiles — existing creatorProfiles, to flag duplicates
//   perSeed       — max candidates kept per seed before enrich/analyze
//   minFitScore   — drop analyzed candidates below this (default 0 = keep all)
//   enrich        — set false to skip page scraping (faster, no email harvest)
//   analyze       — set false to skip the gemma4 call (retrieval-only dry run)
//   onProgress    — optional (msg) => void for logging
//
// Returns { runAt-less stats, candidates[] } — caller stamps the timestamp
// (the model env forbids Date.now in some contexts; here we use ISO at the edge).
export async function runDiscovery(seeds, opts = {}) {
  const {
    config = {},
    gameContext,
    knownProfiles = [],
    perSeed = 10,
    minFitScore = 0,
    enrich = true,
    analyze = true,
    maxAnalyze = 40,
    onProgress = () => {},
  } = opts;

  const seedList = (Array.isArray(seeds) ? seeds : [seeds]).map((s) => String(s).trim()).filter(Boolean);
  if (!seedList.length) throw new Error("검색 시드(키워드)가 최소 한 개 필요합니다.");

  // 1) Retrieval — fan out every source across every seed.
  const raw = [];
  const skipped = new Set();
  const errors = [];
  for (const seed of seedList) {
    onProgress(`검색: "${seed}"`);
    const result = await discoverAll(seed, {
      youtube: { max: perSeed, ...(config.youtube || {}) },
      twitch: { max: perSeed, ...(config.twitch || {}) },
      web: { max: perSeed, ...(config.web || {}) },
    });
    raw.push(...result.candidates.map((c) => ({ ...c, seed })));
    for (const s of result.skipped || []) skipped.add(s);
    errors.push(...(result.errors || []));
  }

  // 2) Dedupe, then flag already-known creators.
  let candidates = dedupeCandidates(raw);
  candidates = markKnown(candidates, knownProfiles);
  onProgress(`후보 ${candidates.length}명 (중복 제거 후)`);

  // 3) Enrich + analyze. We process known creators last and cap analysis to
  //    protect the single-GPU gemma box from a huge batch in one run.
  candidates.sort((a, b) => Number(a.isKnown) - Number(b.isKnown) || (b.subscribers || 0) - (a.subscribers || 0));

  const out = [];
  let analyzed = 0;
  for (const c of candidates) {
    const record = { ...c };
    try {
      if (enrich) {
        const e = await enrichCandidate(c, { fetchImpl: config.fetchImpl });
        record.scrapedText = e.scrapedText;
        record.scrapedEmail = e.scrapedEmail;
        record.scrapedUrls = e.scrapedUrls;
      }
      if (analyze && analyzed < maxAnalyze) {
        onProgress(`분석: ${c.channelName || c.url}`);
        const a = await analyzeCreatorChannel({
          channelName: c.channelName,
          platform: c.platform,
          description: c.description,
          recentTitles: c.recentTitles,
          scrapedText: record.scrapedText || "",
          ...(gameContext ? { gameContext } : {}),
        });
        // The model's extracted email wins; fall back to the scraped one.
        record.email = a.email || record.scrapedEmail || "";
        record.channelType = a.channelType;
        record.audience = a.audience;
        record.contentTone = a.contentTone;
        record.languages = a.languages;
        record.fitScore = a.fitScore;
        record.fitReason = a.fitReason;
        record.tags = a.tags;
        analyzed += 1;
      } else {
        record.email = record.scrapedEmail || "";
        record.fitScore = 0;
      }
      record.status = "discovered";
      record.error = "";
    } catch (err) {
      record.status = "error";
      record.error = String(err?.message || err);
      record.fitScore = record.fitScore || 0;
    }
    out.push(record);
  }

  const kept = out.filter((c) => c.status === "error" || (c.fitScore || 0) >= minFitScore);
  kept.sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));

  return {
    stats: {
      seeds: seedList.length,
      rawFound: raw.length,
      deduped: candidates.length,
      analyzed,
      kept: kept.length,
      withEmail: kept.filter((c) => c.email).length,
      newCreators: kept.filter((c) => !c.isKnown).length,
    },
    skipped: [...skipped],
    errors,
    candidates: kept,
  };
}
