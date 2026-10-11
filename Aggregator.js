const { buildXmltv } = require('./ChannelManager');
const { getChannelLogos } = require('./utils');
const { canonicalKey, canonicalEventId, stripTime, sameGame } = require('./canonicalName');
const { pickEventLogo, pickMatchupLogos } = require('./eventLogos');
const { normalizeLeagueLabel, normalizeEventName, stripLeaguePrefix } = require('./displayName');
const { PUBLIC_BASE_URL, STREAM_CACHE_MS } = require('./config');

// M3U attributes are double-quoted and the title follows the last comma, so a
// stray quote or newline in a source-supplied string corrupts the row (and the
// rows after it, for parsers that don't resync on #EXTINF).
function m3uAttr(s) {
  return String(s ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, "'");
}
function m3uTitle(s) {
  return String(s ?? '').replace(/[\r\n]+/g, ' ');
}

// Rendered artwork lives behind /logo/event and is addressed by the same
// display strings that appear in the guide, so one URL covers crest-backed and
// text-only events alike.
function eventArtUrl(base, ev, fmt) {
  const q = [
    `fmt=${fmt}`,
    `league=${encodeURIComponent(ev.league || '')}`,
    `name=${encodeURIComponent(ev.name || '')}`,
  ];
  if (ev.startSec) q.push(`t=${ev.startSec}`);
  return `${base}/logo/event?${q.join('&')}`;
}

// listLinearChannels() returns either the legacy { displayName: ref } map or an
// array of { name, ref, logo?, group? } (playlist-backed sources, which carry
// their own artwork/groups and can list two channels under one name).
function normalizeLinear(channels) {
  if (Array.isArray(channels)) {
    return channels.filter(c => c && c.name && c.ref != null && c.ref !== '');
  }
  return Object.entries(channels || {}).map(([name, ref]) => ({ name, ref }));
}

// Fans the M3U/EPG/stream surface out across N providers:
//   - linear channels are namespaced per provider (id `${provider}:${ref}`)
//   - events are deduped by cross-provider canonical identity, keeping an
//     ordered source list so a dead link at record time falls through to the
//     next provider
//   - EPG folds every provider's linear guide together with synthesized event
//     programmes, all keyed to the same ids the M3U emits
//
// Downstream (Dispatcharr/Plex) never sees provider boundaries: one channel per
// game, league as the group-title, "@ <time>" preserved in the name. That's
// what keeps the recording scheduler provider-agnostic.
class Aggregator {
  constructor(providers) {
    this.providers = providers || [];
    this._providerByName = new Map(this.providers.map(p => [p.name, p]));
    this.streamIndex = new Map(); // publicId -> [{ providerName, ref }]
    // publicId -> { stream, sourceKey, expires }. Players re-request the entry
    // URL on reconnect (and on every reload when the upstream entry is a media
    // playlist), so without this each poll re-ran the full resolve — for
    // DaddyLive that's a headless-browser session per request.
    this._resolved = new Map();
    this.streamCacheMs = STREAM_CACHE_MS;
    this.epgXml = null;
    this.epgLastRefresh = 0;
    this.epgRefreshing = null;
  }

  async ensureReady() {
    await Promise.all(
      this.providers.map(p =>
        p.ensureReady().catch(e => console.error(`[${p.name}] ensureReady: ${e.message}`)),
      ),
    );
  }

  async refreshEvents() {
    await Promise.all(
      this.providers.map(p =>
        p.refreshEvents().catch(e => console.error(`[${p.name}] refreshEvents: ${e.message}`)),
      ),
    );
  }

  // Collect every provider's events and collapse same-game duplicates. Each
  // returned entry carries the ordered fallback `sources`.
  async _dedupeEvents() {
    const byKey = new Map();
    for (const p of this.providers) {
      let events = [];
      try {
        events = await p.listEvents();
      } catch (e) {
        console.error(`[${p.name}] listEvents: ${e.message}`);
      }
      for (const ev of events) {
        if (!ev || !ev.streamRef) continue;
        // Strip the source's own emoji/flag decoration before anything derives
        // from these strings. The league is part of the canonical key, so
        // leaving it raw splits one game's league ("⚾ 🇨🇦 MLB" vs "⚾ 🇺🇸 MLB")
        // into separate dedup buckets and separate Dispatcharr channel groups.
        const league = normalizeLeagueLabel(ev.league);
        // The source now bakes the league into the matchup too; without this the
        // guide title prepends it a second time ("MLB: MLB: Tigers vs ...").
        const name = stripLeaguePrefix(normalizeEventName(ev.name), league);
        const normalized = { ...ev, league, name };
        const key = canonicalKey(normalized);
        // Exact identity first; then the looser same-game test so a source that
        // spells a team differently, or rounds the start across a UTC midnight,
        // lands as a fallback on the existing channel instead of a duplicate.
        let bucket = byKey.get(key);
        if (!bucket) {
          for (const b of byKey.values()) {
            if (sameGame(b, normalized)) {
              bucket = b;
              break;
            }
          }
          if (bucket) byKey.set(key, bucket);
        }
        if (!bucket) {
          const matchup = pickMatchupLogos({ league, name });
          bucket = {
            id: canonicalEventId(normalized),
            name,
            league,
            logo:
              ev.logo || (matchup ? matchup.away : null) || pickEventLogo({ league, name }) || '',
            awayLogo: matchup ? matchup.away : null,
            homeLogo: matchup ? matchup.home : null,
            startSec: ev.startSec,
            endSec: ev.endSec,
            sources: [],
          };
          byKey.set(key, bucket);
        }
        // A source may carry alternate feeds for the same game (dlhd lists
        // several channels per event); queue them right behind the primary so a
        // dead feed falls through to the provider's next one before the next
        // provider.
        const refs = [ev.streamRef, ...(Array.isArray(ev.altStreamRefs) ? ev.altStreamRefs : [])];
        for (const ref of refs) {
          if (ref == null || ref === '') continue;
          const dup = bucket.sources.some(s => s.providerName === p.name && s.ref === ref);
          if (!dup) bucket.sources.push({ providerName: p.name, ref });
        }
      }
    }
    // byKey can alias one bucket under several keys after a fuzzy match.
    return [...new Set(byKey.values())].sort(
      (a, b) => (a.startSec || 0) - (b.startSec || 0) || a.name.localeCompare(b.name),
    );
  }

  // Build merged M3U rows and (re)populate the stream index that resolveStream
  // reads. Returns { linearEntries, eventEntries } for formatting/tests.
  async listM3uEntries(base = '') {
    const index = new Map();
    const logos = await getChannelLogos().catch(() => ({ channels: [] }));
    const logoByName = new Map(
      (logos.channels || []).filter(c => c?.name && c?.logo).map(c => [c.name, c.logo]),
    );

    const linearEntries = [];
    for (const p of this.providers) {
      let channels = {};
      try {
        channels = await p.listLinearChannels();
      } catch (e) {
        console.error(`[${p.name}] listLinearChannels: ${e.message}`);
      }
      for (const ch of normalizeLinear(channels)) {
        const streamId = `${p.name}:${ch.ref}`;
        index.set(streamId, [{ providerName: p.name, ref: ch.ref }]);
        linearEntries.push({
          tvgId: streamId,
          name: ch.name,
          group: ch.group || 'Live TV',
          logo: ch.logo || logoByName.get(ch.name) || '',
          streamId,
        });
      }
    }

    const eventEntries = (await this._dedupeEvents()).map(ev => {
      // Every event gets rendered art when we know our public base URL — the
      // renderer falls back to text for leagues with no crest table, so no
      // event ships a blank tvg-logo.
      const logo = base ? eventArtUrl(base, ev, 'thumb') : ev.logo;
      index.set(ev.id, ev.sources);
      return {
        tvgId: ev.id,
        name: ev.name,
        group: ev.league,
        logo,
        streamId: ev.id,
        startSec: ev.startSec,
      };
    });

    this.streamIndex = index;
    return { linearEntries, eventEntries };
  }

  async getM3u(base) {
    const { linearEntries, eventEntries } = await this.listM3uEntries(base);
    let chno = 0;
    let m3u = '#EXTM3U';
    for (const e of [...linearEntries, ...eventEntries]) {
      chno++;
      m3u +=
        `\n#EXTINF:-1 tvg-id="${m3uAttr(e.tvgId)}" tvg-chno="${chno}" tvg-logo="${m3uAttr(e.logo)}" group-title="${m3uAttr(e.group)}", ${m3uTitle(e.name)}` +
        `\n${base}/channel/${encodeURIComponent(e.streamId)}`;
    }
    return m3u;
  }

  async refreshEpg() {
    if (this.epgRefreshing) return this.epgRefreshing;
    this.epgRefreshing = (async () => {
      const allItems = [];
      const allProgrammes = {};

      for (const p of this.providers) {
        let data = { items: [], programmesByChid: {} };
        try {
          data = await p.getEpgData();
        } catch (e) {
          console.error(`[${p.name}] getEpgData: ${e.message}`);
        }
        // Namespace linear guide ids to match the `${provider}:${ref}` tvg-ids
        // listM3uEntries emits, so Plex pairs each channel with its guide.
        for (const it of data.items || []) {
          allItems.push({ ...it, chid: `${p.name}:${it.chid}` });
        }
        for (const [chid, progs] of Object.entries(data.programmesByChid || {})) {
          allProgrammes[`${p.name}:${chid}`] = progs;
        }
      }

      // Synthesize one programme per deduped event, keyed to the same id the
      // M3U emits so Plex pairs the row with its guide entry.
      for (const ev of await this._dedupeEvents()) {
        // The channel name keeps the "@ <time>" suffix (Dispatcharr's recording
        // scheduler parses it out of Channel.name); the programme title drops it
        // because Plex already renders the time slot.
        const title = `${ev.league}: ${stripTime(ev.name)}`;
        const base = PUBLIC_BASE_URL;
        allItems.push({
          name: title,
          chid: ev.id,
          logo: (base ? eventArtUrl(base, ev, 'thumb') : ev.logo) || null,
        });
        // Tag as Sports (+ the league) so Plex categorizes these in its Sports
        // hub with the right artwork/metadata.
        const categories = [...new Set(['Sports', ev.league].filter(Boolean))];
        // Programme-level icon drives Plex poster art, which it renders in a 2:3
        // frame — hence the portrait format here and the landscape one above.
        const icon = base ? eventArtUrl(base, ev, 'poster') : ev.logo || null;
        allProgrammes[ev.id] = [
          { title, startTime: ev.startSec, endTime: ev.endSec, categories, icon },
        ];
      }

      const { xml, programmeCount } = buildXmltv(allItems, allProgrammes);
      this.epgXml = xml;
      this.epgLastRefresh = Date.now();
      console.log(`[epg] refreshed: ${allItems.length} channels, ${programmeCount} programmes`);
    })();
    try {
      await this.epgRefreshing;
    } finally {
      this.epgRefreshing = null;
    }
  }

  getEpgXml() {
    return this.epgXml;
  }

  // Resolve a public id to a playable stream, trying each source in order.
  //
  // `validate(stream)` (optional) is called on every candidate and must return
  // a truthy value only when the stream actually plays — app.js passes a
  // manifest fetch, so a provider that hands back a dead or geo-blocked URL
  // falls through to the next source instead of ending the request. Whatever
  // validate returns is passed back as `check` so the caller can reuse it
  // (e.g. the manifest body it already downloaded).
  //
  // A validated stream is cached per id; the cached URL is re-validated on use,
  // so an expired token costs one failed check and a fresh resolve.
  async resolveStream(publicId, { validate } = {}) {
    const sources = this.streamIndex.get(publicId);
    if (!sources || sources.length === 0) throw new Error(`unknown stream id: ${publicId}`);

    const cached = this._resolved.get(publicId);
    if (cached && cached.expires > Date.now()) {
      if (!validate) return cached.stream;
      const check = await Promise.resolve(validate(cached.stream)).catch(() => null);
      if (check) return { ...cached.stream, check };
      this._resolved.delete(publicId);
    }

    let lastErr;
    for (const { providerName, ref } of sources) {
      const provider = this._providerByName.get(providerName);
      if (!provider) continue;
      try {
        const res = await provider.resolveStream(ref);
        if (!res || !res.url) continue;
        let check;
        if (validate) {
          check = await validate(res);
          if (!check) {
            lastErr = new Error(`${providerName}:${ref} resolved but did not validate`);
            console.error(`[${providerName}] resolveStream(${ref}): stream did not validate`);
            continue;
          }
        }
        if (this.streamCacheMs > 0) {
          this._resolved.set(publicId, { stream: res, expires: Date.now() + this.streamCacheMs });
        }
        return check === undefined ? res : { ...res, check };
      } catch (e) {
        lastErr = e;
        console.error(`[${providerName}] resolveStream(${ref}): ${e.message}`);
      }
    }
    throw lastErr || new Error(`no source resolved for ${publicId}`);
  }

  // Drop a cached resolution (e.g. after the upstream starts failing mid-play).
  invalidateStream(publicId) {
    this._resolved.delete(publicId);
  }
}

module.exports = Aggregator;
