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

import { discoverAll, fetchYoutubeFeatured, fetchYoutubeChannelsByIds } from "./sources.mjs";
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
      const e = await enrichCandidate(c, { fetchImpl: config.fetchImpl, renderImpl: config.renderImpl, signal: config.signal });
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
        subscribers: c.subscribers,
        country: c.country,
        metrics: c.metrics,
        ...(gameContext ? { gameContext } : {}),
        signal: config.signal,
      });
      record.email = a.email || record.scrapedEmail || "";
      record.channelType = a.channelType;
      record.audience = a.audience;
      record.contentTone = a.contentTone;
      record.languages = a.languages;
      record.fitScore = a.fitScore;
      record.fitReason = a.fitReason;
      record.pitchAngle = a.pitchAngle;
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
    skipKnown = true, // already-in-roster creators are skipped entirely (not analyzed/queued)
    expandCount = 0,
    leadDepth = 0,
    maxAnalyze = 60,
    maxSearches = Infinity,
    deadline = Infinity,
    now = () => Date.now(),
    shouldStop = () => false,
    onProgress = () => {},
  } = opts;

  const seedList = (Array.isArray(seeds) ? seeds : [seeds]).map((s) => String(s).trim()).filter(Boolean);
  if (!seedList.length) throw new Error("검색 시드(키워드)가 최소 한 개 필요합니다.");

  // `active` is false once the deadline passes OR a stop is requested — checked
  // frequently (between searches and between candidates) so a stop bails fast.
  const active = () => now() < deadline && !shouldStop();
  const timeLeft = active;
  const yt = config.youtube || {};
  const seenSeeds = new Set();
  const seenChannelIds = new Set(); // dedupe channels across search + graph crawl
  const queue = []; // { query, depth } | { ids, depth, viaName }
  const enqueueQuery = (query, depth) => {
    const key = String(query).trim().toLowerCase();
    if (!key || seenSeeds.has(key)) return;
    seenSeeds.add(key);
    queue.push({ query: String(query).trim(), depth });
  };
  // Graph-expansion leads: resolve channel IDs WITHOUT a 100-unit search.list.
  const enqueueIds = (ids, depth, viaName) => {
    const novel = (ids || []).filter((id) => id && !seenChannelIds.has(id));
    novel.forEach((id) => seenChannelIds.add(id));
    if (novel.length) queue.push({ ids: novel, depth, viaName });
  };

  for (const s of seedList) enqueueQuery(s, 0);

  // Optional: gemma proposes extra starting queries before we begin searching.
  if (expandCount > 0 && analyze && timeLeft()) {
    try {
      onProgress("질의 확장 (gemma)…");
      const extra = await expandSeeds({ gameContext: gameContext || "", existingSeeds: seedList, count: expandCount, signal: config.signal });
      for (const q of extra) enqueueQuery(q, 0);
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
  let searched = 0;
  let knownSkipped = 0;
  let quotaHit = false; // a source hit its daily/rate quota → stop, don't hammer it

  while (queue.length && timeLeft()) {
    const item = queue.shift();
    const depth = item.depth || 0;
    let candidates = [];

    if (item.ids) {
      // FREE graph expansion: resolve featured/neighbour channel IDs (1 unit/50).
      onProgress(`이웃 채널 ${item.ids.length}개 확인${item.viaName ? ` (← ${item.viaName})` : ""}`);
      try {
        candidates = await fetchYoutubeChannelsByIds(item.ids, { apiKey: yt.apiKey, fetchImpl: yt.fetchImpl, signal: config.signal });
      } catch (err) {
        errors.push(String(err?.message || err));
        if (/quota|rate.?limit|exceeded/i.test(String(err?.message || err))) {
          quotaHit = true;
          break;
        }
        continue;
      }
    } else {
      if (searched >= maxSearches) continue; // out of search budget — still drain id-leads
      onProgress(`검색: "${item.query}"${depth ? ` (lead d${depth})` : ""}`);
      searched += 1;
      let found;
      try {
        found = await discoverAll(item.query, {
          signal: config.signal,
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
      // Quota/rate-limit exhausted → bail; don't spam a dead API or burn gemma.
      if ((found.errors || []).some((e) => /quota|rate.?limit|exceeded|dailyLimit|userRateLimit/i.test(String(e)))) {
        quotaHit = true;
        onProgress("API 할당량 초과 — 검색 중단");
        break;
      }
      candidates = found.candidates;
    }

    rawFound += candidates.length;

    // Only process candidates we haven't already handled this run.
    let fresh = dedupeCandidates(candidates).filter((c) => !resultsByKey.has(candidateKey(c)));
    fresh = markKnown(fresh, knownProfiles);
    // Highest-subscriber, unknown-first; protects the analyze budget for the best.
    fresh.sort((a, b) => Number(a.isKnown) - Number(b.isKnown) || (b.subscribers || 0) - (a.subscribers || 0));

    for (const c of fresh) {
      if (!timeLeft()) break;
      if (c.externalId) seenChannelIds.add(c.externalId);
      // Already in our creator roster → skip entirely (no analyze, no queue). We
      // still recorded its channelId above so graph expansion won't revisit it.
      if (skipKnown && c.isKnown) {
        knownSkipped += 1;
        continue;
      }
      const willAnalyze = analyze && analyzed < maxAnalyze;
      if (willAnalyze) onProgress(`분석: ${c.channelName || c.url}`);
      const record = await processCandidate(c, { config, gameContext, analyze: willAnalyze, enrich });
      record.leadDepth = depth;
      if (willAnalyze) analyzed += 1;
      resultsByKey.set(candidateKey(c), record);

      // Follow the lead from a strong, fresh creator.
      if (leadDepth > 0 && depth < leadDepth && willAnalyze && !record.isKnown && (record.fitScore || 0) >= 55 && timeLeft()) {
        // 1) FREE: crawl the channels this creator FEATURES (no search.list).
        if (c.platform === "YouTube" && c.externalId && yt.apiKey) {
          try {
            const featured = await fetchYoutubeFeatured(c.externalId, { apiKey: yt.apiKey, fetchImpl: yt.fetchImpl, signal: config.signal });
            const before = queue.length;
            enqueueIds(featured, depth + 1, record.channelName);
            const added = queue.length - before;
            if (added) onProgress(`추천채널 +${added} (← ${record.channelName})`);
          } catch {
            /* featured channels are best-effort */
          }
        }
        // 2) gemma lead queries — only when search budget remains (these cost 100u).
        if (searched < maxSearches) {
          try {
            const leads = await proposeLeads({
              channelName: record.channelName,
              channelType: record.channelType,
              audience: record.audience,
              contentTone: record.contentTone,
              recentTitles: record.recentTitles,
              signal: config.signal,
            });
            for (const q of leads) enqueueQuery(q, depth + 1);
            if (leads.length) onProgress(`단서 검색어 +${leads.length} (← ${record.channelName})`);
          } catch {
            /* lead generation is best-effort */
          }
        }
      }
    }
  }

  const all = [...resultsByKey.values()];
  const kept = all.filter((c) => c.status === "error" || (c.fitScore || 0) >= minFitScore);
  kept.sort((a, b) => (b.fitScore || 0) - (a.fitScore || 0));

  return {
    stats: {
      seedsSearched: searched,
      rawFound,
      processed: all.length,
      analyzed,
      kept: kept.length,
      withEmail: kept.filter((c) => c.email).length,
      newCreators: kept.filter((c) => !c.isKnown).length,
      knownSkipped,
      timedOut: queue.length > 0 && !timeLeft(),
      pendingQueries: queue.length,
      quotaHit,
      searched,
    },
    skipped: [...skipped],
    errors,
    candidates: kept,
  };
}
