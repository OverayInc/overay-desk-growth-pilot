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

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REDDIT_STATE_FILE =
  process.env.REDDIT_STATE_FILE || path.join(__dirname, "..", "data", "reddit-state.json");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    return null;
  }
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
  await ctx.close().catch(() => {});
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
      viewport: { width: 1280, height: 900 },
    });
    for (const url of [...new Set((urls || []).filter(Boolean))]) {
      const page = await ctx.newPage();
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        await page.waitForSelector("shreddit-post", { timeout: timeoutMs });
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
