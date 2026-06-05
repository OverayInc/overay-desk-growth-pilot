// Marketing-copy agent backed by the self-hosted Gemma 4 server.
//
// The model runs on the LAN GPU box (Gemma 4 26B-A4B, NVFP4) behind a vLLM
// OpenAI-compatible API. Default points at the box's current LAN IP — give the
// box a static IP (Proxmox cloud-init / router DHCP reservation) so this stays
// valid, or override LP_AI_BASE_URL. NOTE: the mDNS name (overay.local) works
// from a browser/PowerShell but NOT from Node's fetch (undici) resolver, so we
// use the IP for this server-side call.
//
// Used to draft bilingual (KO/EN) creator-outreach email templates from a
// short brief. Pure helpers (extractJsonObject / normalizeTemplateDraft) are
// exported separately so they can be unit-tested without the network.

const AI_BASE_URL = (process.env.LP_AI_BASE_URL || "http://192.168.50.107:8000/v1").replace(/\/+$/, "");
const AI_MODEL = process.env.LP_AI_MODEL || "gemma-4-26b-a4b";
const AI_API_KEY = process.env.LP_AI_API_KEY || ""; // vLLM ignores auth by default
const AI_TIMEOUT_MS = Number(process.env.LP_AI_TIMEOUT_MS || 60_000);

export function aiConfig() {
  return { baseUrl: AI_BASE_URL, model: AI_MODEL };
}

const TEMPLATE_FIELDS = ["name", "subjectEn", "bodyEn", "subjectKo", "bodyKo"];

// Pull a JSON object out of a model reply, tolerating ```json fences and any
// stray prose around it.
export function extractJsonObject(text) {
  if (typeof text !== "string") throw new Error("AI 응답 형식이 올바르지 않습니다.");
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("AI 응답에서 JSON을 찾지 못했습니다.");
  }
  return JSON.parse(s.slice(start, end + 1));
}

// Coerce a parsed object into a clean template draft with exactly our fields.
export function normalizeTemplateDraft(obj) {
  const out = {};
  for (const field of TEMPLATE_FIELDS) {
    out[field] = typeof obj?.[field] === "string" ? obj[field].trim() : "";
  }
  if (!out.name) out.name = "AI 생성 템플릿";
  if (!out.bodyEn && !out.bodyKo) {
    throw new Error("AI가 본문을 생성하지 못했습니다. 브리프를 더 구체적으로 작성해 보세요.");
  }
  return out;
}

async function chatCompletion(messages, { maxTokens = 1600, temperature = 0.8, jsonMode = true, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  // An external signal (e.g. a discovery-session stop) aborts this call too, so
  // a long gemma request cancels immediately instead of running to completion.
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  let response;
  try {
    response = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(AI_API_KEY ? { Authorization: `Bearer ${AI_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages,
        temperature,
        max_tokens: maxTokens,
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (signal?.aborted) throw new Error("중지되었습니다.");
    if (error?.name === "AbortError") {
      throw new Error(`AI 서버 응답 시간 초과 (${AI_TIMEOUT_MS}ms) — ${AI_BASE_URL}`);
    }
    throw new Error(
      `AI 서버에 연결하지 못했습니다 (${AI_BASE_URL}). gemma4 서버가 켜져 있는지 확인하세요. (${error?.message || error})`,
    );
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onExternalAbort);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error?.message || `AI 서버 오류 (${response.status})`);
  }
  const content = body?.choices?.[0]?.message?.content;
  if (!content) throw new Error("AI 응답이 비어 있습니다.");
  return content;
}

const SYSTEM_PROMPT = `You are an expert bilingual (Korean + English) game-marketing copywriter for Overay Inc. / Immersed Player.
You write influencer & press OUTREACH EMAIL TEMPLATES used to offer free Steam keys to YouTubers, streamers, Steam curators, and press.

Output rules:
- Return ONE JSON object only — no prose, no markdown fences — with EXACTLY these string keys: "name", "subjectEn", "bodyEn", "subjectKo", "bodyKo".
- "name": a short Korean label for the template (e.g. "스트리머 라이브용").
- subject/body are provided in both English (…En) and Korean (…Ko). The two languages must convey the same offer but each read naturally to a native speaker — not a word-for-word translation.
- Use these placeholders verbatim where they fit naturally: {{creator}} {{game}} {{key}} {{utm}} {{embargo}} {{genre}}. Always address the recipient as {{creator}} and refer to the game as {{game}}.
- Tone: warm, concise, no-pressure, easy to say yes to.
- End each body with a signature line — English: "— Immersed Player, Overay Inc." / Korean: "— 오버레이(Overay Inc.) · Immersed Player 팀".
- Use \\n for line breaks inside JSON string values.`;

// Generate a bilingual outreach email template from a short brief.
// Returns { name, subjectEn, bodyEn, subjectKo, bodyKo } (not persisted).
export async function generateEmailTemplate({ brief, gameName = "", genre = "" } = {}) {
  const cleanBrief = String(brief || "").trim();
  if (!cleanBrief) throw new Error("생성할 템플릿 설명(브리프)이 필요합니다.");

  const context = [
    gameName ? `Game: ${gameName}` : "",
    genre ? `Genre: ${genre}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const user = `${context ? context + "\n\n" : ""}Write one outreach email template for this brief:\n${cleanBrief}`;

  const content = await chatCompletion([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ]);

  return normalizeTemplateDraft(extractJsonObject(content));
}

// --- Creator discovery: channel analysis -----------------------------------
// gemma4 is the reasoning layer for the discovery bot. Given raw channel
// metadata + scraped About/link-page text, it extracts a business email (if
// present in the text — we never invent one) and classifies the channel's
// "성격" (type, audience, tone, languages), then scores fit for our game.
// The retrieval layer (YouTube/Twitch/web search + page fetch) lives in
// src/discovery/*; this function only turns a text bundle into structured JSON.

const ANALYSIS_FIELDS = ["email", "channelType", "audience", "contentTone", "languages", "fitReason"];

// Coerce a parsed model object into a clean analysis record. `email` is only
// kept when it actually looks like an email (the model is told to leave it ""
// when none is found in the source text — so we don't fabricate contacts).
export function normalizeCreatorAnalysis(obj) {
  const out = {};
  for (const field of ANALYSIS_FIELDS) {
    out[field] = typeof obj?.[field] === "string" ? obj[field].trim() : "";
  }
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) out.email = "";
  out.email = out.email.toLowerCase();
  out.tags = Array.isArray(obj?.tags)
    ? [...new Set(obj.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 12)
    : [];
  const score = Number(obj?.fitScore);
  out.fitScore = Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0;
  return out;
}

const ANALYSIS_SYSTEM_PROMPT = `You are a games-marketing researcher for Overay Inc. / Immersed Player.
You receive RAW, messy text about ONE content creator/channel: profile metadata, the channel "About" description, recent video/stream titles, and text scraped from any sites the channel links to. Your job is to distill it into one structured record.

Output rules:
- Return ONE JSON object only — no prose, no markdown fences — with EXACTLY these keys:
  "email" (string), "channelType" (string), "audience" (string), "contentTone" (string),
  "languages" (string), "fitScore" (number 0-100), "fitReason" (string), "tags" (array of short strings).
- "email": the channel's BUSINESS/CONTACT email ONLY if it literally appears in the provided text. If no email is present, return "". NEVER guess, complete, or invent an address. Prefer a business/booking/press address over a personal one.
- "channelType": e.g. "YouTube let's-play", "Twitch variety streamer", "Steam curator", "horror-focused YouTuber".
- "audience": who watches (size/region/interest) in one short phrase.
- "contentTone": e.g. "reaction-heavy, comedic", "calm commentary", "scary/immersive".
- "languages": primary content language(s), e.g. "English", "Korean", "EN/KO".
- "fitScore": 0-100, how well this channel fits our game (see context). Higher = better target for free-key outreach.
- "fitReason": one sentence, why that score.
- "tags": a few lowercase keywords (genres/traits) for filtering.
- Base every field ONLY on the provided text. When unsure, use "" or a low fitScore — do not speculate.`;

// Analyze one creator from a text bundle. Returns the normalized analysis.
// `gameContext` describes the game we're scoring fit against (defaults to ours).
export async function analyzeCreatorChannel({
  channelName = "",
  platform = "",
  description = "",
  recentTitles = [],
  scrapedText = "",
  gameContext = "Our game is a first-person observation / 'spot the anomaly' game (Exit 8-like): the player reads a space and catches the one thing that's subtly off. It is very clippable and audience-participatory (chat/comments hunt the anomaly).",
  signal,
} = {}) {
  const titles = Array.isArray(recentTitles) ? recentTitles.filter(Boolean) : [];
  const bundle = [
    `GAME WE ARE SCORING FIT AGAINST:\n${gameContext}`,
    channelName ? `Channel name: ${channelName}` : "",
    platform ? `Platform: ${platform}` : "",
    description ? `About / description:\n${description}` : "",
    titles.length ? `Recent titles:\n- ${titles.slice(0, 15).join("\n- ")}` : "",
    scrapedText ? `Text scraped from linked pages:\n${scrapedText.slice(0, 6000)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const content = await chatCompletion(
    [
      { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
      { role: "user", content: `Analyze this creator and return the JSON record:\n\n${bundle}` },
    ],
    { maxTokens: 800, temperature: 0.2, signal },
  );
  return normalizeCreatorAnalysis(extractJsonObject(content));
}

// --- Creator discovery: query expansion + lead-following --------------------
// The "model-in-the-loop" half of the hybrid bot. gemma does NOT drive tools
// (Gemma tool-calling is unreliable); instead it proposes the next *search
// queries*, and our deterministic pipeline executes them. Single prompt each,
// strict JSON out, so there is no fragile multi-step agent loop.

// Dedupe/clean a list of search-query strings the model returned. Drops blanks,
// dupes (case-insensitive), over-long noise, and caps the count.
export function normalizeSeedList(value, { max = 12 } = {}) {
  const arr = Array.isArray(value) ? value : [];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    const q = String(item || "").trim().replace(/\s+/g, " ");
    if (!q || q.length > 80) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= max) break;
  }
  return out;
}

const SEED_SYSTEM_PROMPT = `You generate SEARCH QUERIES for finding game content creators (YouTubers, Twitch streamers, Steam curators) to offer free keys to.
Given a game description and some existing queries, propose ADDITIONAL, DIVERSE queries that would surface NEW relevant creators — different genres-adjacent terms, comparable games, formats ("reaction", "no commentary", "playthrough"), and languages (include some Korean and English).
Return ONE JSON object only: {"seeds": ["query 1", "query 2", ...]}. Each query is what you'd type into YouTube/Google search — short, no quotes. Do not repeat the existing queries.`;

// Ask gemma for extra seed queries given the game context and current seeds.
export async function expandSeeds({ gameContext = "", existingSeeds = [], count = 8, signal } = {}) {
  const user = [
    `Game: ${gameContext || "a first-person observation / 'spot the anomaly' indie game (Exit 8-like)"}`,
    existingSeeds.length ? `Existing queries (do NOT repeat):\n- ${existingSeeds.join("\n- ")}` : "",
    `Propose about ${count} new search queries.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const content = await chatCompletion(
    [
      { role: "system", content: SEED_SYSTEM_PROMPT },
      { role: "user", content: user },
    ],
    { maxTokens: 400, temperature: 0.9, signal },
  );
  return normalizeSeedList(extractJsonObject(content).seeds, { max: count });
}

const LEADS_SYSTEM_PROMPT = `You are tracking leads to find MORE game creators similar to ones already found.
You get a short profile of one promising creator (name, type, audience, tone, recent titles). Propose follow-up SEARCH QUERIES that would surface creators in the same niche: collaborators they mention, "channels like X", the sub-genre, recurring series formats, and the creator's language market.
Return ONE JSON object only: {"queries": ["query 1", ...]} — at most 5, short, no quotes, no duplicates of the creator's own name unless useful.`;

// Given one analyzed candidate, propose follow-up queries to chase its niche.
export async function proposeLeads({ channelName = "", channelType = "", audience = "", contentTone = "", recentTitles = [], signal } = {}) {
  const titles = Array.isArray(recentTitles) ? recentTitles.slice(0, 8) : [];
  const user = [
    channelName ? `Creator: ${channelName}` : "",
    channelType ? `Type: ${channelType}` : "",
    audience ? `Audience: ${audience}` : "",
    contentTone ? `Tone: ${contentTone}` : "",
    titles.length ? `Recent titles:\n- ${titles.join("\n- ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const content = await chatCompletion(
    [
      { role: "system", content: LEADS_SYSTEM_PROMPT },
      { role: "user", content: user || "A game content creator." },
    ],
    { maxTokens: 300, temperature: 0.8, signal },
  );
  return normalizeSeedList(extractJsonObject(content).queries, { max: 5 });
}

const LANG_NAMES = { ko: "Korean", en: "English", ja: "Japanese", de: "German", zh: "Chinese (Simplified)" };

// Translate an outreach email body into the target language, preserving tone,
// formatting, and {{placeholders}}. Used so a Korean sender can read/edit an
// English email in Korean, then push the edits back into the sending language.
export async function translateText({ text, targetLang = "ko" } = {}) {
  const clean = String(text || "").trim();
  if (!clean) throw new Error("번역할 텍스트가 없습니다.");
  const langName = LANG_NAMES[targetLang] || targetLang;
  const system = `You are a precise, literal translation engine. Output ONLY the translation of the user's text into ${langName} — nothing else (no preamble, no notes, no quotes, no JSON).
ABSOLUTE rules:
- This is TRANSLATION, not rewriting. Do NOT change, add, remove, summarize, reorder, or "improve" anything. Every fact, offer, sentence, and nuance in the source MUST appear in the translation. If the source mentions a "free Steam key", the translation must say exactly that — never invent a different offer or topic.
- Keep these placeholders byte-for-byte, untranslated: {{creator}} {{game}} {{key}} {{utm}} {{embargo}} {{genre}}. ONLY the exact double-brace tokens are placeholders — ordinary words such as "key"/"키" are normal words: translate them, and NEVER turn a normal word into a {{...}} token.
- Preserve the line breaks and paragraph structure exactly.
- If the text is already in ${langName}, return it unchanged.`;
  const content = await chatCompletion(
    [
      { role: "system", content: system },
      { role: "user", content: clean },
    ],
    { maxTokens: 2200, temperature: 0, jsonMode: false },
  );
  // Raw text mode: strip any accidental code fences or a leading "Translation:" label.
  let out = String(content || "").trim();
  const fence = out.match(/```[a-z]*\s*([\s\S]*?)```/i);
  if (fence) out = fence[1].trim();
  out = out.replace(/^(?:translation|translated text|번역(?:문|\s*결과)?|訳文?|Übersetzung|翻译)\s*[:：]\s*/i, "").trim();
  if (!out) throw new Error("번역 결과가 비어 있습니다.");
  return out;
}
