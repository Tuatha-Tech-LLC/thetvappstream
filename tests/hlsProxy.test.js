const test = require('node:test');
const assert = require('node:assert');
const { rewriteManifest, proxyUri, isManifest } = require('../hlsProxy');

const BASE = 'https://proxy.example.com';
const MANIFEST_URL = 'https://cdn.newkso.ru/key/premium51/mono.m3u8';
const SID = 'daddylive:51';

test('proxyUri resolves relative segment URIs and routes them through /hlsseg', () => {
  const out = proxyUri('seg-1.ts', MANIFEST_URL, BASE, SID);
  assert.match(out, /^https:\/\/proxy\.example\.com\/hlsseg\/daddylive%3A51\?u=/);
  const u = new URL(out);
  assert.strictEqual(
    decodeURIComponent(u.searchParams.get('u')),
    'https://cdn.newkso.ru/key/premium51/seg-1.ts',
  );
});

test('rewriteManifest rewrites segment lines but leaves tags intact', () => {
  const m3u8 = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXTINF:6.0,',
    'seg-1.ts',
    '#EXTINF:6.0,',
    'https://cdn.newkso.ru/key/premium51/seg-2.ts',
  ].join('\n');
  const out = rewriteManifest(m3u8, MANIFEST_URL, BASE, SID);
  assert.match(out, /#EXTM3U/);
  assert.match(out, /#EXTINF:6\.0,/);
  // both segments routed through the proxy
  assert.strictEqual((out.match(/\/hlsseg\//g) || []).length, 2);
  assert.doesNotMatch(out, /^seg-1\.ts$/m);
});

test('rewriteManifest rewrites URI="" attributes (EXT-X-KEY / MEDIA / MAP)', () => {
  const m3u8 = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0',
    '#EXT-X-STREAM-INF:BANDWIDTH=1',
    'variant.m3u8',
  ].join('\n');
  const out = rewriteManifest(m3u8, MANIFEST_URL, BASE, SID);
  assert.match(out, /URI="https:\/\/proxy\.example\.com\/hlsseg\/[^"]*key\.bin[^"]*"/);
  assert.match(out, /\/hlsseg\/[^\n]*variant\.m3u8/);
});

test('isManifest detects m3u8 by extension or content-type', () => {
  assert.ok(isManifest('https://x/y.m3u8'));
  assert.ok(isManifest('https://x/y.m3u8?token=1'));
  assert.ok(isManifest('https://x/y', 'application/vnd.apple.mpegurl'));
  assert.ok(!isManifest('https://x/seg.ts', 'video/mp2t'));
});

test('rewriteManifest preserves EXT-X-ENDLIST tag unchanged', () => {
  const m3u8 = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXTINF:6.0,',
    'seg-last.ts',
    '#EXT-X-ENDLIST',
  ].join('\n');
  const out = rewriteManifest(m3u8, MANIFEST_URL, BASE, SID);
  assert.match(out, /^#EXT-X-ENDLIST\s*$/m);
});

const { Readable, PassThrough } = require('node:stream');
const { looksLikeManifest, fetchManifest, createHlsHandlers } = require('../hlsProxy');

test('looksLikeManifest accepts a BOM/whitespace-prefixed #EXTM3U only', () => {
  assert.ok(looksLikeManifest('#EXTM3U\n#EXTINF:6,\na.ts'));
  assert.ok(looksLikeManifest('﻿  #EXTM3U'));
  assert.ok(!looksLikeManifest('<html>403</html>'));
  assert.ok(!looksLikeManifest(''));
});

test('fetchManifest rejects error pages and empty #EXTM3U shells', async () => {
  const http = body => ({ get: async () => ({ status: 200, data: body, request: {} }) });
  assert.ok(await fetchManifest('u', {}, { http: http('#EXTM3U\n#EXTINF:6,\na.ts') }));
  assert.ok(
    await fetchManifest('u', {}, { http: http('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8') }),
  );
  assert.strictEqual(await fetchManifest('u', {}, { http: http('#EXTM3U\n') }), null);
  assert.strictEqual(await fetchManifest('u', {}, { http: http('<html>blocked</html>') }), null);
  const notFound = { get: async () => ({ status: 404, data: '#EXTM3U\n#EXTINF:6,\na.ts' }) };
  assert.strictEqual(await fetchManifest('u', {}, { http: notFound }), null);
});

// Minimal express-like response backed by a writable so pipe() works.
function fakeRes() {
  const res = new PassThrough();
  const chunks = [];
  res.on('data', c => chunks.push(c));
  res.statusCode = 200;
  res.headers = {};
  res.status = code => ((res.statusCode = code), res);
  res.type = t => ((res.headers['content-type'] = t), res);
  res.set = (k, v) => ((res.headers[k.toLowerCase()] = v), res);
  res.send = body => {
    res.end(body);
    return res;
  };
  res.body = () =>
    new Promise(resolve => res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))));
  return res;
}

function segmentHandler(upstream) {
  return createHlsHandlers({
    lookupHeaders: () => ({ Referer: 'https://embed/' }),
    baseUrlFor: () => BASE,
    http: { get: async () => upstream },
  });
}

test('segment rewrites a nested manifest served from an extensionless octet-stream url', async () => {
  const hls = segmentHandler({
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
    data: Readable.from([Buffer.from('#EXTM3U\n#EXTINF:6,\nseg-1.ts\n')]),
    request: {},
  });
  const res = fakeRes();
  const done = res.body();
  await hls.segment(
    {
      params: { streamId: SID },
      query: { u: 'https://cdn.x/playlist/7/load-playlist' },
      headers: {},
    },
    res,
  );
  const out = await done;
  assert.match(out, /^#EXTM3U/);
  assert.match(out, /\/hlsseg\/daddylive%3A51\?u=https%3A%2F%2Fcdn\.x%2Fplaylist%2F7%2Fseg-1\.ts/);
});

test('segment streams binary payloads through untouched', async () => {
  const payload = Buffer.from([0x47, 0x40, 0x00, 0x10, 0xff]);
  const hls = segmentHandler({
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
    data: Readable.from([payload.subarray(0, 2), payload.subarray(2)]),
    request: {},
  });
  const res = fakeRes();
  const chunks = [];
  res.removeAllListeners('data');
  res.on('data', c => chunks.push(c));
  const ended = new Promise(r => res.on('end', r));
  await hls.segment(
    { params: { streamId: SID }, query: { u: 'https://cdn.x/a.ts' }, headers: {} },
    res,
  );
  await ended;
  assert.deepStrictEqual(Buffer.concat(chunks), payload);
});
