const cheerio = require('cheerio');
const { EVENT_DISPLAY_TZ } = require('../../config');

// Pure parsing for DaddyLive (dlhd) inputs: the 24-7 channel index and the
// schedule JSON. No network or browser here so it stays deterministic and
// unit-testable; the provider wires these to a fetcher.

// DaddyLive schedule categories -> the league label our M3U group-title uses.
// The per-event "LEAGUE : matchup" prefix wins when present (more specific);
// this is the fallback when an event has no prefix.
const CATEGORY_LEAGUE = {
  soccer: 'Soccer',
  football: 'Soccer', // DaddyLive "Football" means association football
  'american football': 'NFL',
  basketball: 'NBA',
  baseball: 'MLB',
  'ice hockey': 'NHL',
  hockey: 'NHL',
  tennis: 'Tennis',
  cricket: 'Cricket',
  golf: 'Golf',
  motorsport: 'Motorsport',
  wrestling: 'Wrestling',
  boxing: 'Boxing',
  mma: 'MMA',
  fight: 'Fight',
  rugby: 'Rugby',
  'rugby league': 'Rugby',
  'rugby union': 'Rugby',
  'aussie rules': 'AFL',
  darts: 'Darts',
  snooker: 'Snooker',
};

// Rough broadcast windows (minutes) for synthesizing event end times.
const LEAGUE_DURATION_MIN = {
  MLB: 210,
  NFL: 210,
  NCAAF: 210,
  NBA: 150,
  NHL: 150,
  NCAAB: 150,
  Soccer: 135,
  Tennis: 180,
  Cricket: 240,
  Golf: 240,
  Motorsport: 180,
  Boxing: 180,
  MMA: 240,
  PPV: 240,
};
const DEFAULT_DURATION_MIN = 180;

function cleanLabel(s) {
  // Schedule keys arrive as "Soccer</span>" with escaped slashes.
  return String(s || '')
    .replace(/<\\?\/?span>/gi, '')
    .replace(/\\\//g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

// "<a href="/watch.php?id=51">CNN USA</a>" -> { "CNN USA": "51" }
function parseChannels(html) {
  const $ = cheerio.load(html || '');
  const out = {};
  $('a[href*="watch.php?id="]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const m = /watch\.php\?id=(\d+)/.exec(href);
    if (!m) return;
    // dlhd renders the id into the link text ("ABC USA ID: 51"); drop it.
    const name = $(el)
      .text()
      .replace(/\s+/g, ' ')
      .replace(/\s*ID:\s*\d+\s*$/i, '')
      .trim();
    if (!name) return;
    // First occurrence wins; dlhd lists the same channel once.
    if (!out[name]) out[name] = m[1];
  });
  return out;
}

// Offset (ms) of `timeZone` from UTC at a given instant.
function tzOffsetMs(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = dtf.formatToParts(new Date(utcMs)).reduce((a, x) => ((a[x.type] = x.value), a), {});
  const hour = p.hour === '24' ? 0 : Number(p.hour);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second);
  return asUtc - utcMs;
}

// The UTC instant (seconds) for a wall-clock Y-M-D HH:MM in `timeZone`.
function zonedToUtcSec(y, m, d, hh, mm, timeZone) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const offset = tzOffsetMs(guess, timeZone);
  return Math.floor((guess - offset) / 1000);
}

function ymdInZone(utcSec, timeZone) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(new Date(utcSec * 1000))
    .reduce((a, x) => ((a[x.type] = x.value), a), {});
  return { y: +p.year, m: +p.month, d: +p.day };
}

// Display time for the "@ <time>" suffix the Dispatcharr scheduler parses, e.g.
// "Jun 8 7:10 PM CDT". The trailing tz abbreviation is DST-accurate (CDT/CST)
// and sits past the AM/PM the scheduler's regex stops at, so it's label-only.
function formatEventSuffix(utcSec, timeZone = EVENT_DISPLAY_TZ) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).formatToParts(new Date(utcSec * 1000));
  const get = t => (parts.find(p => p.type === t) || {}).value || '';
  const tz = get('timeZoneName');
  return `${get('month')} ${get('day')} ${get('hour')}:${get('minute')} ${get('dayPeriod')}${
    tz ? ' ' + tz : ''
  }`;
}

const MONTHS = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

// Pull a calendar date out of a dlhd schedule day key, e.g.
// "Thursday 20th March 2025 - Schedule Time UK GMT" -> { y: 2025, m: 3, d: 20 }.
// Returns null when the key has no parseable date (some mirrors use bare labels
// like "Day" or a localized string we don't recognize).
function parseScheduleHeaderDate(dayKey) {
  const m = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?\s+(\d{4})/.exec(String(dayKey || ''));
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (!month) return null;
  const d = Number(m[1]);
  const y = Number(m[3]);
  if (d < 1 || d > 31) return null;
  return { y, m: month, d };
}

// Whole-day signed drift (b - a) between two {y,m,d} dates, ignoring time.
function dayDrift(a, b) {
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
}

function leagueAndMatchup(eventStr, categoryLabel) {
  const str = String(eventStr || '').trim();
  const idx = str.indexOf(' : ');
  if (idx > 0) {
    return { league: str.slice(0, idx).trim(), matchup: str.slice(idx + 3).trim() };
  }
  const league = CATEGORY_LEAGUE[categoryLabel.toLowerCase()] || categoryLabel;
  return { league, matchup: str };
}

// Parse the schedule JSON into normalized events. Event times carry no date, so
// they're interpreted on their day key's header date (falling back to today only
// when the header is unparseable), and anything outside the relevance window is
// dropped. Stamping on the real header date is what lets a finished game listed
// under yesterday's section drop out instead of being relabeled onto today.
//
// Freshness gate: a frozen mirror (dlhd has served a March-2025 schedule for
// months) would otherwise have its year-old fixtures relabeled as live "today".
// When a day key carries a parseable date that drifts more than `maxStaleDays`
// from today, that whole day is rejected and `onStaleDay` is notified — the
// provider then contributes nothing rather than faking a guide full of phantom
// games. Unparseable headers fall through to the relabel-to-today path, since
// some mirrors genuinely mislabel an otherwise-current schedule.
//
// Times are read as UTC, not Europe/London: dlhd's own header says "Schedule
// Time UK GMT" and it means it literally year-round. Verified against a known
// fixture — Tigers vs Guardians listed 22:40 is a real 5:40 PM CDT first pitch,
// which only holds if 22:40 is UTC (as BST it would land an hour early).
//
// opts: { nowSec, scheduleTz='UTC', graceMin=45, maxAheadHours=36,
//         maxStaleDays=2, skipCategories=[/tv shows/i], onStaleDay=null }
function parseSchedule(scheduleJson, opts = {}) {
  const {
    nowSec = Math.floor(Date.now() / 1000),
    scheduleTz = 'UTC', // dlhd schedule header reads "Schedule Time UK GMT" — not BST
    graceMin = 45,
    maxAheadHours = 36,
    maxStaleDays = 2,
    skipCategories = [/tv shows/i, /tv channels/i],
    onStaleDay = null,
    displayTz = EVENT_DISPLAY_TZ,
  } = opts;

  const today = ymdInZone(nowSec, scheduleTz);
  const events = [];

  for (const dayKey of Object.keys(scheduleJson || {})) {
    const headerDate = parseScheduleHeaderDate(dayKey);
    if (headerDate) {
      const driftDays = dayDrift(today, headerDate);
      if (Math.abs(driftDays) > maxStaleDays) {
        if (onStaleDay) onStaleDay({ dayKey, headerDate, today, driftDays });
        continue;
      }
    }

    const categories = scheduleJson[dayKey] || {};
    for (const catKey of Object.keys(categories)) {
      const category = cleanLabel(catKey);
      if (skipCategories.some(re => re.test(category))) continue;

      const list = Array.isArray(categories[catKey]) ? categories[catKey] : [];
      // dlhd lists a category's events in chronological order and lets them run
      // past midnight without opening a new day section: a Baseball block reads
      // 22:40, 23:05, 23:40, 00:37, 01:35 — the last two being the small hours
      // of the NEXT day. Stamping all of them on the header date threw those
      // events ~24h into the past, where the relevance window below silently
      // dropped them; on 2026-08-13 that hid 5 of dlhd's 9 MLB games.
      //
      // So: when a time goes backwards, everything after it belongs to the next
      // day. Capped at a single roll, because a few categories are not one
      // chronological stream (dlhd's "Tennis" concatenates tournament umbrellas
      // ahead of per-match rows and steps backwards twice); rolling on every
      // decrease would fling those days into the future. One day of skew is
      // recoverable, three is not.
      let prevMinutes = null;
      let dayOffset = 0;
      for (const ev of list) {
        const hhmm = /^(\d{1,2}):(\d{2})$/.exec(String(ev.time || '').trim());
        if (!hhmm) continue;

        const minutes = +hhmm[1] * 60 + +hhmm[2];
        if (prevMinutes !== null && minutes < prevMinutes && dayOffset === 0) dayOffset = 1;
        prevMinutes = minutes;

        // Stamp the event on its own day-header date. Falling back to `today`
        // only when the header is unparseable — otherwise dlhd leading with
        // yesterday's section (its first .schedule__dayTitle) would relabel
        // finished games onto today. With the real date, the relevance window
        // below drops anything already over.
        const day = headerDate || today;
        // Date.UTC normalises a day past month end, so d + 1 rolls correctly.
        const startSec = zonedToUtcSec(
          day.y,
          day.m,
          day.d + dayOffset,
          +hhmm[1],
          +hhmm[2],
          scheduleTz,
        );

        const { league, matchup } = leagueAndMatchup(ev.event, category);
        if (!matchup) continue;

        const durMin = LEAGUE_DURATION_MIN[league] || DEFAULT_DURATION_MIN;
        const endSec = startSec + durMin * 60;

        // Relevance window: not long over, not absurdly far out.
        if (endSec < nowSec - graceMin * 60) continue;
        if (startSec > nowSec + maxAheadHours * 3600) continue;

        const channels = [...(ev.channels || []), ...(ev.channels2 || [])]
          .map(c => c && c.channel_id != null && String(c.channel_id))
          .filter(Boolean);
        if (channels.length === 0) continue;

        events.push({
          league,
          name: `${matchup} @ ${formatEventSuffix(startSec, displayTz)}`,
          startSec,
          endSec,
          streamRef: channels[0], // primary feed
          // Backup feeds, tried in order by the aggregator when the primary is
          // dead (dlhd commonly lists 2-4 channels per game).
          altStreamRefs: channels.slice(1),
          channelIds: channels,
        });
      }
    }
  }

  events.sort((a, b) => a.startSec - b.startSec || a.name.localeCompare(b.name));
  return events;
}

const MONTH_ABBR = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

// Pull a {m, d} out of a label containing a "Mon DD" token, e.g. a dlhd category
// "... Upcoming Matches Jun 13 ...". Year-less, so callers compare against the
// schedule's header date. Returns null when no month/day token is present.
function extractMonthDay(label) {
  const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i.exec(
    String(label || ''),
  );
  if (!m) return null;
  return { m: MONTH_ABBR[m[1].toLowerCase()], d: Number(m[2]) };
}

// Parse the live, server-rendered dlhd homepage into normalized events. dlhd's
// static schedule-generated.json froze in March 2025; the homepage HTML is the
// fresh source. Reshapes the `schedule__*` DOM into the same intermediate map
// parseSchedule consumes, then delegates so the freshness gate, league mapping,
// relevance window, and tz formatting are all reused.
//
// dlhd lists future days ("Upcoming Matches Jun 13/14/15") as extra categories
// under one day header; those dated-to-another-day sections are skipped so their
// times aren't relabeled onto today. opts are forwarded to parseSchedule.
function parseScheduleHtml(html, opts = {}) {
  const $ = cheerio.load(html || '');
  // The homepage lists multiple day sections (e.g. yesterday + today) as flat
  // siblings: a .schedule__dayTitle followed by its .schedule__category blocks.
  // Walk them in document order, attributing each category to the day header
  // that precedes it, so parseSchedule can stamp each event on its true date
  // (and drop the ones already over) instead of relabeling everything to today.
  const schedule = {};
  let currentDay = null;
  let currentHeaderDate = null;

  $('.schedule__dayTitle, .schedule__category').each((_, el) => {
    const $el = $(el);
    if ($el.hasClass('schedule__dayTitle')) {
      currentDay = $el.text().trim();
      currentHeaderDate = parseScheduleHeaderDate(currentDay);
      if (currentDay && !schedule[currentDay]) schedule[currentDay] = {};
      return;
    }

    if (!currentDay) return; // category before any day header — ignore
    const category = $el.find('.card__meta').first().text().trim();
    if (!category) return;
    const md = extractMonthDay(category);
    if (md && currentHeaderDate && (md.m !== currentHeaderDate.m || md.d !== currentHeaderDate.d)) {
      return;
    }

    const byCategory = schedule[currentDay];
    const list = byCategory[category] || (byCategory[category] = []);
    $el.find('.schedule__event').each((__, evEl) => {
      const timeEl = $(evEl).find('.schedule__time').first();
      const time = (timeEl.attr('data-time') || timeEl.text() || '').trim();
      const event = $(evEl).find('.schedule__eventTitle').first().text().trim();
      const channels = [];
      $(evEl)
        .find('.schedule__channels a[href*="watch.php?id="]')
        .each((___, a) => {
          const mm = /watch\.php\?id=(\d+)/.exec($(a).attr('href') || '');
          if (mm) channels.push({ channel_id: mm[1] });
        });
      if (time && event && channels.length) list.push({ time, event, channels });
    });
  });

  return parseSchedule(schedule, opts);
}

module.exports = {
  parseChannels,
  parseSchedule,
  parseScheduleHtml,
  parseScheduleHeaderDate,
  leagueAndMatchup,
  cleanLabel,
  zonedToUtcSec,
  formatEventSuffix,
  CATEGORY_LEAGUE,
  LEAGUE_DURATION_MIN,
};
