const express = require('express');
const { baseUrlFor } = require('./baseUrl');
const { PORT, PUBLIC_BASE_URL, EVENT_REFRESH_MS } = require('./config');
const { createAggregator } = require('./providers');
const { createHlsHandlers, fetchManifest } = require('./hlsProxy');
const { buildSplitLogo, renderEventArt } = require('./logoCompositor');

const app = express();
// Honor X-Forwarded-Proto / X-Forwarded-Host so req.protocol + req.get('host')
// reflect the public-facing URL when behind a reverse proxy (swag/nginx/etc).
app.set('trust proxy', true);

const aggregator = createAggregator();

// Headers captured at resolve time for header-locked streams (DaddyLive et al.),
// keyed by stream id so the segment proxy can replay them.
const streamHeaders = new Map();
const hls = createHlsHandlers({
  lookupHeaders: id => streamHeaders.get(id) || null,
  baseUrlFor: req => baseUrlFor(req, PUBLIC_BASE_URL),
});

app.get('/channels.m3u', async (req, res) => {
  try {
    const base = baseUrlFor(req, PUBLIC_BASE_URL);
    res.type('audio/x-mpegurl').send(await aggregator.getM3u(base));
  } catch (e) {
    console.error(`/channels.m3u: ${e.message}`);
    res.status(500).send(e.message);
  }
});

app.get('/epg.xml', (_req, res) => {
  const xml = aggregator.getEpgXml();
  if (!xml) {
    res.status(503).type('text/plain').send('EPG not yet built; try again shortly.');
    return;
  }
  res.type('application/xml').send(xml);
});

app.get('/channel/:id', async (req, res) => {
  try {
    // Validate each candidate by fetching its manifest with the headers it
    // needs, so a source that resolves to a dead/empty playlist falls through
    // to the next one. The fetched manifest is reused below.
    const { url, headers, check } = await aggregator.resolveStream(req.params.id, {
      validate: s => fetchManifest(s.url, s.headers).catch(() => null),
    });
    if (headers && Object.keys(headers).length > 0) {
      // Header-locked stream: remux through the proxy so segments carry the
      // required Referer/Origin (a redirect can't).
      streamHeaders.set(req.params.id, headers);
      await hls.serveManifest(req, res, {
        streamId: req.params.id,
        url,
        headers,
        base: baseUrlFor(req, PUBLIC_BASE_URL),
        manifest: check,
      });
    } else {
      res.redirect(url);
    }
  } catch (e) {
    console.error(`/channel/${req.params.id}: ${e.message}`);
    res.status(404).send('Channel does not exist, or is blocked.');
  }
});

app.get('/hlsseg/:streamId', (req, res) => {
  hls.segment(req, res).catch(e => {
    console.error(`/hlsseg/${req.params.streamId}: ${e.message}`);
    if (!res.headersSent) res.status(502).end();
  });
});

// Event artwork. fmt=poster feeds the programme <icon> (Plex's 2:3 program
// frame), fmt=thumb the channel <icon>/tvg-logo. Crests are resolved from
// league+name server-side, so unmapped leagues still render legible text art.
app.get('/logo/event', async (req, res) => {
  const league = req.query.league == null ? '' : String(req.query.league);
  const name = req.query.name == null ? '' : String(req.query.name);
  const fmt = req.query.fmt == null ? undefined : String(req.query.fmt);
  if (!league && !name) return res.status(400).type('text/plain').send('Missing league or name');
  try {
    const startSec = req.query.t ? parseInt(String(req.query.t), 10) : null;
    const buf = await renderEventArt({
      league,
      name,
      startSec: Number.isFinite(startSec) ? startSec : null,
      fmt,
    });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (e) {
    console.error(`/logo/event: ${e.message}`);
    res.status(500).type('text/plain').send('Could not render artwork');
  }
});

app.get('/logo/split', async (req, res) => {
  const { a, b, t } = req.query;
  if (!a || !b) return res.status(400).type('text/plain').send('Missing a or b');
  try {
    const startSec = t ? parseInt(t, 10) : null;
    const buf = await buildSplitLogo(a, b, startSec);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (e) {
    console.error(`/logo/split: ${e.message}`);
    res.redirect(a);
  }
});

app.get('/healthz', (_req, res) => {
  res.type('text/plain').send('ok');
});

const EPG_REFRESH_MS = 6 * 60 * 60 * 1000;

// Listen immediately; warm the providers in the background so a slow or dead
// source never blocks the HTTP server from coming up. Until warmup finishes,
// /channels.m3u is empty and /epg.xml returns 503 — both recover on their own.
app.listen(PORT, () => {
  const advertised = PUBLIC_BASE_URL || `http://0.0.0.0:${PORT}`;
  console.log(`Server listening on :${PORT} (public base: ${advertised})`);
});

aggregator
  .ensureReady()
  // Load events, prime the stream index (so /channel resolves before the first
  // M3U fetch), then build the EPG. refreshEvents must run before the first
  // listM3uEntries or the initial M3U/EPG ships with no event channels.
  .then(() => aggregator.refreshEvents())
  .then(() => aggregator.listM3uEntries())
  .then(() => aggregator.refreshEpg())
  .catch(e => console.error(`startup warmup: ${e.message}`));

setInterval(() => {
  aggregator.refreshEpg().catch(e => console.error(`epg refresh: ${e.message}`));
}, EPG_REFRESH_MS);

setInterval(() => {
  aggregator
    .refreshEvents()
    .then(() => aggregator.listM3uEntries())
    .then(() => aggregator.refreshEpg())
    .catch(e => console.error(`event refresh: ${e.message}`));
}, EVENT_REFRESH_MS);
