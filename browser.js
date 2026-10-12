// Lazy headless-browser manager (Playwright/chromium). DaddyLive's listing is
// bot-gated and its stream resolution is obfuscated behind a player, so the
// robust path is to render the page and observe the network rather than reverse
// the JS. Playwright is required lazily so the rest of the app (and the test
// suite) runs without the browser binaries installed.
const DEFAULT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let _chromium = null;
let _browser = null;
let _launching = null;

function chromium() {
  if (!_chromium) {
    // Throws a clear error if the optional dependency isn't installed.
    _chromium = require('playwright').chromium;
  }
  return _chromium;
}

async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  if (_launching) return _launching;
  _launching = (async () => {
    _browser = await chromium().launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    return _browser;
  })();
  try {
    return await _launching;
  } finally {
    _launching = null;
  }
}

async function withPage(fn, { userAgent = DEFAULT_UA } = {}) {
  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent });
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await context.close().catch(() => {});
  }
}

// Render a URL and return the resulting HTML (gets past JS/bot shells that a
// plain GET can't). `referer` is applied to the navigation only, so sub-resource
// requests keep their natural (page-origin) referer.
async function fetchRendered(url, { referer, userAgent, timeoutMs = 25000 } = {}) {
  return withPage(
    async page => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs, referer });
      return page.content();
    },
    { userAgent },
  );
}

// Load a player URL and capture the first network request whose URL matches
// `match`, along with the headers the browser sent for it (Referer/Origin/UA) —
// exactly what a downstream fetch needs to pull a header-locked stream.
// `frameMatch` limits capture to requests made by a frame whose URL matches it;
// needed when the loaded page is an ad-heavy host page and the player is an iframe.
async function sniffStream(
  url,
  { referer, userAgent, timeoutMs = 30000, match = /\.m3u8(\?|$)/i, frameMatch = null } = {},
) {
  return withPage(
    async page => {
      let captured = null;
      const seen = new Promise(resolve => {
        page.on('request', req => {
          if (!captured && match.test(req.url()) && fromFrame(req, frameMatch)) {
            const h = req.headers();
            captured = {
              url: req.url(),
              headers: pickHeaders(h),
            };
            resolve();
          }
        });
      });
      await page
        .goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs, referer })
        .catch(() => {});
      await Promise.race([seen, page.waitForTimeout(timeoutMs)]);
      if (!captured) throw new Error(`no stream manifest observed at ${url}`);
      return captured;
    },
    { userAgent },
  );
}

function fromFrame(req, frameMatch) {
  if (!frameMatch) return true;
  try {
    return frameMatch.test(req.frame().url());
  } catch {
    // Service-worker requests have no frame.
    return false;
  }
}

function pickHeaders(h) {
  const out = {};
  for (const k of ['referer', 'origin', 'user-agent']) {
    if (h[k]) out[k] = h[k];
  }
  return out;
}

async function shutdown() {
  if (_browser) {
    await _browser.close().catch(() => {});
    _browser = null;
  }
}

module.exports = { DEFAULT_UA, getBrowser, withPage, fetchRendered, sniffStream, shutdown };
