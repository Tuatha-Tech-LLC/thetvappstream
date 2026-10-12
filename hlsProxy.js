const axios = require('axios');
const { unwrapPixelSegment } = require('./segmentUnwrap');

// Header-locked HLS (DaddyLive et al.) can't be recorded via a plain redirect:
// the CDN requires a Referer/Origin the player can't be told to send. So we
// proxy the manifest, rewriting every segment/variant/key URI to come back
// through /hlsseg, and fetch those with the required headers on the server side.

// Resolve a possibly-relative URI against the manifest URL and route it through
// the segment proxy, carrying the stream id so /hlsseg can look up headers.
function proxyUri(uri, manifestUrl, base, streamId) {
  const abs = new URL(uri, manifestUrl).href;
  return `${base}/hlsseg/${encodeURIComponent(streamId)}?u=${encodeURIComponent(abs)}`;
}

// Rewrite an m3u8 body. Variant playlists (#EXT-X-STREAM-INF) and segment lines
// are bare URIs; EXT-X-KEY / EXT-X-MEDIA / EXT-X-MAP carry URI="..." attributes.
function rewriteManifest(manifestText, manifestUrl, base, streamId) {
  return String(manifestText)
    .split(/\r?\n/)
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(
          /URI="([^"]+)"/g,
          (_m, uri) => `URI="${proxyUri(uri, manifestUrl, base, streamId)}"`,
        );
      }
      return proxyUri(trimmed, manifestUrl, base, streamId);
    })
    .join('\n');
}

function isManifest(url, contentType) {
  return /\.m3u8(\?|$)/i.test(url) || /mpegurl/i.test(contentType || '');
}

// Body-level check. Several of these CDNs serve playlists from extensionless
// paths ("/playlist/123/load-playlist") as text/plain or octet-stream, so the
// URL/content-type test alone misses them.
function looksLikeManifest(text) {
  return /^\uFEFF?\s*#EXTM3U/.test(String(text ?? ''));
}

// Media types that are never a playlist; everything else gets its first bytes
// sniffed so a disguised manifest is still rewritten.
const NEVER_MANIFEST_RE = /^(video|audio|image)\//i;

// Resolve with the first chunk of a readable (or null at EOF) and leave the
// stream paused so the caller can decide between buffering and piping.
function peekFirstChunk(stream) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onErr);
    };
    const onData = chunk => {
      cleanup();
      stream.pause();
      resolve(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    const onErr = e => {
      cleanup();
      reject(e);
    };
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onErr);
  });
}

// Read the rest of a stream into one buffer. Async iteration (rather than an
// 'end' listener) also terminates cleanly when a short body already emitted
// 'end' while it sat paused after peekFirstChunk.
async function collect(stream, first, maxBytes = Infinity) {
  const chunks = first ? [first] : [];
  let size = first ? first.length : 0;
  for await (const c of stream) {
    chunks.push(c);
    size += c.length;
    if (size > maxBytes) {
      stream.destroy();
      throw new Error(`body exceeds ${maxBytes} bytes`);
    }
  }
  return Buffer.concat(chunks);
}

const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;
const WHOLE_BODY_RANGE_RE = /^\s*bytes\s*=\s*0\s*-\s*$/i;
const PEEK_TIMEOUT_MS = 15000;

// Probe a stream URL with the headers it needs and classify it:
//   { kind: 'hls', text, finalUrl }    a playlist with segments/variants
//   { kind: 'direct', contentType, finalUrl }   a non-HLS media body (an
//                                       endless MPEG-TS feed, a progressive file)
//   null                                not playable
// Only the first chunk of a non-HLS body is read, so probing a continuous TS
// stream doesn't download it. Dead feeds often answer 200 with an empty
// "#EXTM3U" shell or an HTML error page; both come back null so the aggregator
// can fall through to the next source instead of serving a black channel.
async function probeStream(url, headers, { http = axios, timeout = 15000 } = {}) {
  const r = await http.get(url, {
    headers: headers || {},
    responseType: 'stream',
    timeout,
    maxRedirects: 5,
    validateStatus: () => true,
  });
  const body = r.data;
  const destroy = () => {
    if (body && typeof body.destroy === 'function') body.destroy();
  };
  const finalUrl = r.request?.res?.responseUrl || url;
  if (r.status !== 200 || !body || typeof body.on !== 'function') {
    destroy();
    return null;
  }
  const ctype = (r.headers && r.headers['content-type']) || '';
  let timer;
  const first = await Promise.race([
    peekFirstChunk(body),
    new Promise(resolve => (timer = setTimeout(() => resolve(null), PEEK_TIMEOUT_MS))),
  ]).finally(() => clearTimeout(timer));
  if (!first) {
    destroy();
    return null;
  }
  const head = first.subarray(0, 512).toString('utf8');
  if (!looksLikeManifest(head)) {
    destroy();
    // An error page isn't media, whatever the status code says.
    if (/text\/html/i.test(ctype) || /^\s*</.test(head)) return null;
    return { kind: 'direct', contentType: ctype, finalUrl };
  }
  const buf = await collect(body, first, MAX_MANIFEST_BYTES);
  const text = buf.toString('utf8');
  if (!/#EXTINF|#EXT-X-STREAM-INF/.test(text)) return null;
  return { kind: 'hls', text, finalUrl };
}

// HLS-only variant of probeStream for sources that are always HLS: returns
// { text, finalUrl } for a playable playlist, otherwise null.
async function fetchManifest(url, headers, opts = {}) {
  const p = await probeStream(url, headers, opts);
  return p && p.kind === 'hls' ? { text: p.text, finalUrl: p.finalUrl } : null;
}

// Headers worth relaying on a passthrough segment so players can seek/resume.
// content-length is deliberately absent: axios transparently decompresses but
// keeps the upstream (compressed) length, which would truncate the response.
const PASSTHROUGH_HEADERS = ['content-range', 'accept-ranges'];

// Express handler factory. `lookupHeaders(streamId)` returns the headers stored
// for that stream at resolve time (or null).
function createHlsHandlers({ lookupHeaders, baseUrlFor, http = axios }) {
  // GET /channel manifest entrypoint is handled by app.js; this serves the
  // nested manifest + segments once the entry URL is known. Pass `manifest`
  // (from fetchManifest) when the caller already downloaded it while
  // validating, to skip a second upstream round trip.
  async function serveManifest(req, res, { streamId, url, headers, base, manifest }) {
    const m = manifest || (await fetchManifest(url, headers, { http }));
    if (!m) {
      res.status(502).send('upstream manifest unavailable');
      return;
    }
    res
      .type('application/vnd.apple.mpegurl')
      .send(rewriteManifest(m.text, m.finalUrl || url, base, streamId));
  }

  async function segment(req, res) {
    const streamId = req.params.streamId;
    const target = req.query.u;
    const headers = lookupHeaders(streamId);
    if (!target || !headers) {
      res.status(404).send('unknown segment');
      return;
    }
    const reqHeaders = { ...headers };
    // ffmpeg sends "Range: bytes=0-" on every segment. That is the whole body,
    // and forwarding it turns the upstream 200 into a 206, which would skip the
    // pixel-segment unwrap below.
    if (req.headers && req.headers.range && !WHOLE_BODY_RANGE_RE.test(req.headers.range)) {
      reqHeaders.Range = req.headers.range;
      // Byte ranges only line up with what we relay if the body isn't re-encoded.
      reqHeaders['Accept-Encoding'] = 'identity';
    }
    const upstream = await http.get(target, {
      headers: reqHeaders,
      responseType: 'stream',
      timeout: 20000,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    const body = upstream.data;
    if (upstream.status !== 200 && upstream.status !== 206) {
      if (body && typeof body.destroy === 'function') body.destroy();
      res.status(502).send(`upstream segment ${upstream.status}`);
      return;
    }
    // Stop pulling from the CDN as soon as the player hangs up; otherwise every
    // channel change leaves a segment download running to completion.
    res.on('close', () => {
      if (body && typeof body.destroy === 'function' && !body.destroyed) body.destroy();
    });

    const ctype = upstream.headers['content-type'] || '';
    const sendManifest = buf => {
      const base = baseUrlFor(req);
      const finalUrl = upstream.request?.res?.responseUrl || target;
      res
        .type('application/vnd.apple.mpegurl')
        .send(rewriteManifest(buf.toString('utf8'), finalUrl, base, streamId));
    };

    // Nested manifests (variant -> media playlist) must be rewritten too;
    // everything else streams straight through.
    if (isManifest(target, ctype)) {
      sendManifest(await collect(body));
      return;
    }
    if (!NEVER_MANIFEST_RE.test(ctype)) {
      const first = await peekFirstChunk(body);
      if (first && looksLikeManifest(first.subarray(0, 64).toString('utf8'))) {
        sendManifest(await collect(body, first));
        return;
      }
      relayHeaders(res, upstream, ctype);
      if (first) res.write(first);
      // A one-chunk body may have finished while paused; pipe() would then
      // never see 'end' and leave the response hanging.
      if (body.readableEnded) res.end();
      else body.pipe(res);
      return;
    }
    // A byte range of a pixel-packed segment can't be decoded, so only whole
    // image bodies are unwrapped.
    if (/^image\/png/i.test(ctype) && upstream.status === 200) {
      const buf = await collect(body, null, MAX_SEGMENT_BYTES);
      const ts = await unwrapPixelSegment(buf);
      if (ts) {
        res.status(200).type('video/mp2t').send(ts);
      } else {
        relayHeaders(res, upstream, ctype);
        res.send(buf);
      }
      return;
    }
    relayHeaders(res, upstream, ctype);
    body.pipe(res);
  }

  // Non-HLS stream (continuous MPEG-TS, progressive file) that needs request
  // headers: relay the body as-is, since there are no segment URIs to rewrite.
  async function passthrough(req, res, { url, headers }) {
    const reqHeaders = { ...headers };
    if (req.headers && req.headers.range) {
      reqHeaders.Range = req.headers.range;
      reqHeaders['Accept-Encoding'] = 'identity';
    }
    const upstream = await http.get(url, {
      headers: reqHeaders,
      responseType: 'stream',
      timeout: 20000,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    const body = upstream.data;
    if (upstream.status !== 200 && upstream.status !== 206) {
      if (body && typeof body.destroy === 'function') body.destroy();
      res.status(502).send(`upstream stream ${upstream.status}`);
      return;
    }
    res.on('close', () => {
      if (body && typeof body.destroy === 'function' && !body.destroyed) body.destroy();
    });
    relayHeaders(res, upstream, upstream.headers['content-type'] || '');
    body.pipe(res);
  }

  return { serveManifest, segment, passthrough };
}

function relayHeaders(res, upstream, ctype) {
  res.status(upstream.status);
  if (ctype) res.type(ctype);
  for (const h of PASSTHROUGH_HEADERS) {
    if (upstream.headers[h] != null) res.set(h, upstream.headers[h]);
  }
}

module.exports = {
  rewriteManifest,
  proxyUri,
  isManifest,
  looksLikeManifest,
  probeStream,
  fetchManifest,
  createHlsHandlers,
};
