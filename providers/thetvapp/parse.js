const cheerio = require('cheerio');
const { zonedToUtcSec } = require('../daddylive/parse');

// Pure parsing for the-tv.app (the relocated TheTVApp). No network here so it
// stays deterministic and unit-testable; the provider wires these to a fetcher.
//
// the-tv.app is event-only now: per-league listing pages link to per-game watch
// pages, and the watch page embeds a rotating-host JS player. There is no usable
// linear-channel catalog (the legacy /channels/ index still links to the dead
// thetvapp.to origin), so this source contributes events only.

// Nav league tabs -> the league label our M3U group-title uses. cfb = NCAAF.
const LEAGUE_BY_PATH = {
  '/watch/mlb-streams': 'MLB',
  '/watch/nba-streams': 'NBA',
  '/watch/nhl-streams': 'NHL',
  '/watch/nfl-streams': 'NFL',
  '/watch/soccer-streams': 'Soccer',
  '/watch/cfb-streams': 'NCAAF',
  '/watch/ncaab-streams': 'NCAAB',
  '/watch/f1-streams': 'F1',
  '/watch/wwe-streams': 'WWE',
  '/watch/boxing-streams': 'Boxing',
  '/watch/mma-streams': 'MMA',
};

const DEFAULT_DURATION_MIN = 180;
const STALE_AFTER_MIN = 30;

// Event-page Event Information block: "Date: 2026-06-10 13:10ET".
const ABS_TIME_RE = /(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s*ET/;
// "<rotating-host>/new-stream-embed/<streamId>" — the player iframe the watch
// page auto-loads. Host rotates constantly so it's read from the page, never
// hardcoded.
const EMBED_HOST_RE = /([a-z0-9-]+(?:\.[a-z0-9-]+)+)\/new-stream-embed\/(\d+)/i;
const CHANGE_STREAM_RE = /changeStream\((\d+)\)/g;
// Player source inside the embed: ".../playlist/<id>/load-playlist" (an m3u8).
// Host is optional so a root-relative "/playlist/.../load-playlist" also matches.
const PLAYLIST_RE =
  /["']((?:https?:)?(?:\/\/[^"']+?)?\/playlist\/\d+\/load-playlist[^"']*|(?:https?:)?\/\/[^"']+?\.m3u8[^"']*)["']/i;

// "Delayed" is deliberately absent: a rain/weather delay is still a live game
// that resumes, and dropping it lost the channel mid-broadcast.
const ENDED_RE = /\b(final|ended|full[\s-]?time|ft|postponed|cancell?ed|abandoned)\b/i;

// Each league page is an <ol class="list-group"> of
//   <a class="list-group-item" href="/tv-live/<league>/<matchup>/<id>">
//     Away vs Home: <span class="time-badge">In Progress</span> HD
//   </a>
function parseLeagueListing(html, league) {
  const $ = cheerio.load(html || '');
  const out = [];
  $('a.list-group-item[href*="/tv-live/"]').each((_, el) => {
    const a = $(el);
    const href = a.attr('href');
    if (!href) return;
    const path = href.replace(/^https?:\/\/[^/]+/, '');
    const timeText = a.find('.time-badge').text().replace(/\s+/g, ' ').trim();
    // Drop the time badge from the link text, then trim the trailing ": HD".
    let matchup = a.clone().find('span').remove().end().text().replace(/\s+/g, ' ').trim();
    matchup = matchup.replace(/:\s*(hd)?\s*$/i, '').trim();
    if (!matchup) return;
    out.push({ href: path, matchup, timeText, league });
  });
  return out;
}

// The listing carries only a relative badge ("In Progress", "13 minutes from
// now", "2 hours from now"). Returns a coarse start (seconds) for the relevance
// pre-filter, or null when the badge isn't a relative offset (the watch page's
// absolute time is authoritative and supersedes this).
function parseRelativeStartSec(timeText, nowSec) {
  const t = String(timeText || '')
    .toLowerCase()
    .trim();
  if (!t) return null;
  if (/in progress|live now|playing now/.test(t)) return nowSec;
  if (/starting soon|about to start|kicking off/.test(t)) return nowSec + 5 * 60;
  const m = /(\d+)\s*(hour|hr|min)/.exec(t);
  if (m) return nowSec + parseInt(m[1], 10) * (/hour|hr/.test(m[2]) ? 3600 : 60);
  return null;
}

function isEndedBadge(timeText) {
  return ENDED_RE.test(String(timeText || ''));
}

// Pull schedulable + resolvable data off a watch page.
function parseWatchPage(html) {
  const s = String(html || '');
  let startSec = null;
  const tm = ABS_TIME_RE.exec(s);
  if (tm) startSec = zonedToUtcSec(+tm[1], +tm[2], +tm[3], +tm[4], +tm[5], 'America/New_York');
  const streamIds = [...s.matchAll(CHANGE_STREAM_RE)].map(m => m[1]);
  const hm = EMBED_HOST_RE.exec(s);
  const embedHost = hm ? hm[1] : null;
  // Fall back to the id embedded in the iframe host if changeStream() wasn't found.
  if (streamIds.length === 0 && hm) streamIds.push(hm[2]);
  return { startSec, streamIds, embedHost };
}

function parseEmbedPlaylist(html, embedOrigin) {
  const m = PLAYLIST_RE.exec(String(html || ''));
  if (!m) return null;
  let url = m[1];
  if (url.startsWith('//')) url = `https:${url}`;
  else if (url.startsWith('/')) url = `${embedOrigin}${url}`;
  return url;
}

module.exports = {
  LEAGUE_BY_PATH,
  DEFAULT_DURATION_MIN,
  STALE_AFTER_MIN,
  parseLeagueListing,
  parseRelativeStartSec,
  isEndedBadge,
  parseWatchPage,
  parseEmbedPlaylist,
};
