const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const sharp = require('sharp');
const { Readable, PassThrough } = require('node:stream');
const { unwrapPixelSegment, PIXEL_MAGIC } = require('../segmentUnwrap');
const { createHlsHandlers } = require('../hlsProxy');

const TS = Buffer.alloc(188 * 40, 0xab);
for (let i = 0; i < TS.length; i += 188) TS[i] = 0x47;

// Same layout the CDN serves: RGB pixels = magic + uint32 length + gzip(ts), zero-padded.
async function pixelPng(payload, magic = PIXEL_MAGIC) {
  const gz = zlib.gzipSync(payload);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(gz.length);
  const body = Buffer.concat([magic, len, gz]);
  const width = 64;
  const height = Math.ceil(body.length / (width * 3));
  const raw = Buffer.alloc(width * height * 3);
  body.copy(raw);
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

test('unwrapPixelSegment recovers the MPEG-TS packed into PNG pixels', async () => {
  assert.deepStrictEqual(await unwrapPixelSegment(await pixelPng(TS)), TS);
});

test('unwrapPixelSegment returns null for a real image and for non-PNG bytes', async () => {
  assert.strictEqual(await unwrapPixelSegment(await pixelPng(TS, Buffer.from('NOTMAGIC'))), null);
  assert.strictEqual(await unwrapPixelSegment(TS), null);
});

function fakeRes() {
  const res = new PassThrough();
  const chunks = [];
  res.on('data', c => chunks.push(c));
  res.statusCode = 200;
  res.headers = {};
  res.status = code => ((res.statusCode = code), res);
  res.type = t => ((res.headers['content-type'] = t), res);
  res.set = (k, v) => ((res.headers[k.toLowerCase()] = v), res);
  res.send = body => (res.end(body), res);
  res.body = () => new Promise(resolve => res.on('end', () => resolve(Buffer.concat(chunks))));
  return res;
}

test('segment serves an image/png pixel-packed segment as video/mp2t', async () => {
  const png = await pixelPng(TS);
  const hls = createHlsHandlers({
    lookupHeaders: () => ({ Referer: 'https://embed/' }),
    baseUrlFor: () => 'http://proxy',
    http: {
      get: async () => ({
        status: 200,
        headers: { 'content-type': 'image/png' },
        data: Readable.from([png.subarray(0, 100), png.subarray(100)]),
        request: {},
      }),
    },
  });
  const res = fakeRes();
  const done = res.body();
  await hls.segment(
    { params: { streamId: 'evt-x' }, query: { u: 'https://cdn.x/obj~tplv.image' }, headers: {} },
    res,
  );
  assert.deepStrictEqual(await done, TS);
  assert.strictEqual(res.headers['content-type'], 'video/mp2t');
});
