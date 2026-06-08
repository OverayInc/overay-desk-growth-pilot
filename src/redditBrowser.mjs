// Reddit stats via a REAL headless browser (Playwright), hardened to look human.
//
// Reddit blocks unauthenticated .json (403) and serves a JS "Please wait for
// verification" bot wall to plain fetch/curl. A real browser runs that challenge
// and loads the actual post page — so we drive Playwright "like a human", with
// anti-automation hardening so headless Chromium isn't fingerprinted/blocked.
// Reddit's <shreddit-post> web component exposes the numbers as DOM attributes,
// which we read off the rendered page.
//
// Playwright is OPTIONAL: if not installed, fetchRedditMany → { available:false }.
//   npm i -D playwright && npx playwright install chromium

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Injected into every page BEFORE its scripts run: erase the obvious headless
// tells (navigator.webdriver, empty plugins/languages, missing window.chrome).
const STEALTH_INIT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  window.chrome = window.chrome || { runtime: {} };
  const _q = window.navigator.permissions && window.navigator.permissions.query;
  if (_q) {
    window.navigator.permissions.query = (p) =>
      p && p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : _q(p);
  }
`;

let pwPromise = null;
function loadPlaywright() {
  if (!pwPromise) pwPromise = import("playwright").catch(() => null);
  return pwPromise;
}

// Human-like pacing helpers — so a multi-post refresh looks like a person idly
// checking posts, not a bot hammering N requests back-to-back.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function normalize(d) {
  const num = (v) => {
    const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(n) ? n : 0;
  };
  let ratio = num(d.ratio);
  if (ratio > 1) ratio = ratio / 100; // "92" → 0.92
  return {
    found: true,
    upvotes: num(d.score),
    comments: num(d.comments),
    upvoteRatio: ratio,
    title: d.title || "",
    subreddit: d.subreddit || "",
    author: d.author || "",
    createdUtc: d.created ? Math.floor(new Date(d.created).getTime() / 1000) : 0,
  };
}

// Fetch stats for several post URLs in one hardened browser session (opened +
// closed per call). Returns { available, byUrl: { url -> stats } }.
export async function fetchRedditMany(urls, { timeoutMs = 30000 } = {}) {
  const list = [...new Set((urls || []).filter(Boolean))];
  if (!list.length) return { available: true, byUrl: {} };
  const pw = await loadPlaywright();
  if (!pw) return { available: false, byUrl: {} };

  const byUrl = {};
  let browser;
  try {
    browser = await pw.chromium.launch({
      headless: true,
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
    const context = await browser.newContext({
      userAgent: UA,
      locale: "en-US",
      timezoneId: "America/New_York",
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    });
    await context.addInitScript(STEALTH_INIT);

    // Shuffle + pace only when checking multiple posts (a single preview stays snappy).
    const ordered = list.length > 1 ? shuffle(list) : list;
    let idx = 0;
    for (const url of ordered) {
      if (list.length > 1 && idx > 0) await sleep(rand(4000, 11000)); // idle gap between posts
      idx += 1;
      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        // Wait past the "please wait for verification" wall until the post renders.
        await page.waitForSelector("shreddit-post", { timeout: timeoutMs });
        await sleep(rand(700, 2200)); // brief "reading" pause
        const d = await page.$eval("shreddit-post", (el) => ({
          score: el.getAttribute("score"),
          comments: el.getAttribute("comment-count"),
          title: el.getAttribute("post-title"),
          subreddit: el.getAttribute("subreddit-prefixed-name"),
          author: el.getAttribute("author"),
          created: el.getAttribute("created-timestamp"),
          ratio: el.getAttribute("upvote-ratio") || el.getAttribute("score-percentage"),
        }));
        byUrl[url] = normalize(d);
      } catch (error) {
        byUrl[url] = { found: false, error: String(error?.message || error) };
      } finally {
        await page.close().catch(() => {});
      }
    }
    await context.close().catch(() => {});
  } catch (error) {
    return { available: true, byUrl, error: String(error?.message || error) };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return { available: true, byUrl };
}
