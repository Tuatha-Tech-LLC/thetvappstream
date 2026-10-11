// Cross-provider event identity. The same game carried by two sources must
// collapse to one M3U channel, so identity is derived from the normalized team
// set + league + date rather than any provider's URL slug or naming.
//
// Display names are NOT touched here: the Dispatcharr scheduler parses the
// "@ <time>" suffix out of the channel name to schedule recordings, so only the
// dedup KEY/id is normalized. Team aliasing (e.g. "Min Twins" -> "Minnesota
// Twins") lives in TEAM_ALIASES and is filled in as real source mismatches show
// up; with one provider it never triggers.
const TEAM_ALIASES = {};

const SPLIT_RE = /\bvs\.?\b|\bv\.?\b|\bat\b|@/i;

function stripTime(name) {
  // "Team A vs Team B @ Apr 25 3:00 PM" -> "Team A vs Team B"
  return String(name || '')
    .split('@')[0]
    .replace(/\s+/g, ' ')
    .trim();
}

function normToken(s) {
  const k = String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return TEAM_ALIASES[k] || k;
}

function teamSet(name) {
  return stripTime(name).split(SPLIT_RE).map(normToken).filter(Boolean).sort();
}

function dateBucket(startSec) {
  const d = new Date(startSec * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

// Stable identity string for dedup comparisons.
function canonicalKey({ league, name, startSec }) {
  return `${String(league || '').toLowerCase()}|${teamSet(name).join('-')}|${dateBucket(startSec)}`;
}

// URL/XMLTV-safe id used as the M3U tvg-id and stream path. Keeps the historical
// `evt-` prefix so Dispatcharr's orphan-stream pruning (which keys on `evt-*`)
// still recognizes these rows.
function canonicalEventId(ev) {
  const slug = canonicalKey(ev)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `evt-${slug}`;
}

// --- Fuzzy same-game matching -------------------------------------------------
//
// canonicalKey only collapses games whose team strings normalize identically
// and whose starts share a UTC date. Two sources rarely agree that well: one
// writes "Detroit Tigers", the other "Tigers" or "DET Tigers"; one says "Inter
// Miami CF", the other "Inter Miami"; a 7:10 PM CDT first pitch is 00:10 UTC
// the next day, so a source that rounds its start by a few minutes lands in a
// different date bucket. Each mismatch ships the same game as two channels.
//
// sameGame() is the looser test the aggregator applies before opening a new
// bucket. It never feeds the channel id (that stays canonicalEventId of the
// first-seen row, so tvg-ids don't churn); it only decides whether a later row
// is a fallback source for an existing channel.

// Club-form suffixes/prefixes that carry no identity ("Arsenal FC" = "Arsenal").
const CLUB_NOISE = new Set(['fc', 'cf', 'sc', 'afc', 'ac', 'cd', 'sk', 'fk', 'bk', 'the']);

// Words shared by many unrelated clubs/schools. A match that rests only on one
// of these ("United", "State", "Madrid") identifies nothing: Ohio State is not
// Michigan State, and AC Milan is not Inter Milan.
const GENERIC_TEAM_WORDS = new Set([
  'united',
  'city',
  'town',
  'county',
  'rovers',
  'athletic',
  'wanderers',
  'albion',
  'real',
  'sporting',
  'club',
  'state',
  'tech',
  'university',
  'college',
  'saint',
  'st',
  'madrid',
  'milan',
  'munich',
  'new',
  'york',
  'los',
  'angeles',
  'la',
]);

// Leagues that are definitely not association football. Used so a source that
// only knows "Soccer" can still pair with one that names the competition.
const NON_SOCCER_LEAGUES = new Set(
  [
    'MLB',
    'NHL',
    'NFL',
    'NBA',
    'WNBA',
    'PWHL',
    'NCAAF',
    'NCAAB',
    'Tennis',
    'Golf',
    'Motorsport',
    'F1',
    'MMA',
    'Boxing',
    'WWE',
    'Wrestling',
    'Rugby',
    'Cricket',
    'AFL',
    'Darts',
    'Snooker',
    'PPV',
    'Fight',
  ].map(s => s.toLowerCase()),
);

// Max start-time gap (minutes) for two rows to be the same game. Wide enough to
// absorb "In Progress" badges and sources that round, narrow enough that a
// day-night doubleheader (typically 4h+ apart) stays two channels.
const SAME_GAME_WINDOW_MIN = 150;

function teamTokens(team) {
  return normToken(team)
    .split(' ')
    .filter(t => t && !CLUB_NOISE.has(t));
}

// Two team strings name the same side when, after dropping club noise, one is
// a contiguous token run of the other ("tigers" in "detroit tigers") or they
// share the final token, which is the nickname for US franchises ("la dodgers"
// vs "los angeles dodgers"). A bare city ("detroit") is NOT matched against a
// nickname-only form ("tigers"); that needs a TEAM_ALIASES entry.
function sameTeam(a, b) {
  const ta = teamTokens(a);
  const tb = teamTokens(b);
  if (!ta.length || !tb.length) return false;
  if (ta.join(' ') === tb.join(' ')) return true;
  const identifying = toks => toks.some(t => !GENERIC_TEAM_WORDS.has(t));
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (identifying(short)) {
    for (let i = 0; i + short.length <= long.length; i++) {
      if (short.every((tok, j) => long[i + j] === tok)) return true;
    }
  }
  const lastA = ta[ta.length - 1];
  const lastB = tb[tb.length - 1];
  // Short / numeric / generic tails ("Miami (OH)" -> "oh", "Team 2", "State")
  // are too common to identify a side on their own.
  return (
    lastA === lastB && lastA.length > 2 && !/^\d+$/.test(lastA) && !GENERIC_TEAM_WORDS.has(lastA)
  );
}

function teamsOf(name) {
  return stripTime(name)
    .split(SPLIT_RE)
    .map(s => s.trim())
    .filter(Boolean);
}

function leaguesCompatible(a, b) {
  const la = String(a || '').toLowerCase();
  const lb = String(b || '').toLowerCase();
  if (la === lb) return true;
  // A generic "Soccer" bucket pairs with any named competition that isn't
  // another sport ("Soccer" vs "English Premier League").
  if (la === 'soccer') return !NON_SOCCER_LEAGUES.has(lb);
  if (lb === 'soccer') return !NON_SOCCER_LEAGUES.has(la);
  return false;
}

function sameGame(a, b, windowMin = SAME_GAME_WINDOW_MIN) {
  if (!a || !b) return false;
  if (!leaguesCompatible(a.league, b.league)) return false;
  if (!Number.isFinite(a.startSec) || !Number.isFinite(b.startSec)) return false;
  if (Math.abs(a.startSec - b.startSec) > windowMin * 60) return false;
  const ta = teamsOf(a.name);
  const tb = teamsOf(b.name);
  // Only head-to-head matchups are fuzzy-matched; single-title events (a UFC
  // card, a Grand Prix) fall back to the exact canonicalKey comparison.
  if (ta.length !== 2 || tb.length !== 2) return false;
  return (
    (sameTeam(ta[0], tb[0]) && sameTeam(ta[1], tb[1])) ||
    (sameTeam(ta[0], tb[1]) && sameTeam(ta[1], tb[0]))
  );
}

module.exports = {
  TEAM_ALIASES,
  sameTeam,
  sameGame,
  leaguesCompatible,
  SAME_GAME_WINDOW_MIN,
  stripTime,
  normToken,
  teamSet,
  dateBucket,
  canonicalKey,
  canonicalEventId,
};
