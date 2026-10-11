const axios = require('axios');

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

function bodyText(data) {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return String(data ?? '');
}

// Fetch a manifest and decide whether it is playable: 200, starts with
// #EXTM3U, and carries at least one segment or variant. Dead pirate feeds
// often answer 200 with an empty "#EXTM3U" shell or an HTML error page, and
// handing those to the player just produces a silent black channel instead of
// letting the aggregator fall through to the next source.
//
// Returns { text, finalUrl } when playable, otherwise null.
async function fetchManifest(url, headers, { http = axios, timeout = 15000 } = {}) {
  const r = await http.get(url, {
    headers: headers || {},
    responseType: 'text',
    timeout,
    maxRedirects: 5,
    validateStatus: () => true,
    transformResponse: x => x,
  });
  const text = bodyText(r.data);
  if (r.status !== 200 || !looksLikeManifest(text)) return null;
  if (!/#EXTINF|#EXT-X-STREAM-INF/.test(text)) return null;
  return { text, finalUrl: r.request?.res?.responseUrl || url };
}

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
async function collect(stream, first) {
  const chunks = first ? [first] : [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
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
    if (req.headers && req.headers.range) {
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
    relayHeaders(res, upstream, ctype);
    body.pipe(res);
  }

  return { serveManifest, segment };
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
  fetchManifest,
  createHlsHandlers,
};
