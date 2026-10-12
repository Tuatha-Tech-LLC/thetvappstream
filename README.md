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
| `thetvapp`  | no       | yes           | Referer-locked HLS via the proxy          |
| `daddylive` | yes      | best-effort\* | headless solver + Referer-injecting remux |
| M3U sources | yes      | no            | as listed; header-locked ones proxied     |

Enable providers (in order — first wins same-game event fallback) via the
`PROVIDERS` env var, e.g. `PROVIDERS=thetvapp,daddylive`. Generic M3U + XMLTV
feeds are added with `M3U_SOURCES` (see below); `PROVIDERS=none` runs only those.

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

## M3U + XMLTV sources

Any feed that publishes a playlist (and optionally an XMLTV guide) can be merged
in: free ad-supported services (Pluto TV, Samsung TV Plus, Plex, Roku, Tubi,
Xumo), public broadcasters, or an IPTV subscription you pay for.

```bash
# compact form: name=<m3u>|<xmltv>, ';' between sources (the guide is optional)
M3U_SOURCES="pluto=https://example.com/pluto/us.m3u8|https://example.com/pluto/us.xml.gz;news=https://example.com/news.m3u"

# JSON form, e.g. to force one group-title for a whole source
M3U_SOURCES='[{"name":"locals","m3u":"https://example.com/locals.m3u","epg":"https://example.com/locals.xml","group":"Locals"}]'
```

- Each source becomes its own provider named after it, so its channels show up
  as `<name>:<tvg-id>` in `tvg-id` and the guide. Names must be letters, digits,
  `-` or `_`, and can't reuse a built-in provider name.
- `tvg-logo` and `group-title` come through from the playlist (`group` in the
  JSON form overrides the group). Rows with no group land in `Live TV`.
- Guide programmes are matched to channels by `tvg-id`, falling back to the
  XMLTV `display-name` for rows with no id. `.gz` guides are fine. The window
  kept is 6 hours back to 3 days ahead.
- Request headers from `#EXTVLCOPT:http-referrer` / `http-user-agent` /
  `http-origin` and Kodi-style `url|Referer=...&User-Agent=...` are honored.
  Those streams go through the proxy; everything else is a plain `302`.
- Both HLS and continuous MPEG-TS streams work. A dead or empty stream returns
  `404` rather than a black channel.
- The playlist is re-read hourly and the guide every 3 hours; if a refresh
  fails, the last good copy keeps being served.

## Mirror failover

`THETVAPP_URLS` and `DLHD_URLS` are ordered lists; the first live entry is
used. A thetvapp mirror counts as live when one of its league pages lists games.

For thetvapp:

- **Each event refresh** re-checks from the top of the list, so the app moves
  back to your preferred domain once it recovers.
- **Mid-refresh**, a connection error or a blocking status (403, 429, 5xx)
  switches to the next live mirror and retries. A 404 on a single page doesn't,
  since one league or game page can legitimately be missing.
- **A mirror that answers but lists no games at all** (a parked domain, or a
  block page served as 200) is skipped, and the refresh is retried once on the
  next mirror.
- **On play**, if the game's page can't be reached on the active mirror, or
  comes back without a player, the other mirrors are tried in order. Failures
  further along (the video host itself) aren't retried on other mirrors,
  because every mirror shares that host.

DaddyLive switches mirrors on connection errors only. If neither its schedule
page nor its schedule JSON returns any games (dlhd refusing the connection, for
example), the last good event list is kept, minus games that have ended, so
in-progress channels stay in the M3U until the next refresh.

## Endpoints

| Path            | What it returns                                                                                                                                                                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/channels.m3u` | Merged M3U across all enabled providers. Linear channels carry `group-title="Live TV"`; events carry the league (e.g. `MLB`, `NBA`). `tvg-id` matches the XMLTV `<channel id>`.                                                                                                         |
| `/epg.xml`      | XMLTV guide: each provider's linear guide plus a synthesized programme per event. `503` until the first build completes.                                                                                                                                                                |
| `/channel/:id`  | Resolves the stream. Simple sources `302` redirect; header-locked sources (DaddyLive) are remuxed through the proxy so segments carry the required headers.                                                                                                                             |
| `/hlsseg/:id`   | Internal segment/variant proxy for header-locked streams — fetches upstream with the captured Referer/Origin and rewrites nested manifests. Segments served as PNG images with the MPEG-TS packed into the pixels (`TIKTIKPX` + length + gzip) are unpacked and served as `video/mp2t`. |
| `/healthz`      | Liveness probe (`200 ok`). The Docker image's HEALTHCHECK uses this.                                                                                                                                                                                                                    |

## Configuration (env vars)

| Var                    | Default                                            | Notes                                                                                                                              |
| ---------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                 | `5000`                                             | HTTP port the server binds to.                                                                                                     |
| `PROVIDERS`            | `thetvapp`                                         | Comma-separated, ordered list of enabled providers (`thetvapp`, `daddylive`). `none` disables them all (M3U sources only).         |
| `PUBLIC_BASE_URL`      | _(unset)_                                          | Base URL emitted in the M3U. When unset, derived from request `Host`/`X-Forwarded-*`. Strongly recommended behind a reverse proxy. |
| `THETVAPP_URLS`        | `https://the-tv.app,https://thetvapp.link`         | Ordered, comma-separated mirror list for thetvapp (first = preferred). See _Mirror failover_. `TV_URL` is not used.                |
| `ENABLE_EVENT_STREAMS` | `true`                                             | thetvapp: scrape per-sport event pages and merge into the M3U + EPG.                                                               |
| `EVENT_REFRESH_MS`     | `1800000` (30 min)                                 | How often to re-scrape event listings.                                                                                             |
| `DLHD_URLS`            | `https://dlive.sx,https://dlhd.st,https://dlhd.pk` | Ordered, comma-separated mirror list for DaddyLive (first = preferred). `dlhd.pk` redirects to `dlhd.st`, then `dlive.sx`.         |
| `DLHD_ENABLE_EVENTS`   | `true`                                             | DaddyLive: surface (best-effort) schedule events. Set `false` for channels only.                                                   |
| `M3U_SOURCES`          | _(unset)_                                          | Generic M3U + XMLTV feeds, one provider each: `name=<m3u url>\|<xmltv url>;name2=...` or a JSON array. See below.                  |
| `STREAM_CACHE_MS`      | `600000` (10 min)                                  | Reuse a validated stream URL per channel for this long (re-checked on every use). `0` disables.                                    |

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
