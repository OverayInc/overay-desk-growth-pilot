// Discovery — orchestration (hybrid, time-boxed).
//
// Backbone is deterministic; gemma is "in the loop" only to propose the next
// search queries (expandSeeds) and to chase a found creator's niche
// (proposeLeads). gemma never drives tools directly.
//
// A run keeps going — expanding seeds and following leads — until either its
// work queue drains or a wall-clock DEADLINE is reached. That makes "run for
// 30m / 1h / until 9am" a first-class mode: pass a deadline and it fills the
// time productively instead of doing one fixed pass.
//
// This module NEVER sends email. Output is a list of structured candidates for
// human review → manual upsert into creatorProfiles. Sending stays manual.

import { discoverAll } from "./sources.mjs";
import { enrichCandidate } from "./enrich.mjs";
import { analyzeCreatorChannel, expandSeeds, proposeLeads } from "../marketingAgent.mjs";

// Stable identity for a raw candidate, used to dedupe within a run and against
// already-known creators. Platform+externalId is the strongest key; URL/name
// are fallbacks for web hits that have no platform id.
export function candidateKey(c) {
  if (c.platform && c.externalId) return `${c.platform}:${c.externalId}`.toLowerCase();
  if (c.url) return c.url.toLowerCase().replace(/\/+$/, "");
  return `${c.platform || "?"}:${(c.channelName || "").toLowerCase()}`;
}

// Collapse duplicate candidates (same channel found via multiple seeds/sources),
// keeping the richest record. Two records merge when they share a key. The
// first-seen source order wins for scalar fields.
export function dedupeCandidates(candidates) {
  const byKey = new Map();
  for (const c of candidates) {
    const key = candidateKey(c);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...c, sources: [c.source] });
      continue;
    }
    if ((c.description || "").length > (existing.description || "").length) existing.description = c.description;
    existing.recentTitles = [...new Set([...(existing.recentTitles || []), ...(c.recentTitles || [])])];
    existing.links = [...new Set([...(existing.links || []), ...(c.links || [])])];
    existing.subscribers = Math.max(existing.subscribers || 0, c.subscribers || 0);
    if (!existing.sources.includes(c.source)) existing.sources.push(c.source);
  }
  return [...byKey.values()];
}

// Mark which candidates are already in our roster (by externalId, url, or email)
// so the caller can show "new" vs "known" and skip re-contacting.
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

// Process ONE raw candidate: enrich (scrape + optional render) then analyze
// (gemma). Returns the candidate enriched with email/fit fields and a status.
async function processCandidate(c, { config, gameContext, analyze, enrich }) {
  const record = { ...c };
  try {
    if (enrich) {
      const e = await enrichCandidate(c, { fetchImpl: config.fetchImpl, renderImpl: config.renderImpl });
      record.scrapedText = e.scrapedText;
      record.scrapedEmail = e.scrapedEmail;
      record.scrapedUrls = e.scrapedUrls;
    }
    if (analyze) {
      const a = await analyzeCreatorChannel({
        channelName: c.channelName,
        platform: c.platform,
        description: c.description,
        recentTitles: c.recentTitles,
        scrapedText: record.scrapedText || "",
        ...(gameContext ? { gameContext } : {}),
      });
      record.email = a.email || record.scrapedEmail || "";
      record.channelType = a.channelType;
      record.audience = a.audience;
      record.contentTone = a.contentTone;
      record.languages = a.languages;
      record.fitScore = a.fitScore;
      record.fitReason = a.fitReason;
      record.tags = a.tags;
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
  return record;
}

// Run the discovery pipeline.
//
// opts:
//   config        — { youtube, twitch, web, fetchImpl?, renderImpl? }
//   gameContext   — string passed to analyzer + seed/lead generators
//   knownProfiles — existing creatorProfiles, to flag duplicates
//   perSeed       — candidates kept per seed query
//   minFitScore   — drop analyzed candidates below this
//   enrich/analyze— stage toggles (analyze:false = retrieval-only dry run)
//   expandCount   — ask gemma for this many extra seed queries (0 = off)
//   leadDepth     — follow-the-lead hops from a found creator's niche (0 = off)
//   maxAnalyze    — hard cap on gemma analyze calls (protects single GPU)
//   deadline      — ms-epoch wall-clock stop; run keeps working until then
//   now           — injectable clock (defaults Date.now) for testing
//   onProgress    — (msg) => void
//
// Returns { stats, skipped[], errors[], candidates[] }.
export async function runDiscovery(seeds, opts = {}) {
  const {
    config = {},
    gameContext,
    knownProfiles = [],
    perSeed = 8,
    minFitScore = 0,
    enrich = true,
    analyze = true,
    expandCount = 0,
    leadDepth = 0,
    maxAnalyze = 60,
    deadline = Infinity,
    now = () => Date.now(),
    onProgress = () => {},
  } = opts;

  const seedList = (Array.isArray(seeds) ? seeds : [seeds]).map((s) => String(s).trim()).filter(Boolean);
  if (!seedList.length) throw new Error("검색 시드(키워드)가 최소 한 개 필요합니다.");

  const timeLeft = () => now() < deadline;
  const seenSeeds = new Set();
  const queue = []; // { query, depth }
  const enqueue = (query, depth) => {
    const key = String(query).trim().toLowerCase();
    if (!key || seenSeeds.has(key)) return;
    seenSeeds.add(key);
    queue.push({ query: String(query).trim(), depth });
  };

  for (const s of seedList) enqueue(s, 0);

  // Optional: gemma proposes extra starting queries before we begin searching.
  if (expandCount > 0 && analyze && timeLeft()) {
    try {
      onProgress("질의 확장 (gemma)…");
      const extra = await expandSeeds({ gameContext: gameContext || "", existingSeeds: seedList, count: expandCount });
      for (const q of extra) enqueue(q, 0);
      if (extra.length) onProgress(`확장 시드 +${extra.length}`);
    } catch (err) {
      onProgress(`질의 확장 실패: ${err?.message || err}`);
    }
  }

  const resultsByKey = new Map(); // candidateKey -> processed record
  const skipped = new Set();
  const errors = [];
  let rawFound = 0;
  let analyzed = 0;

  while (queue.length && timeLeft()) {
    const { query, depth } = queue.shift();
    onProgress(`검색: "${query}"${depth ? ` (lead d${depth})` : ""}`);

    let found;
    try {
      found = await discoverAll(query, {
        youtube: { max: perSeed, ...(config.youtube || {}) },
        twitch: { max: perSeed, ...(config.twitch || {}) },
        web: { max: perSeed, ...(config.web || {}) },
      });
    } catch (err) {
      errors.push(String(err?.message || err));
      continue;
    }
    for (const s of found.skipped || []) skipped.add(s);
    errors.push(...(found.errors || []));
    rawFound += found.candidates.length;

    // Only process candidates we haven't already handled this run.
    let fresh = dedupeCandidates(found.candidates).filter((c) => !resultsByKey.has(candidateKey(c)));
    fresh = markKnown(fresh, knownProfiles);
    // Highest-subscriber, unknown-first; protects the analyze budget for the best.
    fresh.sort((a, b) => Number(a.isKnown) - Number(b.isKnown) || (b.subscribers || 0) - (a.subscribers || 0));

    for (const c of fresh) {
      if (!timeLeft()) break;
      const willAnalyze = analyze && analyzed < maxAnalyze;
      if (willAnalyze) onProgress(`분석: ${c.channelName || c.url}`);
      const record = await processCandidate(c, { config, gameContext, analyze: willAnalyze, enrich });
      record.seedQuery = query;
      record.leadDepth = depth;
      if (willAnalyze) analyzed += 1;
      resultsByKey.set(candidateKey(c), record);

      // Follow the lead: a strong, fresh creator seeds the next hop's queries.
      if (leadDepth > 0 && depth < leadDepth && willAnalyze && !record.isKnown && (record.fitScore || 0) >= 60 && timeLeft()) {
        try {
          const leads = await proposeLeads({
            channelName: record.channelName,
            channelType: record.channelType,
            audience: record.audience,
            contentTone: record.contentTone,
            recentTitles: record.recentTitles,
          });
          for (const q of leads) enqueue(q, depth + 1);
          if (leads.length) onProgress(`단서 +${leads.length} (from ${record.channelName})`);
        } catch {
          /* lead generation is best-effort */
        }
      }
    }
  }

  const all = [...resultsByKey.values()];
  const kept = all.filter((c) => c.status === "error" || (c.fitScore || 0) >= minFitScore);
  kept.sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));

  return {
    stats: {
      seedsSearched: seenSeeds.size,
      rawFound,
      processed: all.length,
      analyzed,
      kept: kept.length,
      withEmail: kept.filter((c) => c.email).length,
      newCreators: kept.filter((c) => !c.isKnown).length,
      timedOut: queue.length > 0 && !timeLeft(),
      pendingQueries: queue.length,
    },
    skipped: [...skipped],
    errors,
    candidates: kept,
  };
}
