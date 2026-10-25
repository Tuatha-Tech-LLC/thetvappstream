const test = require('node:test');
const assert = require('node:assert');
const Aggregator = require('../Aggregator');

// In-memory provider so the aggregator can be exercised without network or the
// thetvapp.to scrapers.
class FakeProvider {
  constructor(
    name,
    { linear = {}, events = [], epg = { items: [], programmesByChid: {} }, failRefs = [] } = {},
  ) {
    this._name = name;
    this.linear = linear;
    this.events = events;
    this.epg = epg;
    this.failRefs = new Set(failRefs);
    this.resolved = [];
  }
  get name() {
    return this._name;
  }
  async ensureReady() {}
  async refreshEvents() {}
  async listLinearChannels() {
    return this.linear;
  }
  async listEvents() {
    return this.events;
  }
  async getEpgData() {
    return this.epg;
  }
  async resolveStream(ref) {
    this.resolved.push(ref);
    if (this.failRefs.has(ref)) throw new Error(`fail ${ref}`);
    return { url: `http://stream/${this._name}/${ref}` };
  }
}

const START = Date.parse('2026-05-22T23:10:00Z') / 1000;
const END = START + 3 * 3600;

function gameEvent(name, streamRef) {
  return { league: 'MLB', name, startSec: START, endSec: END, streamRef };
}

test('getM3u emits linear + event rows with provider-scoped stream urls', async () => {
  const p = new FakeProvider('thetvapp', {
    linear: { CNN: '101', ESPN: '102' },
    events: [gameEvent('Minnesota Twins vs Boston Red Sox @ May 22 7:10 PM', 'slot9')],
  });
  const agg = new Aggregator([p]);
  const m3u = await agg.getM3u('https://proxy.example.com');

  assert.match(m3u, /^#EXTM3U/);
  assert.match(m3u, /group-title="Live TV", CNN/);
  assert.match(m3u, /https:\/\/proxy\.example\.com\/channel\/thetvapp%3A101/);
  assert.match(m3u, /group-title="MLB", Minnesota Twins vs Boston Red Sox @ May 22 7:10 PM/);
});

test('linear stream ids resolve back to the owning provider', async () => {
  const p = new FakeProvider('thetvapp', { linear: { CNN: '101' } });
  const agg = new Aggregator([p]);
  await agg.listM3uEntries();
  const { url } = await agg.resolveStream('thetvapp:101');
  assert.strictEqual(url, 'http://stream/thetvapp/101');
});

test('same game from two providers dedupes to one entry with ordered fallback', async () => {
  const a = new FakeProvider('thetvapp', {
    events: [gameEvent('Minnesota Twins vs Boston Red Sox @ May 22 7:10 PM', 'tva')],
  });
  const b = new FakeProvider('streameast', {
    events: [gameEvent('Boston Red Sox vs Minnesota Twins @ May 22 7:10 PM', 'sea')],
  });
  const agg = new Aggregator([a, b]);

  const { eventEntries } = await agg.listM3uEntries();
  assert.strictEqual(eventEntries.length, 1);

  const sources = agg.streamIndex.get(eventEntries[0].streamId);
  assert.deepStrictEqual(
    sources.map(s => s.providerName),
    ['thetvapp', 'streameast'],
  );
});

test('resolveStream falls through to the next source when the first fails', async () => {
  const a = new FakeProvider('thetvapp', {
    events: [gameEvent('Minnesota Twins vs Boston Red Sox @ May 22 7:10 PM', 'tva')],
    failRefs: ['tva'],
  });
  const b = new FakeProvider('streameast', {
    events: [gameEvent('Boston Red Sox vs Minnesota Twins @ May 22 7:10 PM', 'sea')],
  });
  const agg = new Aggregator([a, b]);
  const { eventEntries } = await agg.listM3uEntries();

  const { url } = await agg.resolveStream(eventEntries[0].streamId);
  assert.strictEqual(url, 'http://stream/streameast/sea');
  assert.deepStrictEqual(a.resolved, ['tva']); // first source was attempted
});

test('resolveStream throws for an unknown id', async () => {
  const agg = new Aggregator([new FakeProvider('thetvapp')]);
  await agg.listM3uEntries();
  await assert.rejects(() => agg.resolveStream('nope'), /unknown stream id/);
});

test('refreshEpg merges linear guides and synthesizes event programmes', async () => {
  const p = new FakeProvider('thetvapp', {
    events: [gameEvent('Twins vs Red Sox @ May 22 7:10 PM', 'slot9')],
    epg: {
      items: [{ name: 'CNN', chid: '101', logo: null }],
      programmesByChid: { 101: [{ title: 'News', startTime: START, endTime: END }] },
    },
  });
  const agg = new Aggregator([p]);
  await agg.refreshEpg();
  const xml = agg.getEpgXml();

  // linear guide id is namespaced to match the M3U tvg-id
  assert.match(xml, /<channel id="thetvapp:101"><display-name>CNN<\/display-name>/);
  assert.match(xml, /<title>News<\/title>/);
  // event folded in under its canonical id with "<league>: <matchup>" title.
  // The "@ <time>" suffix is dropped here (Plex renders the slot itself) but
  // stays on the channel name for the recording scheduler.
  assert.match(xml, /<title>MLB: Twins vs Red Sox<\/title>/);
  // events are tagged Sports (+ league) so Plex categorizes them
  assert.match(xml, /<category>Sports<\/category>/);
  assert.match(xml, /<category>MLB<\/category>/);
});

test('linear EPG channel id matches the linear M3U tvg-id (Plex pairing)', async () => {
  const p = new FakeProvider('thetvapp', {
    linear: { CNN: '101' },
    epg: { items: [{ name: 'CNN', chid: '101', logo: null }], programmesByChid: {} },
  });
  const agg = new Aggregator([p]);
  const m3u = await agg.getM3u('https://x');
  await agg.refreshEpg();
  const tvgId = /tvg-id="([^"]+)"/.exec(m3u)[1];
  assert.strictEqual(tvgId, 'thetvapp:101');
  assert.match(agg.getEpgXml(), new RegExp(`<channel id="${tvgId}">`));
});

test('an empty provider set yields a bare playlist and no epg', async () => {
  const agg = new Aggregator([]);
  assert.strictEqual(await agg.getM3u('https://x'), '#EXTM3U');
  await agg.refreshEpg();
  assert.match(agg.getEpgXml(), /<tv generator-info-name="thetvappstream">/);
});

test('getM3u points event logos at the rendered thumb endpoint', async () => {
  const p = new FakeProvider('thetvapp', {
    events: [gameEvent('Minnesota Twins vs Boston Red Sox @ May 22 7:10 PM', 'slot9')],
  });
  const agg = new Aggregator([p]);
  const m3u = await agg.getM3u('https://proxy.example.com');
  assert.match(m3u, /tvg-logo="https:\/\/proxy\.example\.com\/logo\/event\?fmt=thumb&league=MLB&/);
  assert.match(m3u, /name=Minnesota%20Twins%20vs%20Boston%20Red%20Sox/);
});

test('events with no mapped crests still get artwork', async () => {
  const p = new FakeProvider('thetvapp', {
    events: [
      {
        league: 'Ukrainian Premier League',
        name: 'Karpaty vs LNZ Cherkasy @ Aug 10 10:00 AM CDT',
        startSec: START,
        endSec: END,
        streamRef: 'slot9',
      },
    ],
  });
  const agg = new Aggregator([p]);
  const m3u = await agg.getM3u('https://proxy.example.com');
  assert.match(m3u, /tvg-logo="https:\/\/proxy\.example\.com\/logo\/event\?fmt=thumb/);
  assert.doesNotMatch(m3u, /tvg-logo=""/);
});

test('listM3uEntries with no base falls back to a direct crest URL', async () => {
  const p = new FakeProvider('thetvapp', {
    events: [gameEvent('Minnesota Twins vs Boston Red Sox @ May 22 7:10 PM', 'slot9')],
  });
  const agg = new Aggregator([p]);
  const { eventEntries } = await agg.listM3uEntries();
  assert.doesNotMatch(eventEntries[0].logo, /\/logo\//);
  assert.match(eventEntries[0].logo, /^https:\/\/a\.espncdn\.com/);
});

test('emoji-decorated leagues collapse onto one group and one dedup bucket', async () => {
  const p = new FakeProvider('thetvapp', {
    events: [
      {
        league: '⚾ 🇨🇦 MLB',
        name: 'Toronto Blue Jays 🇨🇦 vs Boston Red Sox 🇺🇸 @ May 22 7:10 PM',
        startSec: START,
        endSec: END,
        streamRef: 'a',
      },
      {
        league: '⚾ 🇺🇸 MLB',
        name: 'Atlanta Braves 🇺🇸 vs New York Mets 🇺🇸 @ May 22 7:10 PM',
        startSec: START,
        endSec: END,
        streamRef: 'b',
      },
    ],
  });
  const agg = new Aggregator([p]);
  const { eventEntries } = await agg.listM3uEntries('https://proxy.example.com');

  assert.strictEqual(eventEntries.length, 2);
  assert.deepStrictEqual([...new Set(eventEntries.map(e => e.group))], ['MLB']);
  assert.deepStrictEqual(eventEntries.map(e => e.name).sort(), [
    'Atlanta Braves vs New York Mets @ May 22 7:10 PM',
    'Toronto Blue Jays vs Boston Red Sox @ May 22 7:10 PM',
  ]);
  for (const e of eventEntries) assert.doesNotMatch(e.tvgId, /[^a-z0-9-]/);
});

test('the same game reported with different flags dedupes to one entry', async () => {
  const a = new FakeProvider('thetvapp', {
    events: [
      {
        league: '⚾ 🇨🇦 MLB',
        name: 'Toronto Blue Jays 🇨🇦 vs Boston Red Sox 🇺🇸 @ May 22 7:10 PM',
        startSec: START,
        endSec: END,
        streamRef: 'tva',
      },
    ],
  });
  const b = new FakeProvider('streameast', {
    events: [
      {
        league: '⚾ 🇺🇸 MLB',
        name: 'Boston Red Sox vs Toronto Blue Jays @ May 22 7:10 PM',
        startSec: START,
        endSec: END,
        streamRef: 'sea',
      },
    ],
  });
  const agg = new Aggregator([a, b]);
  const { eventEntries } = await agg.listM3uEntries();
  assert.strictEqual(eventEntries.length, 1);
});

test('a league the source baked into the name is not repeated in the title', () => {
  // Regression: Plex showed "MLB: MLB: Detroit Tigers vs Cleveland Guardians".
  const p = new FakeProvider('daddylive', {
    events: [
      {
        league: '⚾ 🇺🇸 MLB',
        name: '⚾ 🇺🇸 MLB: Detroit Tigers vs Cleveland Guardians @ May 22 7:10 PM',
        startSec: START,
        endSec: END,
        streamRef: 'a',
      },
    ],
  });
  const agg = new Aggregator([p]);
  return agg.refreshEpg().then(() => {
    const xml = agg.getEpgXml();
    assert.match(xml, /<title>MLB: Detroit Tigers vs Cleveland Guardians<\/title>/);
    assert.doesNotMatch(xml, /MLB: MLB:/);
  });
});

test('the M3U channel name also loses the duplicated league', async () => {
  const p = new FakeProvider('daddylive', {
    events: [
      {
        league: 'Europe - UEFA Europa League',
        name: 'Europe - UEFA Europa League: Pafos vs Salzburg @ May 22 7:10 PM',
        startSec: START,
        endSec: END,
        streamRef: 'a',
      },
    ],
  });
  const agg = new Aggregator([p]);
  const { eventEntries } = await agg.listM3uEntries();
  assert.strictEqual(eventEntries[0].name, 'Pafos vs Salzburg @ May 22 7:10 PM');
  assert.strictEqual(eventEntries[0].group, 'Europe - UEFA Europa League');
});

test('the same game spelled differently across providers dedupes to one channel', async () => {
  const a = new FakeProvider('thetvapp', {
    events: [gameEvent('Detroit Tigers vs Cleveland Guardians @ May 22 7:10 PM', 'tva')],
  });
  // Nickname-only spelling, start rounded 5 min and pushed past UTC midnight.
  const b = new FakeProvider('daddylive', {
    events: [
      {
        league: 'MLB',
        name: 'Guardians vs Tigers @ May 22 7:15 PM',
        startSec: Date.parse('2026-05-23T00:15:00Z') / 1000,
        endSec: END,
        streamRef: '742',
      },
    ],
  });
  const agg = new Aggregator([a, b]);
  const { eventEntries } = await agg.listM3uEntries();
  assert.strictEqual(eventEntries.length, 1);
  // The channel keeps the first provider's identity and name.
  assert.strictEqual(
    eventEntries[0].name,
    'Detroit Tigers vs Cleveland Guardians @ May 22 7:10 PM',
  );
  assert.deepStrictEqual(
    agg.streamIndex.get(eventEntries[0].streamId).map(s => `${s.providerName}:${s.ref}`),
    ['thetvapp:tva', 'daddylive:742'],
  );
});

test('a doubleheader nightcap stays its own channel', async () => {
  const p = new FakeProvider('thetvapp', {
    events: [
      gameEvent('Detroit Tigers vs Cleveland Guardians @ May 22 1:10 PM', 'g1'),
      {
        ...gameEvent('Detroit Tigers vs Cleveland Guardians @ May 22 6:40 PM', 'g2'),
        startSec: START + 5.5 * 3600,
      },
    ],
  });
  const agg = new Aggregator([p]);
  const { eventEntries } = await agg.listM3uEntries();
  assert.strictEqual(eventEntries.length, 2);
});

test('alternate feeds queue behind the primary, before the next provider', async () => {
  const a = new FakeProvider('daddylive', {
    events: [
      { ...gameEvent('Twins vs Red Sox @ May 22 7:10 PM', '742'), altStreamRefs: ['999', '742'] },
    ],
    failRefs: ['742'],
  });
  const b = new FakeProvider('thetvapp', {
    events: [gameEvent('Twins vs Red Sox @ May 22 7:10 PM', 'tva')],
  });
  const agg = new Aggregator([a, b]);
  const { eventEntries } = await agg.listM3uEntries();
  const id = eventEntries[0].streamId;
  assert.deepStrictEqual(
    agg.streamIndex.get(id).map(s => `${s.providerName}:${s.ref}`),
    ['daddylive:742', 'daddylive:999', 'thetvapp:tva'], // duplicate 742 dropped
  );
  const { url } = await agg.resolveStream(id);
  assert.strictEqual(url, 'http://stream/daddylive/999');
});

test('resolveStream skips a source whose stream fails validation', async () => {
  const a = new FakeProvider('thetvapp', {
    events: [gameEvent('Twins vs Red Sox @ May 22 7:10 PM', 'tva')],
  });
  const b = new FakeProvider('daddylive', {
    events: [gameEvent('Twins vs Red Sox @ May 22 7:10 PM', '742')],
  });
  const agg = new Aggregator([a, b]);
  const { eventEntries } = await agg.listM3uEntries();
  const out = await agg.resolveStream(eventEntries[0].streamId, {
    validate: s => (s.url.includes('daddylive') ? { text: '#EXTM3U' } : null),
  });
  assert.strictEqual(out.url, 'http://stream/daddylive/742');
  assert.deepStrictEqual(out.check, { text: '#EXTM3U' });
});

test('a validated stream is cached and re-validated instead of re-resolved', async () => {
  const p = new FakeProvider('thetvapp', { linear: { CNN: '101' } });
  const agg = new Aggregator([p]);
  await agg.listM3uEntries();
  let healthy = true;
  const validate = () => (healthy ? { ok: true } : null);

  await agg.resolveStream('thetvapp:101', { validate });
  await agg.resolveStream('thetvapp:101', { validate });
  assert.deepStrictEqual(p.resolved, ['101'], 'second request served from cache');

  // Cached URL goes bad -> one fresh resolve.
  healthy = false;
  await assert.rejects(() => agg.resolveStream('thetvapp:101', { validate }));
  assert.deepStrictEqual(p.resolved, ['101', '101']);
});

test('a stream that keeps validating outlives the cache TTL', async () => {
  const p = new FakeProvider('thetvapp', { linear: { CNN: '101' } });
  const agg = new Aggregator([p]);
  agg.streamCacheMs = 50;
  await agg.listM3uEntries();
  const validate = () => ({ ok: true });

  // Playlist reloads every 20ms for 3x the TTL: each one re-validates and
  // extends the entry, so the provider is never asked again mid-play.
  for (let i = 0; i < 8; i++) {
    await agg.resolveStream('thetvapp:101', { validate });
    await new Promise(r => setTimeout(r, 20));
  }
  assert.deepStrictEqual(p.resolved, ['101']);

  // Left idle past the TTL, the next request resolves fresh.
  await new Promise(r => setTimeout(r, 80));
  await agg.resolveStream('thetvapp:101', { validate });
  assert.deepStrictEqual(p.resolved, ['101', '101']);
});

test('concurrent requests for one channel share a single resolve', async () => {
  const p = new FakeProvider('thetvapp', { linear: { CNN: '101' } });
  const resolve = p.resolveStream.bind(p);
  p.resolveStream = async ref => {
    await new Promise(r => setTimeout(r, 20));
    return resolve(ref);
  };
  const agg = new Aggregator([p]);
  agg.streamCacheMs = 0;
  await agg.listM3uEntries();

  const out = await Promise.all([1, 2, 3].map(() => agg.resolveStream('thetvapp:101')));
  assert.deepStrictEqual(p.resolved, ['101']);
  assert.ok(out.every(o => o.url === 'http://stream/thetvapp/101'));

  // Once it settles, the next request isn't handed the old promise.
  await agg.resolveStream('thetvapp:101');
  assert.deepStrictEqual(p.resolved, ['101', '101']);
});

test('quotes and newlines in source strings cannot break M3U rows', async () => {
  const p = new FakeProvider('thetvapp', {
    events: [
      {
        league: 'Big "Quoted" League',
        name: 'A vs B\n#EXTINF:-1 injected @ May 22 7:10 PM',
        startSec: START,
        endSec: END,
        streamRef: 'x',
      },
    ],
  });
  const agg = new Aggregator([p]);
  const m3u = await agg.getM3u('https://x');
  assert.match(m3u, /group-title="Big 'Quoted' League"/);
  assert.strictEqual(m3u.split('\n').filter(l => l.startsWith('#EXTINF')).length, 1);
});
