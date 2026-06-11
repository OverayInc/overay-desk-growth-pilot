// Discovery — optional headless-browser renderer.
//
// Many creator contact pages (Linktree, carrd, beacons, personal sites) render
// their email with JavaScript, so a plain `fetch` sees an empty shell. Playwright
// renders the page so the email becomes visible to our extractor.
//
// Playwright is NOT a hard dependency (it pulls ~hundreds of MB of browsers).
// This module dynamic-imports it; if it isn't installed, makeRenderer() returns
// null and enrich.mjs transparently falls back to plain fetch. To enable:
//   npm i -D playwright && npx playwright install chromium

let cachedBrowser = null;
let triedImport = false;
let playwright = null;

async function loadPlaywright() {
  if (triedImport) return playwright;
  triedImport = true;
  try {
    playwright = await import("playwright");
  } catch {
    playwright = null; // not installed — caller falls back to fetch
  }
  return playwright;
}

// Returns an async render(url) => htmlString, or null if Playwright is absent.
// One shared headless Chromium is reused across calls; close it with
// closeRenderer() when a discovery run finishes.
export async function makeRenderer({ timeoutMs = 15000 } = {}) {
  const pw = await loadPlaywright();
  if (!pw) return null;

  async function getBrowser() {
    if (!cachedBrowser) {
      cachedBrowser = await pw.chromium.launch({ headless: true });
    }
    return cachedBrowser;
  }

  return async function render(url) {
    let context;
    try {
      const browser = await getBrowser();
      context = await browser.newContext({
        userAgent: "overay-desk-discovery/1.0 (+marketing research bot)",
        javaScriptEnabled: true,
      });
      const page = await context.newPage();
      await page.goto(url, { waitUntil: "networkidle", timeout: timeoutMs }).catch(() => {});
      const html = await page.content();
      return html;
    } catch {
      return "";
    } finally {
      if (context) await context.close().catch(() => {});
    }
  };
}

export async function closeRenderer() {
  if (cachedBrowser) {
    await cachedBrowser.close().catch(() => {});
    cachedBrowser = null;
  }
}
