const axios = require('axios');
const cheerio = require('cheerio');
const browser = require('../../browser');

// stream-<id>.php embeds the player as:
//   <iframe src="https://<rotating-host>/premiumtv/daddy<N>.php?id=<id>">
// dlhd assigns different player variants per channel — daddy.php, daddy2.php,
// daddy3.php, daddy4.php, ... — all the same embed shape, so match any digit.
const EMBED_RE = /premiumtv\/daddy\d*\.php\?id=\d+/i;

// Pull the daddy3 embed URL out of a stream page. Exported for unit testing the
// deterministic hop without a browser.
function extractEmbedUrl(streamHtml) {
  const $ = cheerio.load(streamHtml || '');
  let src = null;
  $('iframe[src]').each((_, el) => {
    const s = $(el).attr('src');
    if (s && EMBED_RE.test(s)) src = s;
  });
  if (!src) {
    const m = /["'](https?:\/\/[^"']*premiumtv\/daddy\d*\.php\?id=\d+)["']/i.exec(streamHtml || '');
    if (m) src = m[1];
  }
  return src ? src.replace(/^\/\//, 'https://') : null;
}

// Build the headers a downstream fetch needs from what the browser actually
// sent, defaulting Referer/Origin to the embed origin (the player domain the
// CDN locks against).
function streamHeaders(sniffHeaders, embedOrigin) {
  const ref = sniffHeaders.referer || `${embedOrigin}/`;
  const origin = sniffHeaders.origin || embedOrigin;
  const out = { Referer: ref, Origin: origin };
  if (sniffHeaders['user-agent']) out['User-Agent'] = sniffHeaders['user-agent'];
  return out;
}

async function plainGet(url, referer) {
  const r = await axios.get(url, {
    headers: { 'User-Agent': browser.DEFAULT_UA, Referer: referer, Accept: '*/*' },
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: () => true,
    responseType: 'text',
    transformResponse: x => x,
  });
  return r.status === 200 ? String(r.data || '') : '';
}

// Resolve a dlhd channel id to a playable HLS manifest URL + the headers needed
// to fetch it. `deps` is injectable for testing: { fetchPlain, fetchPage, sniff }.
async function resolveDaddyStream(base, id, deps = {}) {
  const fetchPage = deps.fetchPage || (u => browser.fetchRendered(u, { referer: `${base}/` }));
  // The stream page usually carries the embed iframe in its static HTML, so try
  // a plain GET before paying for a headless render. Tests that inject only
  // fetchPage get no plain hop (no network in the suite).
  const fetchPlain =
    deps.fetchPlain !== undefined
      ? deps.fetchPlain
      : deps.fetchPage
        ? null
        : u => plainGet(u, `${base}/`);
  const sniff = deps.sniff || ((u, opts) => browser.sniffStream(u, opts));

  const streamUrl = `${base}/stream/stream-${id}.php`;
  let embed = null;
  if (fetchPlain) {
    try {
      embed = extractEmbedUrl(await fetchPlain(streamUrl));
    } catch {
      embed = null;
    }
  }
  if (!embed) embed = extractEmbedUrl(await fetchPage(streamUrl));
  if (!embed) throw new Error(`daddylive: no daddy embed for id=${id}`);

  const embedOrigin = new URL(embed).origin;
  // The player 403s ("only works when embedded") when opened top-level, so load
  // the stream page that embeds it and take the manifest the player frame requests.
  const result = await sniff(streamUrl, { referer: `${base}/`, frameMatch: EMBED_RE });
  if (!result || !result.url) throw new Error(`daddylive: no manifest for id=${id}`);

  return { url: result.url, headers: streamHeaders(result.headers || {}, embedOrigin) };
}

module.exports = { extractEmbedUrl, streamHeaders, resolveDaddyStream, EMBED_RE };
