const test = require('node:test');
const assert = require('node:assert');
const {
  extractEmbedUrl,
  streamHeaders,
  resolveDaddyStream,
} = require('../providers/daddylive/resolve');

const STREAM_HTML = `
<html><body>
  <div id="player">
    <iframe src="https://donis.jimpenopisonline.online/premiumtv/daddy3.php?id=51"
            allowfullscreen></iframe>
  </div>
</body></html>`;

test('extractEmbedUrl finds the daddy3 player iframe', () => {
  assert.strictEqual(
    extractEmbedUrl(STREAM_HTML),
    'https://donis.jimpenopisonline.online/premiumtv/daddy3.php?id=51',
  );
});

test('extractEmbedUrl upgrades a protocol-relative src to https', () => {
  const html = '<iframe src="//host.example/premiumtv/daddy3.php?id=7"></iframe>';
  assert.strictEqual(extractEmbedUrl(html), 'https://host.example/premiumtv/daddy3.php?id=7');
});

test('extractEmbedUrl falls back to a regex match outside an iframe tag', () => {
  const html = `<script>var u = "https://h.tld/premiumtv/daddy3.php?id=9";</script>`;
  assert.strictEqual(extractEmbedUrl(html), 'https://h.tld/premiumtv/daddy3.php?id=9');
});

test('extractEmbedUrl matches all daddy<N>.php variants (daddy, daddy2, daddy4)', () => {
  for (const v of ['daddy', 'daddy2', 'daddy4']) {
    const html = `<iframe src="https://donis.jimpenopisonline.online/premiumtv/${v}.php?id=399"></iframe>`;
    assert.strictEqual(
      extractEmbedUrl(html),
      `https://donis.jimpenopisonline.online/premiumtv/${v}.php?id=399`,
    );
  }
});

test('extractEmbedUrl returns null when no embed present', () => {
  assert.strictEqual(extractEmbedUrl('<html>nope</html>'), null);
});

test('streamHeaders prefers browser-observed values, defaults to embed origin', () => {
  assert.deepStrictEqual(streamHeaders({}, 'https://embed.tld'), {
    Referer: 'https://embed.tld/',
    Origin: 'https://embed.tld',
  });
  assert.deepStrictEqual(
    streamHeaders(
      { referer: 'https://embed.tld/player', origin: 'https://embed.tld', 'user-agent': 'UA/1' },
      'https://embed.tld',
    ),
    { Referer: 'https://embed.tld/player', Origin: 'https://embed.tld', 'User-Agent': 'UA/1' },
  );
});

test('resolveDaddyStream walks stream page -> embed -> sniffed manifest with headers', async () => {
  const calls = {};
  const out = await resolveDaddyStream('https://dlhd.pk', '51', {
    fetchPage: async url => {
      calls.page = url;
      return STREAM_HTML;
    },
    sniff: async (url, opts) => {
      calls.sniff = { url, opts };
      return {
        url: 'https://cdn.newkso.ru/key/premium51/mono.m3u8',
        headers: { referer: 'https://donis.jimpenopisonline.online/' },
      };
    },
  });
  assert.strictEqual(calls.page, 'https://dlhd.pk/stream/stream-51.php');
  assert.strictEqual(
    calls.sniff.url,
    'https://donis.jimpenopisonline.online/premiumtv/daddy3.php?id=51',
  );
  assert.strictEqual(out.url, 'https://cdn.newkso.ru/key/premium51/mono.m3u8');
  assert.strictEqual(out.headers.Referer, 'https://donis.jimpenopisonline.online/');
  assert.strictEqual(out.headers.Origin, 'https://donis.jimpenopisonline.online');
});

test('resolveDaddyStream throws when the embed is missing', async () => {
  await assert.rejects(
    () =>
      resolveDaddyStream('https://dlhd.pk', '51', {
        fetchPage: async () => '<html>blocked</html>',
      }),
    /no daddy embed/,
  );
});

test('resolveDaddyStream uses the plain-GET stream page and skips the headless render', async () => {
  let rendered = false;
  const out = await resolveDaddyStream('https://dlhd.pk', '51', {
    fetchPlain: async () => STREAM_HTML,
    fetchPage: async () => {
      rendered = true;
      return STREAM_HTML;
    },
    sniff: async () => ({ url: 'https://cdn.example/mono.m3u8', headers: {} }),
  });
  assert.strictEqual(rendered, false);
  assert.strictEqual(out.url, 'https://cdn.example/mono.m3u8');
});

test('resolveDaddyStream falls back to the rendered page when the plain GET has no embed', async () => {
  let rendered = false;
  const out = await resolveDaddyStream('https://dlhd.pk', '51', {
    fetchPlain: async () => '<html>js shell</html>',
    fetchPage: async () => {
      rendered = true;
      return STREAM_HTML;
    },
    sniff: async () => ({ url: 'https://cdn.example/mono.m3u8', headers: {} }),
  });
  assert.strictEqual(rendered, true);
  assert.strictEqual(out.url, 'https://cdn.example/mono.m3u8');
});
