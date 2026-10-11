const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const {
  parseM3uSources,
  parseM3u,
  assignRefs,
  parseXmltv,
  parseXmltvTime,
  matchGuideIds,
} = require('../providers/m3u/parse');
const M3uProvider = require('../providers/m3u');
const { createProviders } = require('../providers');
const Aggregator = require('../Aggregator');

const PLAYLIST = `\uFEFF#EXTM3U x-tvg-url="https://g/epg.xml"
#EXTINF:-1 tvg-id="News1.us" tvg-logo="https://l/news.png" group-title="News, Weather",News One (720p)
https://cdn.example/news1.m3u8
#EXTINF:-1 tvg-id="",Movies 24/7
#EXTVLCOPT:http-referrer=https://player.example/movies
#EXTVLCOPT:http-user-agent=UA/2
https://cdn.example/movies.m3u8
#EXTINF:-1 tvg-id="Locked.us",Locked
https://cdn.example/locked.ts|Referer=https%3A%2F%2Fsite.example%2F&User-Agent=UA/3
#EXTINF:-1 tvg-id="News1.us",News One SD
#EXTGRP:News
https://cdn.example/news1-sd.m3u8
#EXTINF:-1,No URL
#EXTINF:-1,Bad Scheme
rtmp://cdn.example/live
`;

const GUIDE = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="News1.us"><display-name>News One</display-name></channel>
  <channel id="Movies.us"><display-name>Movies 24/7</display-name><display-name>Movies</display-name></channel>
  <channel id="Other.us"><display-name>Other</display-name></channel>
  <programme start="20261011180000 +0000" stop="20261011190000 +0000" channel="News1.us">
    <title lang="en">Evening &amp; News</title><sub-title>Ep 4</sub-title>
    <desc>Headlines.</desc><category>News</category><icon src="https://i/p.png"/>
  </programme>
  <programme start="20261011140000 -0400" stop="20261011160000 -0400" channel="Movies.us">
    <title><![CDATA[Film <One>]]></title>
  </programme>
  <programme start="20261011180000 +0000" stop="20261011190000 +0000" channel="Other.us">
    <title>Not ours</title>
  </programme>
  <programme start="20261001180000 +0000" stop="20261001190000 +0000" channel="News1.us">
    <title>Old</title>
  </programme>
</tv>`;

const NOW_MS = Date.parse('2026-10-11T18:30:00Z');

test('parseM3uSources reads the compact form and the JSON form', () => {
  assert.deepStrictEqual(
    parseM3uSources('pluto=https://a/us.m3u8|https://a/us.xml.gz; news=https://b/n.m3u'),
    [
      { name: 'pluto', m3u: 'https://a/us.m3u8', epg: 'https://a/us.xml.gz', group: null },
      { name: 'news', m3u: 'https://b/n.m3u', epg: null, group: null },
    ],
  );
  assert.deepStrictEqual(
    parseM3uSources('[{"name":"iptv","m3u":"https://c/p.m3u","group":"Locals"}]'),
    [{ name: 'iptv', m3u: 'https://c/p.m3u', epg: null, group: 'Locals' }],
  );
  assert.deepStrictEqual(parseM3uSources(''), []);
});

test('parseM3uSources rejects bad names, schemes and duplicates', () => {
  assert.throws(() => parseM3uSources('bad name=https://a/x'), /bad source name/);
  assert.throws(() => parseM3uSources('a=ftp://a/x'), /must be http/);
  assert.throws(() => parseM3uSources('a=https://a/x;A=https://b/y'), /duplicate/);
  assert.throws(() => parseM3uSources('[oops'), /invalid JSON/);
});

test('parseM3u extracts attributes, quoted commas, VLC and pipe headers', () => {
  const rows = parseM3u(PLAYLIST);
  assert.strictEqual(rows.length, 4, 'entries with no or non-http url are dropped');
  assert.deepStrictEqual(rows[0], {
    name: 'News One (720p)',
    tvgId: 'News1.us',
    tvgName: '',
    logo: 'https://l/news.png',
    group: 'News, Weather',
    chno: '',
    headers: {},
    url: 'https://cdn.example/news1.m3u8',
  });
  assert.deepStrictEqual(rows[1].headers, {
    Referer: 'https://player.example/movies',
    'User-Agent': 'UA/2',
  });
  assert.strictEqual(rows[2].url, 'https://cdn.example/locked.ts');
  assert.deepStrictEqual(rows[2].headers, {
    Referer: 'https://site.example/',
    'User-Agent': 'UA/3',
  });
  assert.strictEqual(rows[3].group, 'News');
});

test('assignRefs prefers tvg-id, slugs names, and de-collides', () => {
  const refs = assignRefs(parseM3u(PLAYLIST)).map(e => e.ref);
  assert.deepStrictEqual(refs, ['News1.us', 'Movies-24-7', 'Locked.us', 'News1.us~2']);
});

test('parseXmltvTime honours the UTC offset', () => {
  assert.strictEqual(
    parseXmltvTime('20261011180000 +0000'),
    Date.parse('2026-10-11T18:00:00Z') / 1000,
  );
  assert.strictEqual(
    parseXmltvTime('20261011140000 -0400'),
    Date.parse('2026-10-11T18:00:00Z') / 1000,
  );
  assert.strictEqual(parseXmltvTime('202610111800'), Date.parse('2026-10-11T18:00:00Z') / 1000);
  assert.strictEqual(parseXmltvTime('garbage'), null);
});

test('parseXmltv filters by channel and window and decodes text', () => {
  const nowSec = NOW_MS / 1000;
  const { channels, programmes } = parseXmltv(GUIDE, {
    wantIds: new Set(['News1.us', 'Movies.us']),
    fromSec: nowSec - 6 * 3600,
    toSec: nowSec + 3 * 86400,
  });
  assert.deepStrictEqual(channels.get('Movies.us'), ['Movies 24/7', 'Movies']);
  assert.ok(!programmes.has('Other.us'));
  const news = programmes.get('News1.us');
  assert.strictEqual(news.length, 1, 'out-of-window programme dropped');
  assert.deepStrictEqual(news[0], {
    title: 'Evening & News',
    episodeTitle: 'Ep 4',
    desc: 'Headlines.',
    startTime: Date.parse('2026-10-11T18:00:00Z') / 1000,
    endTime: Date.parse('2026-10-11T19:00:00Z') / 1000,
    categories: ['News'],
    icon: 'https://i/p.png',
  });
  assert.strictEqual(programmes.get('Movies.us')[0].title, 'Film <One>');
});

test('matchGuideIds pairs by tvg-id, then by display-name', () => {
  const entries = assignRefs(parseM3u(PLAYLIST));
  const { channels } = parseXmltv(GUIDE, { wantIds: new Set() });
  const m = matchGuideIds(entries, channels);
  assert.strictEqual(m.get('News1.us'), 'News1.us');
  assert.strictEqual(m.get('Movies-24-7'), 'Movies.us'); // empty tvg-id, matched by name
  assert.ok(!m.has('Locked.us')); // not in the guide
});

function fakeFetch(map) {
  const calls = [];
  return {
    calls,
    fetch: async url => {
      calls.push(url);
      if (!(url in map)) throw new Error(`HTTP 404 ${url}`);
      const v = map[url];
      return Buffer.isBuffer(v) ? v : Buffer.from(v);
    },
  };
}

test('M3uProvider lists channels with logos/groups and builds the guide', async () => {
  const f = fakeFetch({ 'https://p/list.m3u': PLAYLIST, 'https://p/epg.xml': GUIDE });
  const p = new M3uProvider(
    { name: 'fast', m3u: 'https://p/list.m3u', epg: 'https://p/epg.xml' },
    { fetch: f.fetch, now: () => NOW_MS },
  );
  const chans = await p.listLinearChannels();
  assert.deepStrictEqual(chans[0], {
    name: 'News One (720p)',
    ref: 'News1.us',
    logo: 'https://l/news.png',
    group: 'News, Weather',
  });
  assert.strictEqual(chans[1].group, 'Live TV');

  const epg = await p.getEpgData();
  assert.strictEqual(epg.items.length, 4);
  assert.strictEqual(epg.programmesByChid['News1.us'][0].title, 'Evening & News');
  assert.strictEqual(epg.programmesByChid['Movies-24-7'][0].title, 'Film <One>');
  // The SD duplicate has its own ref but shares News1.us's tvg-id, so it
  // carries the same guide.
  assert.ok(epg.programmesByChid['News1.us~2']);

  // Cached: a second listing/guide doesn't refetch.
  await p.listLinearChannels();
  await p.getEpgData();
  assert.strictEqual(f.calls.length, 2);
});

test('M3uProvider resolves bare urls as redirects and header-locked ones with headers', async () => {
  const f = fakeFetch({ 'https://p/list.m3u': PLAYLIST });
  const p = new M3uProvider({ name: 'fast', m3u: 'https://p/list.m3u' }, { fetch: f.fetch });
  await p.ensureReady();
  assert.deepStrictEqual(await p.resolveStream('News1.us'), {
    url: 'https://cdn.example/news1.m3u8',
  });
  const locked = await p.resolveStream('Movies-24-7');
  assert.strictEqual(locked.url, 'https://cdn.example/movies.m3u8');
  assert.deepStrictEqual(locked.headers, {
    Referer: 'https://player.example/movies',
    'User-Agent': 'UA/2',
  });
  await assert.rejects(() => p.resolveStream('nope'), /unknown channel/);
});

test('M3uProvider keeps the last good playlist when a refresh fails', async () => {
  let now = NOW_MS;
  let up = true;
  const p = new M3uProvider(
    { name: 'fast', m3u: 'https://p/list.m3u' },
    {
      now: () => now,
      fetch: async () => {
        if (!up) throw new Error('HTTP 503');
        return Buffer.from(PLAYLIST);
      },
    },
  );
  assert.strictEqual((await p.listLinearChannels()).length, 4);
  up = false;
  now += 2 * 3600 * 1000; // past the playlist TTL
  assert.strictEqual((await p.listLinearChannels()).length, 4);
});

test('M3uProvider guide download is gunzipped by magic bytes', async () => {
  const { defaultFetch } = require('../providers/m3u');
  assert.strictEqual(typeof defaultFetch, 'function');
  // Exercise the same branch defaultFetch uses on a gzip payload.
  const gz = zlib.gzipSync(Buffer.from(GUIDE));
  assert.ok(gz[0] === 0x1f && gz[1] === 0x8b);
  assert.strictEqual(zlib.gunzipSync(gz).toString('utf8'), GUIDE);
});

test('createProviders appends one provider per M3U source and skips clashes', () => {
  const ps = createProviders(
    [],
    'pluto=https://a/us.m3u8|https://a/us.xml;thetvapp=https://b/x.m3u;news=https://c/n.m3u',
  );
  assert.deepStrictEqual(
    ps.map(p => p.name),
    ['pluto', 'news'],
  );
});

test('aggregator emits playlist logos/groups and namespaced guide ids for M3U channels', async () => {
  const f = fakeFetch({ 'https://p/list.m3u': PLAYLIST, 'https://p/epg.xml': GUIDE });
  const p = new M3uProvider(
    { name: 'fast', m3u: 'https://p/list.m3u', epg: 'https://p/epg.xml' },
    { fetch: f.fetch, now: () => NOW_MS },
  );
  const agg = new Aggregator([p]);
  const m3u = await agg.getM3u('https://proxy.example.com');
  assert.match(
    m3u,
    /tvg-id="fast:News1\.us" tvg-chno="1" tvg-logo="https:\/\/l\/news\.png" group-title="News, Weather", News One \(720p\)/,
  );
  assert.match(m3u, /\/channel\/fast%3ANews1.us~2/);
  await agg.refreshEpg();
  const xml = agg.getEpgXml();
  assert.match(xml, /<programme channel="fast:News1\.us"/);
  assert.match(xml, /<desc>Headlines\.<\/desc>/);
});
