// Discovery — enrichment layer.
//
// Turns a discovered candidate into a text bundle the gemma4 analyzer can read:
// channel description + recent titles + text scraped from any sites the channel
// links to (where business emails usually live, since YouTube's API never
// exposes the About-tab email). Pure parsing helpers are exported separately so
// they can be unit-tested without the network.

// Emails that are almost never a real contact: tracking pixels, asset files,
// schema.org / example placeholders. Used to drop obvious junk matches.
const JUNK_EMAIL_RE = /\.(png|jpe?g|gif|webp|svg|css|js)$/i;
const JUNK_DOMAINS = new Set(["example.com", "example.org", "sentry.io", "wixpress.com", "domain.com", "email.com"]);

// Pull plausible email addresses out of free text. Handles the common
// obfuscations "name [at] domain dot com" and "name(at)domain.com".
export function extractEmails(text) {
  const s = String(text || "");
  if (!s) return [];
  const deobfuscated = s
    .replace(/\s*\[?\(?\s*at\s*\)?\]?\s*/gi, (m) => (/[a-z]at[a-z]/i.test(m) ? m : "@"))
    .replace(/\s*\[?\(?\s*dot\s*\)?\]?\s*/gi, (m) => (/[a-z]dot[a-z]/i.test(m) ? m : "."));
  const re = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const out = [];
  const seen = new Set();
  for (const raw of deobfuscated.match(re) || []) {
    const email = raw.trim().toLowerCase().replace(/[.,;:]+$/, "");
    if (JUNK_EMAIL_RE.test(email)) continue;
    const domain = email.split("@")[1] || "";
    if (JUNK_DOMAINS.has(domain)) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

// Of several candidate emails, pick the one most likely to be a business /
// outreach contact (booking, press, business, info…), else the first.
export function pickBusinessEmail(emails) {
  if (!emails || !emails.length) return "";
  const priority = ["business", "booking", "press", "partner", "contact", "inquir", "media", "pr@", "info", "hello", "team"];
  for (const needle of priority) {
    const hit = emails.find((e) => e.includes(needle));
    if (hit) return hit;
  }
  return emails[0];
}

// Extract http(s) links from text (e.g. a channel's About description). Strips
// trailing punctuation and dedupes. Used to decide which pages to scrape.
export function extractUrls(text) {
  const s = String(text || "");
  const re = /https?:\/\/[^\s"'<>)\]]+/gi;
  const out = [];
  const seen = new Set();
  for (const raw of s.match(re) || []) {
    const url = raw.replace(/[.,;:!?)]+$/, "");
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

// Links worth scraping for a contact: skip the big platforms (their pages are
// JS walls with no email) and prefer personal sites / Linktree / carrd, etc.
const SKIP_LINK_HOSTS = [
  "youtube.com",
  "youtu.be",
  "twitch.tv",
  "tiktok.com",
  "instagram.com",
  "facebook.com",
  "discord.gg",
  "discord.com",
  "store.steampowered.com",
];

export function rankLinksForContact(urls) {
  const prefer = ["linktr.ee", "carrd.co", "beacons.ai", "about.me", "contact", "business", "press"];
  const scored = urls
    .filter((u) => {
      try {
        const host = new URL(u).host.replace(/^www\./, "").toLowerCase();
        return !SKIP_LINK_HOSTS.some((skip) => host === skip || host.endsWith(`.${skip}`));
      } catch {
        return false;
      }
    })
    .map((u) => {
      const lower = u.toLowerCase();
      const score = prefer.reduce((acc, p, i) => (lower.includes(p) ? acc + (prefer.length - i) : acc), 0);
      return { u, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored.map((s) => s.u);
}

// Very small HTML→text reducer: drop scripts/styles, surface mailto targets,
// unescape the few entities that matter for emails, collapse whitespace. We are
// not building a browser — just enough to feed the model and run email regex.
export function htmlToText(html) {
  let s = String(html || "");
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  // Collect mailto: addresses (they live inside tag attributes, which the tag
  // strip below would otherwise eat) and re-append them as plain text after.
  const mailtos = [...s.matchAll(/mailto:([^"'?\s>]+)/gi)].map((m) => m[1]);
  s = s.replace(/<[^>]+>/g, " ");
  if (mailtos.length) s += " " + mailtos.join(" ");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#0*64;/g, "@")
    .replace(/&#x40;/gi, "@")
    .replace(/&#0*46;/g, ".")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
  return s.replace(/\s+/g, " ").trim();
}

// Fetch one page and return reduced text (capped). Network failures are
// swallowed (return "") — a missing contact page must never break a run.
export async function fetchPageText(url, { fetchImpl = fetch, timeoutMs = 12000, maxBytes = 400_000, signal } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "overay-desk-discovery/1.0 (+marketing research bot)", Accept: "text/html,*/*" },
    });
    if (!res.ok) return "";
    const ct = res.headers?.get?.("content-type") || "";
    if (ct && !/text|html|xml|json/i.test(ct)) return "";
    const raw = await res.text();
    return htmlToText(raw.slice(0, maxBytes));
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onExternalAbort);
  }
}

// Build the text bundle + a best-guess email for one candidate. Scrapes up to
// `maxPages` of the candidate's linked sites looking for a contact address.
//
// `renderImpl` (optional, async url => html) is the Playwright renderer. We only
// invoke it as a SECOND pass on pages where plain fetch found no email — most
// contact pages are static, so this keeps headless-browser launches rare.
//
// Returns { description, recentTitles, scrapedText, scrapedEmail, scrapedUrls }.
export async function enrichCandidate(candidate, { fetchImpl = fetch, renderImpl = null, maxPages = 3, timeoutMs = 12000, signal } = {}) {
  const description = String(candidate.description || "");
  const recentTitles = Array.isArray(candidate.recentTitles) ? candidate.recentTitles : [];

  // Emails sometimes sit right in the description; links point at the rest.
  const inlineEmails = extractEmails(description);
  const urls = rankLinksForContact(extractUrls(description).concat(candidate.links || []));

  const pages = [];
  for (const url of urls.slice(0, maxPages)) {
    if (signal?.aborted) break;
    let text = await fetchPageText(url, { fetchImpl, timeoutMs, signal });
    // JS-rendered contact pages (Linktree etc.) come back empty of emails —
    // re-render with the headless browser if one was provided.
    if (renderImpl && !extractEmails(text).length) {
      try {
        const html = await renderImpl(url);
        const rendered = html ? htmlToText(html) : "";
        if (rendered && (extractEmails(rendered).length || rendered.length > text.length)) text = rendered;
      } catch {
        /* keep the fetch result */
      }
    }
    if (text) pages.push({ url, text });
  }

  const scrapedText = pages.map((p) => `[${p.url}]\n${p.text}`).join("\n\n").slice(0, 8000);
  const pageEmails = pages.flatMap((p) => extractEmails(p.text));
  const scrapedEmail = pickBusinessEmail([...inlineEmails, ...pageEmails]);

  return {
    description,
    recentTitles,
    scrapedText,
    scrapedEmail,
    scrapedUrls: pages.map((p) => p.url),
  };
}
