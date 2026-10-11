const test = require('node:test');
const assert = require('node:assert');
const TheTvAppProvider = require('../providers/thetvapp');

const A = 'https://a.example';
const B = 'https://b.example';
const C = 'https://c.example';

const LISTING = `<ol class="list-group">
  <a class="list-group-item" href="/tv-live/soccer/x-y/1">Team X vs Team Y: <span class="time-badge">In Progress</span> HD</a>
</ol>`;
const PARKED = '<html><body>This domain is for sale</body></html>';

// Fake HTTP keyed by mirror. `site(base)` returns 'up' | 'down' (connection
// error) | 'blocked' (403 everywhere) | 'parked' (200 with no listings).
function fakeHttp(site) {
  const calls = [];
  return {
    calls,
    get: async url => {
      calls.push(url);
      const base = new URL(url).origin;
      const state = site(base);
      if (state === 'down') throw new Error(`connect ECONNREFUSED ${base}`);
      if (state === 'blocked') return { status: 403, data: 'cf challenge' };
      if (state === 'parked') return { status: 200, data: PARKED };
      const path = new URL(url).pathname;
      if (path.startsWith('/watch/')) return { status: 200, data: LISTING };
      if (path.startsWith('/tv-live/')) return { status: 200, data: '<p>watch</p>' };
      return { status: 404, data: '' };
    },
  };
}

function provider(urls, http, deps = {}) {
  return new TheTvAppProvider({ urls }, { http, ...deps });
}

test('refreshEvents returns to the preferred mirror once it recovers', async () => {
  let aState = 'down';
  const http = fakeHttp(b => (b === A ? aState : 'up'));
  const p = provider([A, B], http);
  await p.ensureReady();
  assert.strictEqual(p.base(), B);

  aState = 'up';
  await p.refreshEvents();
  assert.strictEqual(p.base(), A);
  assert.strictEqual((await p.listEvents()).length, 1);
});

test('a blocked mirror (403) is skipped mid-refresh', async () => {
  const http = fakeHttp(b => (b === A ? 'blocked' : 'up'));
  const p = provider([A, B], http);
  // A passed the refresh's preferFirst probe, then started blocking.
  p.mirrors.preferFirst = async () => A;
  await p.refreshEvents();
  assert.strictEqual(p.base(), B);
  assert.strictEqual((await p.listEvents()).length, 1);
});

test('a parked mirror that lists no games triggers one retry elsewhere', async () => {
  const http = fakeHttp(b => (b === A ? 'parked' : 'up'));
  const p = provider([A, B], http);
  // Force A active even though it would fail the probe (it was live at boot).
  p.mirrors.activeIndex = 0;
  p.mirrors.preferFirst = async () => A;
  await p.refreshEvents();
  assert.strictEqual(p.base(), B);
  assert.strictEqual((await p.listEvents()).length, 1);
});

test('a 404 on one league page does not rotate mirrors', async () => {
  const http = {
    get: async url => {
      const u = new URL(url);
      if (u.pathname === '/watch/wwe-streams') return { status: 404, data: '' };
      if (u.pathname.startsWith('/watch/')) return { status: 200, data: LISTING };
      return { status: 200, data: '<p>watch</p>' };
    },
  };
  const p = provider([A, B], http);
  await p.refreshEvents();
  assert.strictEqual(p.base(), A);
});

test('concurrent failures rotate once, not round the whole list', async () => {
  let aState = 'up';
  const http = fakeHttp(b => (b === A ? aState : 'up'));
  const p = provider([A, B, C], http);
  await p.ensureReady();
  aState = 'blocked';
  // Six event fetches fail on A at once; each asks to rotate off A.
  await Promise.all(Array.from({ length: 6 }, () => p._get('/tv-live/soccer/x-y/1')));
  assert.strictEqual(p.base(), B);
});

test('resolveStream retries on the next mirror when the watch page is unreachable', async () => {
  const tried = [];
  const http = fakeHttp(b => (b === A ? 'down' : 'up'));
  const p = provider([A, B], http, {
    resolveStream: async base => {
      tried.push(base);
      if (base === A) {
        const e = new Error('connect ECONNREFUSED');
        e.mirrorFailure = true;
        throw e;
      }
      return { url: `${base}/playlist.m3u8`, headers: {} };
    },
  });
  const out = await p.resolveStream('/tv-live/soccer/x-y/1');
  assert.deepStrictEqual(tried, [A, B]);
  assert.strictEqual(out.url, `${B}/playlist.m3u8`);
  assert.strictEqual(p.base(), B, 'active mirror moved off the dead domain');
});

test('resolveStream does not try other mirrors for an embed/CDN failure', async () => {
  const tried = [];
  const p = provider(
    [A, B],
    fakeHttp(() => 'up'),
    {
      resolveStream: async base => {
        tried.push(base);
        throw new Error('playlist for stream 111 is not playable');
      },
    },
  );
  await assert.rejects(() => p.resolveStream('/tv-live/soccer/x-y/1'), /not playable/);
  assert.deepStrictEqual(tried, [A]);
});
