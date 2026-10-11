const { decodeXML } = require('entities');

// Pure parsing for the generic M3U + XMLTV source. No network here so it stays
// deterministic and unit-testable; the provider wires these to a fetcher.
//
// Meant for licensed / free-to-air feeds that already publish a playlist and a
// guide: FAST services (Pluto TV, Samsung TV Plus, Plex, Roku, Tubi, Xumo),
// public broadcasters, or an IPTV subscription you pay for.

// --- Source configuration ----------------------------------------------------

const SOURCE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

// M3U_SOURCES accepts either
//   name=<m3u url>|<xmltv url>;name2=<m3u url>
// (the guide url is optional) or a JSON array of
//   { "name", "m3u", "epg"?, "group"? }
// for anything the compact form can't express, e.g. a fixed group-title.
function parseM3uSources(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  let list;
  if (s.startsWith('[')) {
    try {
      list = JSON.parse(s);
    } catch (e) {
      throw new Error(`M3U_SOURCES: invalid JSON (${e.message})`);
    }
    if (!Array.isArray(list)) throw new Error('M3U_SOURCES: JSON must be an array');
  } else {
    list = s
      .split(';')
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const eq = part.indexOf('=');
        if (eq <= 0) throw new Error(`M3U_SOURCES: expected name=url, got "${part}"`);
        const [m3u, epg] = part.slice(eq + 1).split('|');
        return { name: part.slice(0, eq).trim(), m3u: m3u.trim(), epg: (epg || '').trim() };
      });
  }

  const seen = new Set();
  return list.map(src => {
    const name = String(src?.name ?? '').trim();
    const m3u = String(src?.m3u ?? '').trim();
    if (!SOURCE_NAME_RE.test(name)) {
      throw new Error(`M3U_SOURCES: bad source name "${name}" (letters, digits, - and _)`);
    }
    if (seen.has(name.toLowerCase())) throw new Error(`M3U_SOURCES: duplicate name "${name}"`);
    seen.add(name.toLowerCase());
    if (!/^https?:\/\//i.test(m3u)) throw new Error(`M3U_SOURCES: ${name}: m3u must be http(s)`);
    const epg = String(src?.epg ?? '').trim();
    if (epg && !/^https?:\/\//i.test(epg)) {
      throw new Error(`M3U_SOURCES: ${name}: epg must be http(s)`);
    }
    const group = String(src?.group ?? '').trim();
    return { name, m3u, epg: epg || null, group: group || null };
  });
}

// --- M3U ---------------------------------------------------------------------

// Split an #EXTINF payload into its attribute block and title. The title starts
// after the first comma that isn't inside a quoted attribute value, so
// group-title="News, Weather" doesn't cut the line short.
function splitExtinf(payload) {
  let inQuote = false;
  for (let i = 0; i < payload.length; i++) {
    const c = payload[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ',' && !inQuote) {
      return { attrs: payload.slice(0, i), title: payload.slice(i + 1).trim() };
    }
  }
  return { attrs: payload, title: '' };
}

function parseAttrs(s) {
  const out = {};
  for (const m of s.matchAll(/([A-Za-z0-9_-]+)="([^"]*)"/g)) out[m[1].toLowerCase()] = m[2];
  return out;
}

// Kodi-style inline headers: "https://host/x.m3u8|Referer=https://a/&User-Agent=UA".
function splitPipeHeaders(line) {
  const idx = line.indexOf('|');
  if (idx < 0) return { url: line, headers: {} };
  const tail = line.slice(idx + 1);
  if (!/^[A-Za-z-]+=/.test(tail)) return { url: line, headers: {} };
  const headers = {};
  for (const pair of tail.split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    let value = pair.slice(eq + 1);
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep the raw value
    }
    headers[canonicalHeader(pair.slice(0, eq))] = value;
  }
  return { url: line.slice(0, idx), headers };
}

function canonicalHeader(name) {
  const k = String(name).trim().toLowerCase();
  if (k === 'referer' || k === 'referrer') return 'Referer';
  if (k === 'user-agent') return 'User-Agent';
  if (k === 'origin') return 'Origin';
  return String(name).trim();
}

// #EXTVLCOPT:http-referrer=... / http-user-agent=... / http-origin=...
const VLC_HEADER = {
  'http-referrer': 'Referer',
  'http-referer': 'Referer',
  'http-user-agent': 'User-Agent',
  'http-origin': 'Origin',
};

// Parse an M3U playlist into
//   [{ name, url, tvgId, tvgName, logo, group, chno, headers }]
// in playlist order. Entries without a playable http(s) url are skipped.
function parseM3u(text) {
  const lines = String(text ?? '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);
  const out = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      const { attrs, title } = splitExtinf(line.slice('#EXTINF:'.length));
      const a = parseAttrs(attrs);
      cur = {
        name: title || a['tvg-name'] || '',
        tvgId: a['tvg-id'] || '',
        tvgName: a['tvg-name'] || '',
        logo: a['tvg-logo'] || '',
        group: a['group-title'] || '',
        chno: a['tvg-chno'] || a['channel-number'] || '',
        headers: {},
      };
      continue;
    }
    if (!cur) continue; // header lines / stray tags before the first entry
    if (line.startsWith('#EXTVLCOPT:')) {
      const opt = line.slice('#EXTVLCOPT:'.length);
      const eq = opt.indexOf('=');
      const header = eq > 0 ? VLC_HEADER[opt.slice(0, eq).trim().toLowerCase()] : null;
      if (header) cur.headers[header] = opt.slice(eq + 1).trim();
      continue;
    }
    if (line.startsWith('#EXTGRP:')) {
      if (!cur.group) cur.group = line.slice('#EXTGRP:'.length).trim();
      continue;
    }
    if (line.startsWith('#')) continue; // #KODIPROP, #EXT-X-*, comments
    const { url, headers } = splitPipeHeaders(line);
    if (/^https?:\/\//i.test(url) && cur.name) {
      out.push({ ...cur, url, headers: { ...cur.headers, ...headers } });
    }
    cur = null;
  }
  return out;
}

// Stable, URL/XMLTV-safe per-channel ref. tvg-id when the playlist has one
// (it's what the guide keys on); otherwise a slug of the name. Collisions —
// SD/HD variants sharing a tvg-id, two "News" channels — get a numeric suffix
// so every row stays independently playable.
function assignRefs(entries) {
  const used = new Set();
  return entries.map(e => {
    const base =
      (e.tvgId || e.name)
        .trim()
        .replace(/[^A-Za-z0-9._@-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'ch';
    let ref = base;
    for (let n = 2; used.has(ref.toLowerCase()); n++) ref = `${base}~${n}`;
    used.add(ref.toLowerCase());
    return { ...e, ref };
  });
}

// --- XMLTV -------------------------------------------------------------------

// "20261011193000 +0000" (offset optional, seconds optional) -> unix seconds.
function parseXmltvTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/.exec(String(s ?? ''));
  if (!m) return null;
  let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (m[7]) {
    const sign = m[7][0] === '-' ? -1 : 1;
    ms -= sign * (+m[7].slice(1, 3) * 60 + +m[7].slice(3, 5)) * 60000;
  }
  return Math.floor(ms / 1000);
}

function attr(attrs, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return m ? decodeXML(m[1]) : null;
}

function firstText(body, tag) {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(body);
  return m ? decodeXML(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim() : '';
}

function allText(body, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  return [...body.matchAll(re)].map(m => decodeXML(m[1]).trim()).filter(Boolean);
}

// Scan an XMLTV document for the channels we carry. Regex scanning rather than
// a DOM: FAST-service guides run to tens of MB, and only the handful of fields
// buildXmltv emits are needed.
//
// opts: { wantIds: Set<string> | null, fromSec, toSec }
// Returns { channels: Map<id, displayName[]>, programmes: Map<id, prog[]> }
// where prog = { title, episodeTitle, desc, startTime, endTime, categories, icon }.
function parseXmltv(xml, { wantIds = null, fromSec = -Infinity, toSec = Infinity } = {}) {
  const s = String(xml ?? '');
  const channels = new Map();
  for (const m of s.matchAll(/<channel\b([^>]*)>([\s\S]*?)<\/channel>/g)) {
    const id = attr(m[1], 'id');
    if (!id) continue;
    channels.set(id, allText(m[2], 'display-name'));
  }

  const programmes = new Map();
  const re = /<programme\b([^>]*?)(?:\/>|>([\s\S]*?)<\/programme>)/g;
  for (const m of s.matchAll(re)) {
    const id = attr(m[1], 'channel');
    if (!id || (wantIds && !wantIds.has(id))) continue;
    const startTime = parseXmltvTime(attr(m[1], 'start'));
    const endTime = parseXmltvTime(attr(m[1], 'stop'));
    if (startTime == null || endTime == null) continue;
    if (endTime < fromSec || startTime > toSec) continue;
    const body = m[2] || '';
    const title = firstText(body, 'title');
    if (!title) continue;
    const iconM = /<icon\b[^>]*\bsrc="([^"]*)"/.exec(body);
    const prog = {
      title,
      episodeTitle: firstText(body, 'sub-title') || undefined,
      desc: firstText(body, 'desc') || undefined,
      startTime,
      endTime,
      categories: allText(body, 'category'),
      icon: iconM ? decodeXML(iconM[1]) : undefined,
    };
    const list = programmes.get(id);
    if (list) list.push(prog);
    else programmes.set(id, [prog]);
  }
  for (const list of programmes.values()) list.sort((a, b) => a.startTime - b.startTime);
  return { channels, programmes };
}

// Lowercased, punctuation-free name used to pair an M3U row that has no tvg-id
// with an XMLTV channel by display-name.
function nameKey(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\((?:\d{3,4}p|sd|hd|fhd|uhd|4k)\)/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Guide channel id for each playlist entry: its tvg-id when the guide has it,
// else an XMLTV channel whose display-name matches the entry's name.
function matchGuideIds(entries, guideChannels) {
  const byName = new Map();
  for (const [id, names] of guideChannels) {
    for (const n of names) {
      const k = nameKey(n);
      if (k && !byName.has(k)) byName.set(k, id);
    }
  }
  const out = new Map(); // ref -> guide channel id
  for (const e of entries) {
    if (e.tvgId && guideChannels.has(e.tvgId)) out.set(e.ref, e.tvgId);
    else {
      const id = byName.get(nameKey(e.tvgName || e.name)) || byName.get(nameKey(e.name));
      if (id) out.set(e.ref, id);
    }
  }
  return out;
}

module.exports = {
  parseM3uSources,
  parseM3u,
  assignRefs,
  parseXmltv,
  parseXmltvTime,
  matchGuideIds,
  nameKey,
};
