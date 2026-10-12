const dotenv = require('dotenv');
dotenv.config();

function parseBool(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function parsePositiveInt(v, fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseNonNegativeInt(v, fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

module.exports = {
  PORT: process.env.PORT || 5000,
  // Ordered list of enabled stream sources (see providers/index.js registry).
  // First-listed wins for same-game event fallback ordering.
  PROVIDERS: (process.env.PROVIDERS || 'thetvapp')
    .split(',')
    .map(s => s.trim())
    // PROVIDERS=none runs only the M3U_SOURCES feeds.
    .filter(s => s && s.toLowerCase() !== 'none'),
  TV_URL: process.env.TV_URL || 'https://thetvapp.to',
  // Ordered mirror list for the thetvapp source. The original thetvapp.to backend
  // was taken down (June 2026); the app relocated to the-tv.app (same brand, new
  // site structure — event-only, JS player). Domains rotate, so list known
  // alternates and the resolver fails over to the first live one. Deliberately
  // NOT chained off the dead TV_URL anymore.
  THETVAPP_URLS: (process.env.THETVAPP_URLS || 'https://the-tv.app,https://thetvapp.link')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  // Optional. When set, the M3U playlist emits channel URLs prefixed with this
  // value (e.g. https://thetvapp-proxy.example.com). When unset, the prefix is
  // derived from the request's Host/X-Forwarded-* headers, which works as long
  // as the M3U is fetched at a URL that downstream players can also reach.
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || '',
  // When true, scrape per-game event pages (MLB/NHL/NFL/NBA/NCAAF/NCAAB/Soccer/PPV)
  // and merge them into /channels.m3u and /epg.xml alongside the linear TV channels.
  ENABLE_EVENT_STREAMS: parseBool(process.env.ENABLE_EVENT_STREAMS, true),
  // IANA zone the "@ <time>" suffix in event names is rendered in. The label
  // carries a DST-accurate abbreviation (CDT/CST). NOTE: the Dispatcharr
  // team-recordings scheduler re-parses this time using its own source_timezone
  // (/etc/dispatcharr-local/team-rules.json) — keep the two in sync or recordings
  // shift by the UTC offset between them.
  EVENT_DISPLAY_TZ: process.env.EVENT_DISPLAY_TZ || 'America/Chicago',
  // DaddyLive (dlhd) mirror list + whether to surface its (best-effort) events.
  DLHD_URLS: (process.env.DLHD_URLS || 'https://dlive.sx,https://dlhd.st,https://dlhd.pk')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  DLHD_ENABLE_EVENTS: parseBool(process.env.DLHD_ENABLE_EVENTS, true),
  // Reject the dlhd schedule when its date header drifts more than this many
  // days from today. dlhd has served a frozen March-2025 schedule for months;
  // without this guard every year-old fixture is relabeled as a live "today" event.
  DLHD_MAX_STALE_DAYS: parsePositiveInt(process.env.DLHD_MAX_STALE_DAYS, 2),
  // dlhd's 24/7 linear channels have no EPG (they render as empty guide rows).
  // Set false to serve dlhd events only — useful when an EPG-bearing source
  // (the-tv.app) is primary and the empty linear rows aren't wanted.
  DLHD_ENABLE_LINEAR: parseBool(process.env.DLHD_ENABLE_LINEAR, true),
  // How often to re-scrape the per-sport listing pages. The chids that back
  // event entries are slot ids reused across the day, so frequent refresh
  // matters more here than for the TV channel cache.
  EVENT_REFRESH_MS: parsePositiveInt(process.env.EVENT_REFRESH_MS, 30 * 60 * 1000),
  // How long a resolved+validated stream URL is reused for a channel before the
  // provider is asked again. The cached URL is re-checked on every use, so an
  // expired token just costs one failed manifest fetch. 0 disables the cache.
  // Generic M3U + XMLTV sources (FAST services, public broadcasters, an IPTV
  // subscription). Each entry becomes its own provider, enabled after PROVIDERS:
  //   M3U_SOURCES="pluto=https://host/us.m3u8|https://host/us.xml.gz;news=https://..."
  // or a JSON array of { name, m3u, epg?, group? }. See providers/m3u/parse.js.
  M3U_SOURCES: process.env.M3U_SOURCES || '',
  STREAM_CACHE_MS: parseNonNegativeInt(process.env.STREAM_CACHE_MS, 10 * 60 * 1000),
};
