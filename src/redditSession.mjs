// Reddit authenticated session — read AUTHOR-ONLY data (view counts / insights).
//
// Reddit only shows a post's view count to its author (logged in). We DON'T store
// a password (Reddit's login has captcha/2FA that breaks automation); instead you
// log in ONCE in a real browser window and we persist just the session cookies
// (data/reddit-state.json, gitignored). Headless runs then reuse that session.
//
// CLI:
//   node src/redditSession.mjs login            # opens a browser; you log in
//   node src/redditSession.mjs dump <postUrl>   # show everything visible to author
//   node src/redditSession.mjs test <postUrl>   # extract view count (best-effort)
//
// Needs Playwright: npm i -D playwright && npx playwright install chromium

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REDDIT_STATE_FILE =
  process.env.REDDIT_STATE_FILE || path.join(__dirname, "..", "data", "reddit-state.json");

// Small sidecar holding the human-readable identity of the saved session
// (username/email/capturedAt). It's derived data we can show in the UI without a
// network call — handy on a headless cloud box where you can't re-run `login`.
// Lives next to the state file and is safe to commit alongside it.
export const REDDIT_META_FILE =
  process.env.REDDIT_META_FILE ||
  REDDIT_STATE_FILE.replace(/reddit-state\.json$/, "reddit-session-meta.json");

function readSessionMeta() {
  try {
    return JSON.parse(readFileSync(REDDIT_META_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeSessionMeta(patch) {
  const next = { ...readSessionMeta(), ...patch };
  try {
    writeFileSync(REDDIT_META_FILE, JSON.stringify(next, null, 2));
  } catch {
    /* read-only fs → skip; status still works from the state file */
  }
  return next;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    return null;
  }
}

// Erase the obvious headless tells before any page script runs.
const STEALTH_INIT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  window.chrome = window.chrome || { runtime: {} };
`;

// Human-like pacing for multi-post refreshes.
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

// Parse a possibly-abbreviated count: "516", "1,234", "1.2k", "1.2천", "조회 3만회".
export function parseCount(raw) {
  if (!raw) return 0;
  const m = String(raw).match(/([\d.,]+)\s*(k|m|천|만|억)?/i);
  if (!m) return 0;
  let n = parseFloat(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return 0;
  const u = (m[2] || "").toLowerCase();
  if (u === "k") n *= 1e3;
  else if (u === "m") n *= 1e6;
  else if (u === "천") n *= 1e3;
  else if (u === "만") n *= 1e4;
  else if (u === "억") n *= 1e8;
  return Math.round(n);
}

function normalizeAuth(a) {
  return {
    upvotes: Number(a.score) || 0,
    comments: Number(a.comments) || 0,
    upvoteRatio: a.ratio ? Number(a.ratio) : 0,
    title: a.title || "",
    subreddit: a.subreddit || "",
    author: a.author || "",
    createdUtc: a.created ? Math.floor(new Date(a.created).getTime() / 1000) : 0,
  };
}

// A dedicated, persistent Chrome profile so you only log in ONCE — the next
// `login` run reopens already signed in. Separate from your main Chrome profile
// (so it doesn't lock/modify it).
const PROFILE_DIR = process.env.REDDIT_PROFILE_DIR || path.join(__dirname, "..", "data", "reddit-chrome-profile");

export function hasRedditSession() {
  return existsSync(REDDIT_STATE_FILE);
}

// Read-only, no network: describe the saved session so the UI can show who's
// logged in AND so a headless server can explain *where* it looked when the file
// is missing (the #1 deploy confusion: the committed file is shadowed by a
// bind-mounted/empty ./data on the host).
export function redditSessionStatus() {
  const meta = readSessionMeta();
  const base = {
    present: false,
    path: REDDIT_STATE_FILE,
    pathFromEnv: Boolean(process.env.REDDIT_STATE_FILE),
    cookieCount: 0,
    hasAuthCookies: false,
    loginTime: "",
    username: meta.username || "",
    email: meta.email || "",
    capturedAt: meta.capturedAt || "",
  };
  if (!existsSync(REDDIT_STATE_FILE)) return base;
  base.present = true;
  try {
    const state = JSON.parse(readFileSync(REDDIT_STATE_FILE, "utf8"));
    const cookies = state.cookies || [];
    const names = cookies.map((c) => c.name);
    base.cookieCount = cookies.length;
    base.hasAuthCookies = names.includes("reddit_session") && names.some((n) => /token/i.test(n));
    const ls = (state.origins || []).flatMap((o) => o.localStorage || []);
    base.loginTime = ls.find((e) => e.name === "login-time")?.value || "";
  } catch {
    /* corrupt file → present but unreadable; treat as no usable session */
    base.present = false;
  }
  return base;
}

// Resolve the logged-in username by visiting /user/me/ (redirects to the real
// handle when authed) and cache it into the sidecar meta. Network + headless, so
// it's opt-in (status endpoint only calls this on ?refresh=1).
export async function redditWhoami({ timeoutMs = 20000 } = {}) {
  const pw = await loadPlaywright();
  if (!pw) return { available: false, loggedIn: false, username: "" };
  if (!existsSync(REDDIT_STATE_FILE)) return { available: true, loggedIn: false, username: "" };

  let browser;
  try {
    browser = await pw.chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
    });
    const ctx = await browser.newContext({
      storageState: REDDIT_STATE_FILE,
      userAgent: UA,
      locale: "en-US",
      viewport: { width: 1280, height: 900 },
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    });
    await ctx.addInitScript(STEALTH_INIT);
    const page = await ctx.newPage();
    await page.goto("https://www.reddit.com/user/me/", { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => {});
    await sleep(rand(800, 1800));
    const username = page.url().match(/\/user\/([^/]+)/)?.[1] || "";
    await ctx.close().catch(() => {});
    const loggedIn = Boolean(username) && username !== "me";
    if (loggedIn) writeSessionMeta({ username, checkedAt: new Date().toISOString() });
    return { available: true, loggedIn, username: loggedIn ? username : "" };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// Resolve until the user presses Enter in the terminal.
function waitForEnter() {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => {
      process.stdin.pause();
      resolve();
    });
  });
}

// Open a REAL browser at the Reddit login page. You log in (password/Google/2FA/
// captcha), then press Enter HERE — only then do we save the session. (No cookie
// auto-detect: Reddit sets cookies for anonymous visitors too, which misfired.)
export async function captureRedditSession() {
  const pw = await loadPlaywright();
  if (!pw) throw new Error("Playwright 미설치 — npm i -D playwright && npx playwright install chromium");

  const opts = {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  };
  // Prefer the installed Google Chrome (familiar UI); fall back to bundled Chromium.
  let ctx;
  try {
    ctx = await pw.chromium.launchPersistentContext(PROFILE_DIR, { ...opts, channel: "chrome" });
  } catch {
    ctx = await pw.chromium.launchPersistentContext(PROFILE_DIR, opts);
  }
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto("https://www.reddit.com/login/", { waitUntil: "domcontentloaded" }).catch(() => {});

  console.log("\n────────────────────────────────────────────────────────");
  console.log(">>> 열린 브라우저에서 레딧에 로그인하세요 (이미 로그인돼 있으면 그대로 두세요).");
  console.log(">>> 로그인이 끝나면 이 터미널로 돌아와 [Enter] 를 누르세요. 그때 세션을 저장합니다.");
  console.log("────────────────────────────────────────────────────────\n");
  await waitForEnter();

  await ctx.storageState({ path: REDDIT_STATE_FILE });
  // Record who we just logged in as (best-effort) so the dashboard can show it.
  let username = "";
  try {
    await page.goto("https://www.reddit.com/user/me/", { waitUntil: "domcontentloaded" }).catch(() => {});
    await sleep(1500);
    username = page.url().match(/\/user\/([^/]+)/)?.[1] || "";
    if (username === "me") username = "";
  } catch {
    /* ignore — session is saved regardless */
  }
  writeSessionMeta({ username, capturedAt: new Date().toISOString() });
  await ctx.close().catch(() => {});
  if (username) console.log(`   로그인 계정: u/${username}`);
  return REDDIT_STATE_FILE;
}

// Visit posts WITH the saved session. dump:true returns every shreddit-post
// attribute + any "view"-ish text on the page so we can locate the view count.
export async function fetchRedditInsights(urls, { dump = false, timeoutMs = 30000 } = {}) {
  const pw = await loadPlaywright();
  if (!pw) return { available: false, byUrl: {} };
  if (!existsSync(REDDIT_STATE_FILE)) return { available: true, loggedIn: false, byUrl: {} };

  const byUrl = {};
  let browser;
  try {
    browser = await pw.chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
    });
    const ctx = await browser.newContext({
      storageState: REDDIT_STATE_FILE,
      userAgent: UA,
      locale: "en-US",
      timezoneId: "America/New_York",
      viewport: { width: 1280, height: 900 },
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    });
    await ctx.addInitScript(STEALTH_INIT);
    const list = [...new Set((urls || []).filter(Boolean))];
    // Pace + shuffle when checking multiple posts (single = snappy) so a refresh
    // looks like a person idly checking, not a bot burst.
    const ordered = list.length > 1 ? shuffle(list) : list;
    let idx = 0;
    for (const url of ordered) {
      if (list.length > 1 && idx > 0) await sleep(rand(4000, 11000));
      idx += 1;
      const page = await ctx.newPage();
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        await page.waitForSelector("shreddit-post", { timeout: timeoutMs });
        await sleep(rand(700, 2200));
        if (dump) {
          const attrs = await page.$eval("shreddit-post", (el) =>
            el.getAttributeNames().reduce((o, n) => ((o[n] = el.getAttribute(n)), o), {}),
          );
          const viewText = await page.evaluate(() => {
            const out = [];
            document.querySelectorAll("*").forEach((e) => {
              const t = (e.textContent || "").trim();
              if (/\bviews?\b/i.test(t) && t.length < 40) out.push(t);
            });
            return [...new Set(out)].slice(0, 20);
          });
          const loggedIn = await page.evaluate(() => !!document.querySelector("[aria-label*='Settings'], [href*='/user/']"));
          byUrl[url] = { attrs, viewText, loggedInHint: loggedIn };
        } else {
          const a = await page.$eval("shreddit-post", (el) => ({
            score: el.getAttribute("score"),
            comments: el.getAttribute("comment-count"),
            title: el.getAttribute("post-title"),
            subreddit: el.getAttribute("subreddit-prefixed-name"),
            author: el.getAttribute("author"),
            created: el.getAttribute("created-timestamp"),
            ratio: el.getAttribute("upvote-ratio"),
          }));
          // View count is author-only and lives deep in shadow DOM as
          // "조회 N회" (KO) / "N views" (EN) near the post's insights summary.
          const viewsRaw = await page.evaluate(() => {
            let found = "";
            const walk = (root) => {
              if (!root || found) return;
              root.querySelectorAll &&
                root.querySelectorAll("*").forEach((e) => {
                  if (found) return;
                  const t = (e.textContent || "").trim();
                  if (t.length < 40 && (/조회\s*[\d.,]+\s*[천만억]?\s*회/.test(t) || /^[\d.,]+\s*[kKmM]?\s*views?$/i.test(t))) found = t;
                  if (e.shadowRoot) walk(e.shadowRoot);
                });
            };
            walk(document);
            return found;
          });
          byUrl[url] = { found: true, ...normalizeAuth(a), views: parseCount(viewsRaw), viewsRaw };
        }
      } catch (error) {
        byUrl[url] = { error: String(error?.message || error) };
      } finally {
        await page.close().catch(() => {});
      }
    }
    await ctx.close().catch(() => {});
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  return { available: true, loggedIn: true, byUrl };
}

// Scrape the logged-in user's OWN submitted posts (URLs) from their profile, so
// they can be bulk-imported without pasting each URL. Returns { posts: [{url,
// title, subreddit, postId}] }.
export async function fetchMyRedditPosts({ max = 60, timeoutMs = 30000 } = {}) {
  const pw = await loadPlaywright();
  if (!pw) return { available: false, posts: [] };
  if (!existsSync(REDDIT_STATE_FILE)) return { available: true, loggedIn: false, posts: [] };

  let browser;
  try {
    browser = await pw.chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
    });
    const ctx = await browser.newContext({
      storageState: REDDIT_STATE_FILE,
      userAgent: UA,
      locale: "en-US",
      timezoneId: "America/New_York",
      viewport: { width: 1280, height: 1000 },
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    });
    await ctx.addInitScript(STEALTH_INIT);
    const page = await ctx.newPage();
    // /user/me/submitted/ redirects to the logged-in user's posts when authed.
    await page.goto("https://www.reddit.com/user/me/submitted/", { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForSelector("shreddit-post, shreddit-async-loader, h1", { timeout: timeoutMs }).catch(() => {});
    await sleep(rand(2500, 4500)); // land + "read" the page like a person
    const username = page.url().match(/\/user\/([^/]+)/)?.[1] || "";

    const seen = new Set();
    const posts = [];
    let dry = 0;
    for (let s = 0; s < 16 && posts.length < max && dry < 2; s++) {
      const batch = await page.$$eval("shreddit-post", (els) =>
        els.map((el) => ({
          permalink: el.getAttribute("permalink") || "",
          title: el.getAttribute("post-title") || "",
          subreddit: el.getAttribute("subreddit-prefixed-name") || "",
          id: (el.getAttribute("id") || "").replace(/^t3_/, ""),
        })),
      );
      let added = 0;
      for (const b of batch) {
        if (!b.permalink || seen.has(b.permalink)) continue;
        seen.add(b.permalink);
        posts.push({
          url: `https://www.reddit.com${b.permalink}`,
          title: b.title,
          subreddit: b.subreddit,
          postId: b.id,
        });
        added += 1;
        if (posts.length >= max) break;
      }
      // Human-like scroll: varied distance + a small mouse move + irregular pause.
      const prevH = await page.evaluate(() => document.body.scrollHeight);
      await page.mouse.move(rand(200, 1000), rand(200, 700)).catch(() => {});
      await page.mouse.wheel(0, rand(2400, 6000));
      await sleep(rand(2200, 5200));
      const newH = await page.evaluate(() => document.body.scrollHeight);
      dry = !added && newH === prevH ? dry + 1 : 0; // 2 dry scrolls in a row → done
    }
    await ctx.close().catch(() => {});
    const handle = username === "me" ? "" : username;
    if (handle) writeSessionMeta({ username: handle, checkedAt: new Date().toISOString() });
    return { available: true, loggedIn: true, username: handle, posts };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// --- CLI (only when run directly, not when imported by the server) ----------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const cmd = process.argv[2];
  const url = process.argv[3];
  if (cmd === "login") {
    captureRedditSession()
      .then((f) => console.log("\n✓ 세션 저장됨:", f))
      .catch((e) => {
        console.error("실패:", e.message);
        process.exitCode = 1;
      });
  } else if (cmd === "dump" || cmd === "test") {
    if (!url) {
      console.error("URL을 넣어주세요: node src/redditSession.mjs dump <postUrl>");
      process.exitCode = 1;
    } else {
      fetchRedditInsights([url], { dump: cmd === "dump" })
        .then((r) => console.log(JSON.stringify(r, null, 2)))
        .catch((e) => {
          console.error(e.message);
          process.exitCode = 1;
        });
    }
  } else {
    console.log("사용법: node src/redditSession.mjs login | dump <url> | test <url>");
  }
}
