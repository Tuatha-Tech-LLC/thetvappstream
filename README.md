# StreamScraper

An Express server that aggregates one or more live-TV/sports sources into a
single M3U playlist plus an XMLTV guide. Designed to plug straight into IPTV
middleware (Dispatcharr, Threadfin, xTeVe, etc.) and from there into Plex Live
TV / Jellyfin / VLC.

Sources sit behind a small provider interface, so adding one is a single
adapter — the M3U/EPG assembly, mirror failover, and stream proxy are shared.

## Providers

| Provider    | Channels | Events        | Stream resolution                         |
| ----------- | -------- | ------------- | ----------------------------------------- |
| `thetvapp`  | yes      | yes           | signed HLS, `302` redirect                |
| `daddylive` | yes      | best-effort\* | headless solver + Referer-injecting remux |

Enable providers (in order — first wins same-game event fallback) via the
`PROVIDERS` env var, e.g. `PROVIDERS=thetvapp,daddylive`.

Events from the same game across providers are deduped to one channel by a
canonical identity (normalized team set + league + date), falling back to a
looser same-game match (team nickname/suffix variants, starts within 2.5h) so
"Detroit Tigers" and "Tigers" land on one channel. The other provider — and any
backup feeds a source lists for the game — is kept as an ordered fallback.

On play, each candidate stream's manifest is fetched and checked (200,
`#EXTM3U`, has segments/variants) before it's served; a dead or empty feed
falls through to the next source instead of producing a black channel.

\* DaddyLive's schedule JSON carries an unreliable date header; its events are
interpreted as "today" and stale ones dropped. If they prove noisy, set
`DLHD_ENABLE_EVENTS=false` and use it as a 24/7-channel source only.

## Endpoints

| Path            | What it returns                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/channels.m3u` | Merged M3U across all enabled providers. Linear channels carry `group-title="Live TV"`; events carry the league (e.g. `MLB`, `NBA`). `tvg-id` matches the XMLTV `<channel id>`. |
| `/epg.xml`      | XMLTV guide: each provider's linear guide plus a synthesized programme per event. `503` until the first build completes.                                                        |
| `/channel/:id`  | Resolves the stream. Simple sources `302` redirect; header-locked sources (DaddyLive) are remuxed through the proxy so segments carry the required headers.                     |
| `/hlsseg/:id`   | Internal segment/variant proxy for header-locked streams — fetches upstream with the captured Referer/Origin and rewrites nested manifests.                                     |
| `/healthz`      | Liveness probe (`200 ok`). The Docker image's HEALTHCHECK uses this.                                                                                                            |

## Configuration (env vars)

| Var                    | Default               | Notes                                                                                                                                         |
| ---------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                 | `5000`                | HTTP port the server binds to.                                                                                                                |
| `PROVIDERS`            | `thetvapp`            | Comma-separated, ordered list of enabled providers (`thetvapp`, `daddylive`).                                                                 |
| `PUBLIC_BASE_URL`      | _(unset)_             | Base URL emitted in the M3U. When unset, derived from request `Host`/`X-Forwarded-*`. Strongly recommended behind a reverse proxy.            |
| `THETVAPP_URLS`        | `https://thetvapp.to` | Comma-separated mirror list for thetvapp. Domains rotate; the resolver fails over to the first live one. (`TV_URL` is honored as a fallback.) |
| `ENABLE_EVENT_STREAMS` | `true`                | thetvapp: scrape per-sport event pages and merge into the M3U + EPG.                                                                          |
| `EVENT_REFRESH_MS`     | `1800000` (30 min)    | How often to re-scrape event listings.                                                                                                        |
| `DLHD_URLS`            | `https://dlhd.pk`     | Comma-separated mirror list for DaddyLive.                                                                                                    |
| `DLHD_ENABLE_EVENTS`   | `true`                | DaddyLive: surface (best-effort) schedule events. Set `false` for channels only.                                                              |
| `STREAM_CACHE_MS`      | `600000` (10 min)     | Reuse a validated stream URL per channel for this long (re-checked on every use). `0` disables.                                               |

## Running with Docker

```bash
docker run -d \
  --name streamscraper \
  --restart unless-stopped \
  -p 5000:5000 \
  -e PROVIDERS=thetvapp,daddylive \
  -e PUBLIC_BASE_URL=https://stream-proxy.example.com \
  ghcr.io/o-mutt/thetvappstream:latest
```

The image bundles Chromium (for DaddyLive's headless stream resolution). It is
launched lazily and only when a DaddyLive stream is actually resolved — running
`thetvapp` only never starts it.

`--network host` also works and avoids the need for `PUBLIC_BASE_URL` if the
host's IP is what you want in the playlist URLs.

## Wiring into Plex Live TV

- M3U source: `https://your-host/channels.m3u`
- XMLTV source: `https://your-host/epg.xml`

`tvg-id` in the M3U matches `<channel id>` in the XMLTV by construction, so
middleware auto-pairs channels to programmes with no manual mapping.

## Development

```bash
npm install
npm test           # unit tests (node:test)
npm run lint       # ESLint
npm run format     # Prettier
node app.js
```

CI runs lint + format + tests on every PR (`.github/workflows/lint.yml`); the
Docker image is built and pushed to GHCR on merges to `main`
(`.github/workflows/docker.yml`).

## Caveat: per-game event streams

Event streams are backed by upstream "slot" IDs reused as one game ends and the
next begins, so every event row gets its own canonical id (`evt-<...>`) used in
`tvg-id` and `<channel id>` while the stream URL resolves the current slot. The
event list refreshes every `EVENT_REFRESH_MS` to keep drift small.

## Disclaimer

> Not affiliated with any upstream site. Intended for personal use only —
> respect each upstream site's terms of service.
