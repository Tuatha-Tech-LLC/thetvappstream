const zlib = require('zlib');
const axios = require('axios');
const Provider = require('../Provider');
const { DEFAULT_UA: UA } = require('../../browser');
const { parseM3u, assignRefs, parseXmltv, matchGuideIds } = require('./parse');

const PLAYLIST_TTL_MS = 60 * 60 * 1000;
const GUIDE_TTL_MS = 3 * 60 * 60 * 1000;
// Keep a little history (so the programme on air at refresh time stays) and a
// few days ahead; FAST guides publish ~1-2 weeks that Plex never shows.
const GUIDE_PAST_SEC = 6 * 3600;
const GUIDE_AHEAD_SEC = 3 * 24 * 3600;
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

// Generic M3U + XMLTV source. One instance per M3U_SOURCES entry; the source
// name doubles as the provider name, so its channels are namespaced as
// "<name>:<ref>" like every other provider's.
//
// Linear channels only. Streams are passed through as listed: a bare URL is
// redirected; one that carries #EXTVLCOPT / "|Referer=..." headers goes through
// the HLS proxy, which replays them on the manifest and every segment.
class M3uProvider extends Provider {
  constructor({ name, m3u, epg = null, group = null }, deps = {}) {
    super();
    this._name = name;
    this.m3uUrl = m3u;
    this.epgUrl = epg;
    this.groupOverride = group;
    this.fetch = deps.fetch || defaultFetch;
    this.now = deps.now || (() => Date.now());
    this.entries = [];
    this.byRef = new Map();
    this.playlistAt = 0;
    this.playlistLoading = null;
    this.guide = null;
    this.guideAt = 0;
    this.guideLoading = null;
  }

  get name() {
    return this._name;
  }

  async ensureReady() {
    await this._loadPlaylist();
  }

  async _loadPlaylist({ force = false } = {}) {
    if (!force && this.entries.length && this.now() - this.playlistAt < PLAYLIST_TTL_MS) return;
    if (this.playlistLoading) return this.playlistLoading;
    this.playlistLoading = (async () => {
      try {
        const text = (await this.fetch(this.m3uUrl)).toString('utf8');
        const entries = assignRefs(parseM3u(text));
        if (entries.length === 0) throw new Error('playlist has no playable entries');
        this.entries = entries;
        this.byRef = new Map(entries.map(e => [e.ref, e]));
        this.playlistAt = this.now();
        console.log(`[${this._name}] playlist: ${entries.length} channel(s)`);
      } catch (e) {
        // Keep serving the last good playlist; a transient upstream blip
        // shouldn't empty the lineup.
        console.error(`[${this._name}] playlist ${this.m3uUrl}: ${e.message}`);
      }
    })();
    try {
      await this.playlistLoading;
    } finally {
      this.playlistLoading = null;
    }
  }

  async listLinearChannels() {
    await this._loadPlaylist();
    return this.entries.map(e => ({
      name: e.name,
      ref: e.ref,
      logo: e.logo || '',
      group: this.groupOverride || e.group || 'Live TV',
    }));
  }

  async _loadGuide() {
    if (!this.epgUrl) return null;
    if (this.guide && this.now() - this.guideAt < GUIDE_TTL_MS) return this.guide;
    if (this.guideLoading) return this.guideLoading;
    this.guideLoading = (async () => {
      try {
        const xml = (await this.fetch(this.epgUrl)).toString('utf8');
        const nowSec = Math.floor(this.now() / 1000);
        // Pass 1: guide channel ids/names, to pair playlist rows lacking a tvg-id.
        const { channels } = parseXmltv(xml, { wantIds: new Set() });
        const guideIdByRef = matchGuideIds(this.entries, channels);
        // Pass 2: programmes for just the channels we carry, inside the window.
        const { programmes } = parseXmltv(xml, {
          wantIds: new Set(guideIdByRef.values()),
          fromSec: nowSec - GUIDE_PAST_SEC,
          toSec: nowSec + GUIDE_AHEAD_SEC,
        });
        this.guide = { guideIdByRef, programmes };
        this.guideAt = this.now();
        console.log(
          `[${this._name}] guide: ${guideIdByRef.size}/${this.entries.length} channel(s) matched`,
        );
      } catch (e) {
        console.error(`[${this._name}] guide ${this.epgUrl}: ${e.message}`);
      }
      return this.guide;
    })();
    try {
      return await this.guideLoading;
    } finally {
      this.guideLoading = null;
    }
  }

  async getEpgData() {
    await this._loadPlaylist();
    const guide = await this._loadGuide();
    const items = this.entries.map(e => ({ name: e.name, chid: e.ref, logo: e.logo || null }));
    const programmesByChid = {};
    if (guide) {
      for (const e of this.entries) {
        const id = guide.guideIdByRef.get(e.ref);
        const progs = id && guide.programmes.get(id);
        if (progs) programmesByChid[e.ref] = progs;
      }
    }
    return { items, programmesByChid };
  }

  async resolveStream(ref) {
    let e = this.byRef.get(ref);
    if (!e) {
      // The playlist may have rotated since the M3U was served; reload once.
      await this._loadPlaylist({ force: true });
      e = this.byRef.get(ref);
    }
    if (!e) throw new Error(`${this._name}: unknown channel ${ref}`);
    const headers = { ...e.headers };
    // Only header-locked streams need the proxy; leave the rest as a redirect.
    if (Object.keys(headers).length > 0 && !headers['User-Agent']) headers['User-Agent'] = UA;
    return Object.keys(headers).length > 0 ? { url: e.url, headers } : { url: e.url };
  }
}

// GET a playlist/guide as a Buffer, gunzipping .gz guides (by magic bytes, not
// extension — some hosts serve gzip without saying so).
async function defaultFetch(url) {
  const r = await axios.get(url, {
    headers: { 'User-Agent': UA, Accept: '*/*' },
    responseType: 'arraybuffer',
    timeout: 60000,
    maxRedirects: 5,
    maxContentLength: MAX_DOWNLOAD_BYTES,
    validateStatus: () => true,
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(r.data);
  return buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;
}

module.exports = M3uProvider;
module.exports.defaultFetch = defaultFetch;
