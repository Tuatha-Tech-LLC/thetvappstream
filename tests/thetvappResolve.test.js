const test = require('node:test');
const assert = require('node:assert');
const { resolveTheTvAppStream } = require('../providers/thetvapp/resolve');

const WATCH_HTML = `
<button onclick="changeStream(111)">Server1</button>
<button onclick="changeStream(222)">Backup</button>
<iframe src="https://embed.example/new-stream-embed/111"></iframe>
Date: 2026-06-10 13:10ET`;

const embedFor = id =>
  `<script>var src = "https://cdn.example/playlist/${id}/load-playlist";</script>`;

function fakeHttp() {
  const calls = [];
  return {
    calls,
    get: async url => {
      calls.push(url);
      if (url.includes('/tv-live/')) return { status: 200, data: WATCH_HTML };
      const m = /new-stream-embed\/(\d+)/.exec(url);
      if (m) return { status: 200, data: embedFor(m[1]) };
      return { status: 404, data: '' };
    },
  };
}

test('resolveTheTvAppStream returns Server1 when its playlist is playable', async () => {
  const http = fakeHttp();
  const out = await resolveTheTvAppStream('https://the-tv.app', '/tv-live/mlb/a-b/1', {
    http,
    validate: async () => true,
  });
  assert.strictEqual(out.url, 'https://cdn.example/playlist/111/load-playlist');
  assert.strictEqual(out.headers.Referer, 'https://embed.example/');
});

test('resolveTheTvAppStream falls through to Backup when Server1 is not playable', async () => {
  const http = fakeHttp();
  const probed = [];
  const out = await resolveTheTvAppStream('https://the-tv.app', '/tv-live/mlb/a-b/1', {
    http,
    validate: async url => {
      probed.push(url);
      return url.includes('/222/');
    },
  });
  assert.strictEqual(out.url, 'https://cdn.example/playlist/222/load-playlist');
  assert.deepStrictEqual(probed, [
    'https://cdn.example/playlist/111/load-playlist',
    'https://cdn.example/playlist/222/load-playlist',
  ]);
});

test('resolveTheTvAppStream throws when no server is playable', async () => {
  await assert.rejects(
    () =>
      resolveTheTvAppStream('https://the-tv.app', '/tv-live/mlb/a-b/1', {
        http: fakeHttp(),
        validate: async () => null,
      }),
    /not playable/,
  );
});
