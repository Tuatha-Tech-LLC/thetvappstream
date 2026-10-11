const axios = require('axios');
const Provider = require('../Provider');
const MirrorResolver = require('../../MirrorResolver');
const { runWithConcurrency } = require('../../ChannelManager');
const { formatEventSuffix, LEAGUE_DURATION_MIN } = require('../daddylive/parse');
const { pickEventLogo } = require('../../eventLogos');
const { DEFAULT_UA: UA } = require('../../browser');
const { THETVAPP_URLS } = require('../../config');
const {
  LEAGUE_BY_PATH,
  DEFAULT_DURATION_MIN,
  STALE_AFTER_MIN,
  parseLeagueListing,
  parseRelativeStartSec,
  isEndedBadge,
  parseWatchPage,
} = require('./parse');
const { resolveTheTvAppStream } = require('./resolve');

const MAX_AHEAD_HOURS = 36;
const EVENT_FETCH_CONCURRENCY = 6;

// League pages probed to decide whether a mirror is live. Soccer runs year
// round, so the probe still passes in the MLB offseason; MLB stays as a second
// chance when soccer has a quiet day.
const PROBE_PATHS = ['/watch/soccer-streams', '/watch/mlb-streams'];

// Statuses that say "this domain is blocking or broken" rather than "this one
// page is gone": a Cloudflare challenge, rate limiting, an origin outage.
function isMirrorFailureStatus(status) {
  return status === 403 || status === 429 || status >= 500;
}

// TheTVApp adapter, repointed at the-tv.app after the thetvapp.to takedown.
// Event-only: per-league listing pages -> per-game watch pages -> obfuscated JS
// player. Linear channels are gone, so listLinearChannels()/getEpgData() are
// empty and event programmes are synthesized by the Aggregator.
class TheTvAppProvider extends Provider {
  constructor({ urls = THETVAPP_URLS, enableEvents = true } = {}, deps = {}) {
    super();
    this.enableEvents = enableEvents;
    this.mirrors = new MirrorResolver('thetvapp', urls, { probe: u => this._probe(u) });
    this.client =
      deps.http ||
      axios.create({
        headers: { 'User-Agent': UA, Accept: '*/*' },
        timeout: 20000,
        maxRedirects: 5,
        validateStatus: () => true,
      });
    this.resolveFn = deps.resolveStream || resolveTheTvAppStream;
    this.eventsCache = [];
  }

  get name() {
    return 'thetvapp';
  }

  base() {
    return this.mirrors.active();
  }

  // A live mirror serves a league page with the list-group event index.
  async _probe(url) {
    for (const path of PROBE_PATHS) {
      try {
        const r = await this.client.get(`${url}${path}`, { headers: { Referer: `${url}/` } });
        const body = String(r.data || '');
        if (r.status === 200 && /list-group-item/.test(body) && /\/tv-live\//.test(body)) {
          return true;
        }
      } catch {
        // try the next probe page
      }
    }
    return false;
  }

  // Move off `failedBase`, unless another request already did. Concurrent
  // event fetches all fail together on a dead domain; without this guard each
  // one would rotate again and the active mirror would spin round the list.
  async _rotateFrom(failedBase) {
    if (this.base() === failedBase) await this.mirrors.rotate();
  }

  async ensureReady() {
    await this.mirrors.resolve();
  }

  // GET with mirror failover. Rotates and retries once on a connection error
  // or a blocking status (403/429/5xx). A 404 is left alone: one league or
  // game page can legitimately vanish, and rotating on it would bounce between
  // mirrors that all lack the page. Domains that answer 200 with junk (parked,
  // redesigned) are caught by refreshEvents' zero-listings check instead.
  async _get(path) {
    let r;
    for (let attempt = 0; attempt < 2; attempt++) {
      const base = this.base();
      try {
        r = await this.client.get(`${base}${path}`, { headers: { Referer: `${base}/` } });
      } catch (e) {
        if (attempt === 0) {
          await this._rotateFrom(base);
          continue;
        }
        throw e;
      }
      if (isMirrorFailureStatus(r.status) && attempt === 0 && this.mirrors.urls.length > 1) {
        await this._rotateFrom(base);
        if (this.base() !== base) continue;
      }
      return r;
    }
    return r;
  }

  async refreshEvents() {
    if (!this.enableEvents) {
      this.eventsCache = [];
      return;
    }
    // Start each refresh from the most preferred live mirror, so a domain that
    // was skipped while down is picked back up once it recovers.
    await this.mirrors.preferFirst();

    let result = await this._collectEvents();
    // A mirror that answers every league page with nothing usable (a parked
    // domain, a block page served as 200, a redesign) still looks reachable.
    // With 11 leagues, soccer among them, a live mirror never lists zero
    // games, so treat that as a mirror failure and retry once elsewhere.
    if (result.listings === 0 && this.mirrors.urls.length > 1) {
      const before = this.base();
      await this._rotateFrom(before);
      if (this.base() !== before) {
        console.warn(`[thetvapp] ${before} listed no games; retrying on ${this.base()}`);
        result = await this._collectEvents();
      }
    }

    this.eventsCache = result.events;
    console.log(
      `[thetvapp] events: ${result.events.length} across ${Object.keys(LEAGUE_BY_PATH).length} leagues` +
        ` via ${this.base()}`,
    );
  }

  // One full scrape against the active mirror. Returns the events plus the raw
  // listing count, which refreshEvents uses to judge the mirror itself.
  async _collectEvents() {
    const nowSec = Math.floor(Date.now() / 1000);

    // 1) One fetch per league page -> candidate events (skip clearly-ended ones).
    const candidates = [];
    let listings = 0;
    for (const [path, league] of Object.entries(LEAGUE_BY_PATH)) {
      try {
        const r = await this._get(path);
        if (!r || r.status !== 200) {
          if (r) console.error(`[thetvapp] ${path} -> ${r.status}`);
          continue;
        }
        const rows = parseLeagueListing(r.data, league);
        listings += rows.length;
        for (const ev of rows) {
          if (isEndedBadge(ev.timeText)) continue;
          const coarse = parseRelativeStartSec(ev.timeText, nowSec);
          // When the badge is a relative offset we can pre-drop far-future games;
          // otherwise defer the decision to the watch page's absolute time.
          if (coarse !== null && coarse > nowSec + MAX_AHEAD_HOURS * 3600) continue;
          candidates.push({ ...ev, coarseStartSec: coarse });
        }
      } catch (e) {
        console.error(`[thetvapp] ${path}: ${e.message}`);
      }
    }

    const byHref = new Map();
    for (const e of candidates) if (!byHref.has(e.href)) byHref.set(e.href, e);

    // 2) One watch-page fetch per event for the authoritative absolute start.
    const events = [];
    await runWithConcurrency([...byHref.values()], EVENT_FETCH_CONCURRENCY, async ev => {
      try {
        const r = await this._get(ev.href);
        if (!r || r.status !== 200) return;
        const { startSec } = parseWatchPage(r.data);
        const start = startSec || ev.coarseStartSec;
        if (start == null) return;
        const durMin = LEAGUE_DURATION_MIN[ev.league] || DEFAULT_DURATION_MIN;
        const endSec = start + durMin * 60;
        if (endSec < nowSec - STALE_AFTER_MIN * 60) return;
        if (start > nowSec + MAX_AHEAD_HOURS * 3600) return;
        events.push({
          league: ev.league,
          name: `${ev.matchup} @ ${formatEventSuffix(start)}`,
          startSec: start,
          endSec,
          streamRef: ev.href, // resolved lazily; embed hosts rotate so re-fetch at play time
          logo: pickEventLogo({ league: ev.league, name: ev.matchup }) || '',
        });
      } catch (e) {
        console.error(`[thetvapp] ${ev.href}: ${e.message}`);
      }
    });

    events.sort((a, b) => a.startSec - b.startSec || a.name.localeCompare(b.name));
    return { events, listings };
  }

  async listEvents() {
    return this.eventsCache;
  }

  async listLinearChannels() {
    return {};
  }

  async getEpgData() {
    return { items: [], programmesByChid: {} };
  }

  // Resolve on the active mirror first. When the failure is the mirror itself
  // (its watch page is unreachable or blocked, not the embed/CDN behind it),
  // try the remaining mirrors in order: watch paths are the same on every
  // mirror of the app. The active mirror is rotated off a dead domain so the
  // next play doesn't pay for the failed hop again.
  async resolveStream(streamRef) {
    const first = this.base();
    const bases = [first, ...this.mirrors.urls.filter(u => u !== first)];
    let lastErr;
    for (const base of bases) {
      try {
        return await this.resolveFn(base, streamRef);
      } catch (e) {
        lastErr = e;
        if (!e.mirrorFailure) throw e;
        console.error(`[thetvapp] ${base}${streamRef}: ${e.message}; trying next mirror`);
        if (base === first) await this._rotateFrom(first);
      }
    }
    throw lastErr;
  }
}

module.exports = TheTvAppProvider;
