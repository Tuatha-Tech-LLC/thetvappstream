const test = require('node:test');
const assert = require('node:assert');
const {
  parseChannels,
  parseSchedule,
  parseScheduleHeaderDate,
  parseScheduleHtml,
  formatEventSuffix,
  leagueAndMatchup,
  zonedToUtcSec,
} = require('../providers/daddylive/parse');

const CHANNELS_HTML = `
<div class="grid">
  <a href="/watch.php?id=51" class="card">CNN USA ID: 51</a>
  <a href="/watch.php?id=206">ESPN USA ID: 206</a>
  <a href="https://dlhd.pk/watch.php?id=302">TNT Sports 1 UK</a>
  <a href="/24-7-channels.php">Back</a>
  <a href="/watch.php?id=51">CNN USA ID: 51</a>
</div>`;

test('parseChannels maps display name -> id, strips "ID: N", ignores non-channel links', () => {
  const ch = parseChannels(CHANNELS_HTML);
  assert.deepStrictEqual(ch, { 'CNN USA': '51', 'ESPN USA': '206', 'TNT Sports 1 UK': '302' });
});

test('parseChannels returns empty for junk input', () => {
  assert.deepStrictEqual(parseChannels(''), {});
  assert.deepStrictEqual(parseChannels('<html>no channels</html>'), {});
});

test('leagueAndMatchup prefers the "LEAGUE : matchup" prefix', () => {
  assert.deepStrictEqual(leagueAndMatchup('MLB : Boston Red Sox vs Minnesota Twins', 'Baseball'), {
    league: 'MLB',
    matchup: 'Boston Red Sox vs Minnesota Twins',
  });
});

test('leagueAndMatchup falls back to a mapped category label', () => {
  assert.deepStrictEqual(leagueAndMatchup('Some Friendly Match', 'Soccer'), {
    league: 'Soccer',
    matchup: 'Some Friendly Match',
  });
});

test('zonedToUtcSec handles British Summer Time (GMT+1 in June)', () => {
  // 19:00 London on 2026-06-08 (BST) == 18:00 UTC
  const sec = zonedToUtcSec(2026, 6, 8, 19, 0, 'Europe/London');
  assert.strictEqual(new Date(sec * 1000).toISOString(), '2026-06-08T18:00:00.000Z');
});

test('zonedToUtcSec handles GMT in winter', () => {
  // 19:00 London on 2026-01-08 (GMT) == 19:00 UTC
  const sec = zonedToUtcSec(2026, 1, 8, 19, 0, 'Europe/London');
  assert.strictEqual(new Date(sec * 1000).toISOString(), '2026-01-08T19:00:00.000Z');
});

// nowSec anchored to 2026-06-08 ~14:00 ET (18:00 UTC)
const NOW = Date.parse('2026-06-08T18:00:00Z') / 1000;

const SCHEDULE = {
  // header date matches NOW (2026-06-08) so the freshness gate passes
  'Monday 8th June 2026 - Schedule Time UK GMT': {
    'TV Shows</span>': [
      { time: '12:00', event: "Hell's Kitchen", channels: [{ channel_id: '742' }] },
    ],
    'Baseball</span>': [
      {
        // 20:00 GMT (UTC+0) == 20:00 UTC == 3:00 PM CDT, ~2h ahead of NOW -> keep
        time: '20:00',
        event: 'MLB : Boston Red Sox vs Minnesota Twins',
        channels: [{ channel_name: 'MLB Network', channel_id: '742' }],
        channels2: [{ channel_name: 'Backup', channel_id: '999' }],
      },
    ],
    'Basketball</span>': [
      {
        // 06:00 GMT (UTC+0) == 06:00 UTC, long past NOW (18:00 UTC) -> drop
        time: '06:00',
        event: 'NBA : Old Game vs Stale Team',
        channels: [{ channel_id: '500' }],
      },
    ],
  },
};

// Some mirrors use a bare label with no date; the freshness gate can't judge it
// so it falls through to the relabel-to-today path.
const SCHEDULE_NO_DATE = {
  Day: {
    'Baseball</span>': [
      {
        time: '20:00',
        event: 'MLB : Boston Red Sox vs Minnesota Twins',
        channels: [{ channel_id: '742' }],
      },
    ],
  },
};

test('parseSchedule keeps current sport events, drops TV Shows and stale ones', () => {
  const events = parseSchedule(SCHEDULE, { nowSec: NOW, displayTz: 'America/Chicago' });
  assert.strictEqual(events.length, 1, 'only the live MLB game survives');
  const e = events[0];
  assert.strictEqual(e.league, 'MLB');
  assert.match(e.name, /^Boston Red Sox vs Minnesota Twins @ /);
  // 20:00 GMT (UTC+0) == 20:00 UTC == 3:00 PM CDT, labeled with the zone
  assert.match(e.name, /3:00 PM CDT$/);
  assert.strictEqual(e.streamRef, '742');
  assert.deepStrictEqual(e.channelIds, ['742', '999']); // primary + backup feed
  assert.deepStrictEqual(e.altStreamRefs, ['999']); // backup handed to the aggregator
  assert.strictEqual(e.endSec, e.startSec + 210 * 60); // MLB duration
});

test('parseSchedule anchors event times to the day-header date', () => {
  const events = parseSchedule(SCHEDULE, { nowSec: NOW });
  const startIso = new Date(events[0].startSec * 1000).toISOString();
  assert.match(startIso, /^2026-06-08T20:00:00/); // header is the 8th == today here
});

test('parseSchedule rejects a schedule whose header date is far stale', () => {
  const stale = {
    'Thursday 20th March 2025 - Schedule Time UK GMT':
      SCHEDULE['Monday 8th June 2026 - Schedule Time UK GMT'],
  };
  const seen = [];
  const events = parseSchedule(stale, { nowSec: NOW, onStaleDay: info => seen.push(info) });
  assert.deepStrictEqual(events, [], 'frozen mirror contributes no phantom events');
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(
    seen[0].driftDays,
    Math.round((Date.UTC(2025, 2, 20) - Date.UTC(2026, 5, 8)) / 86400000),
  );
});

test('parseSchedule keeps a within-tolerance future day, dated to its header', () => {
  const tomorrow = {
    'Tuesday 9th June 2026 - Schedule Time UK GMT':
      SCHEDULE['Monday 8th June 2026 - Schedule Time UK GMT'],
  };
  const events = parseSchedule(tomorrow, { nowSec: NOW });
  // Stamped on the 9th (the header date), so both sport games are upcoming —
  // the 06:00 NBA game is no longer "earlier today" once correctly dated.
  assert.strictEqual(events.length, 2, 'a 1-day-ahead schedule keeps its future games');
  for (const e of events) {
    assert.match(new Date(e.startSec * 1000).toISOString(), /^2026-06-09T/, 'dated to the 9th');
  }
});

test('parseSchedule still processes day keys with no parseable date', () => {
  const events = parseSchedule(SCHEDULE_NO_DATE, { nowSec: NOW });
  assert.strictEqual(events.length, 1, 'unparseable header falls through to relabel-to-today');
});

test('formatEventSuffix renders a DST-accurate Central label', () => {
  // 2026-06-12 19:00 UTC -> Central Daylight (UTC-5) -> 2:00 PM CDT
  const summer = Date.parse('2026-06-12T19:00:00Z') / 1000;
  assert.strictEqual(formatEventSuffix(summer, 'America/Chicago'), 'Jun 12 2:00 PM CDT');
  // 2026-01-12 19:00 UTC -> Central Standard (UTC-6) -> 1:00 PM CST
  const winter = Date.parse('2026-01-12T19:00:00Z') / 1000;
  assert.strictEqual(formatEventSuffix(winter, 'America/Chicago'), 'Jan 12 1:00 PM CST');
  // an explicit zone override still works (Eastern)
  assert.strictEqual(formatEventSuffix(summer, 'America/New_York'), 'Jun 12 3:00 PM EDT');
});

// Mirrors the live dlhd homepage DOM: one day header, categories with a
// .card__meta label, events with .schedule__time[data-time] + .schedule__eventTitle,
// and .schedule__channels anchors carrying watch.php?id=N. Includes a future-dated
// category that must be skipped.
const HOMEPAGE_HTML = `
<div class="schedule__dayTitle">Monday 8th June 2026 - Schedule Time UK GMT</div>
<div class="schedule__category">
  <div class="schedule__catHeader"><div class="card__meta">Soccer</div></div>
  <div class="schedule__categoryBody">
    <div class="schedule__event">
      <div class="schedule__eventHeader" data-title="x">
        <span class="schedule__time" data-time="19:00">19:00</span>
        <span class="schedule__eventTitle">Canada vs Bosnia and Herzegovina</span>
      </div>
      <div class="schedule__channels">
        <a target="_blank" href="/watch.php?id=211" data-ch="event">Feed 1</a>
        <a target="_blank" href="/watch.php?id=5016" data-ch="event">Feed 2</a>
      </div>
    </div>
  </div>
</div>
<div class="schedule__category">
  <div class="schedule__catHeader"><div class="card__meta">FIFA World Cup 2026 — Upcoming Matches Jun 10</div></div>
  <div class="schedule__categoryBody">
    <div class="schedule__event">
      <div class="schedule__eventHeader">
        <span class="schedule__time" data-time="20:00">20:00</span>
        <span class="schedule__eventTitle">Future Game vs Other Team</span>
      </div>
      <div class="schedule__channels"><a href="/watch.php?id=999">Feed</a></div>
    </div>
  </div>
</div>`;

test('parseScheduleHtml parses the live homepage and extracts watch.php channel ids', () => {
  const events = parseScheduleHtml(HOMEPAGE_HTML, { nowSec: NOW, displayTz: 'America/Chicago' });
  assert.strictEqual(events.length, 1, 'today Soccer game kept; future-dated category skipped');
  const e = events[0];
  assert.strictEqual(e.league, 'Soccer');
  // 19:00 GMT (UTC+0) == 19:00 UTC == 2:00 PM CDT
  assert.match(e.name, /^Canada vs Bosnia and Herzegovina @ Jun \d+ 2:00 PM CDT$/);
  assert.strictEqual(e.streamRef, '211');
  assert.deepStrictEqual(e.channelIds, ['211', '5016']);
});

test('parseScheduleHtml rejects a stale homepage via the freshness gate', () => {
  const stale = HOMEPAGE_HTML.replace('Monday 8th June 2026', 'Thursday 20th March 2025');
  assert.deepStrictEqual(parseScheduleHtml(stale, { nowSec: NOW }), []);
});

// dlhd leads the homepage with YESTERDAY's section, then today's. Each game must
// be stamped on its own day header so finished ones drop out — regression for
// "Canada vs Bosnia (yesterday) showing as scheduled today".
const TWO_DAY_HTML = `
<div class="schedule__dayTitle">Sunday 7th June 2026 - Schedule Time UK GMT</div>
<div class="schedule__category">
  <div class="schedule__catHeader"><div class="card__meta">Soccer</div></div>
  <div class="schedule__categoryBody">
    <div class="schedule__event">
      <div class="schedule__eventHeader">
        <span class="schedule__time" data-time="19:00">19:00</span>
        <span class="schedule__eventTitle">Yesterday Game vs Old Team</span>
      </div>
      <div class="schedule__channels"><a href="/watch.php?id=100">Feed</a></div>
    </div>
  </div>
</div>
<div class="schedule__dayTitle">Monday 8th June 2026 - Schedule Time UK GMT</div>
<div class="schedule__category">
  <div class="schedule__catHeader"><div class="card__meta">Soccer</div></div>
  <div class="schedule__categoryBody">
    <div class="schedule__event">
      <div class="schedule__eventHeader">
        <span class="schedule__time" data-time="20:00">20:00</span>
        <span class="schedule__eventTitle">Today Game vs New Team</span>
      </div>
      <div class="schedule__channels"><a href="/watch.php?id=200">Feed</a></div>
    </div>
  </div>
</div>`;

test('parseScheduleHtml drops a leading past-day section, keeps today', () => {
  const events = parseScheduleHtml(TWO_DAY_HTML, { nowSec: NOW, displayTz: 'America/Chicago' });
  assert.strictEqual(events.length, 1, "yesterday's finished game dropped; today's kept");
  assert.match(events[0].name, /^Today Game vs New Team @ /);
  assert.strictEqual(events[0].streamRef, '200');
});

test('parseScheduleHeaderDate extracts the date or returns null', () => {
  assert.deepStrictEqual(
    parseScheduleHeaderDate('Thursday 20th March 2025 - Schedule Time UK GMT'),
    {
      y: 2025,
      m: 3,
      d: 20,
    },
  );
  assert.deepStrictEqual(parseScheduleHeaderDate('Monday 8th June 2026 - Schedule Time UK GMT'), {
    y: 2026,
    m: 6,
    d: 8,
  });
  assert.strictEqual(parseScheduleHeaderDate('Day'), null);
  assert.strictEqual(parseScheduleHeaderDate(''), null);
});

test('parseSchedule drops events whose only channel list is empty', () => {
  const sched = {
    Day: { 'Soccer</span>': [{ time: '20:00', event: 'A vs B', channels: [] }] },
  };
  assert.deepStrictEqual(parseSchedule(sched, { nowSec: NOW }), []);
});

// ---------------------------------------------------------------------------
// Midnight day-rollover
//
// dlhd runs a category past midnight without opening a new day section. Modelled
// on the real 2026-08-13 Baseball block, where 22:40/23:40 were that evening and
// 00:37/01:35 were the small hours of the 14th. Stamping the latter on the header
// date put them ~24h in the past, where the relevance window ate them — 5 of 9
// MLB games vanished from the guide.
const WRAP_SCHEDULE = {
  'Monday 8th June 2026 - Schedule Time UK GMT': {
    'Baseball</span>': [
      { time: '22:40', event: 'MLB : Tigers vs Guardians', channels: [{ channel_id: '1' }] },
      { time: '23:40', event: 'MLB : White Sox vs Reds', channels: [{ channel_id: '2' }] },
      { time: '00:37', event: 'MLB : Blue Jays vs Red Sox', channels: [{ channel_id: '3' }] },
      { time: '01:35', event: 'MLB : Nationals vs Cubs', channels: [{ channel_id: '4' }] },
    ],
  },
};

function startIso(ev) {
  return new Date(ev.startSec * 1000).toISOString();
}
function byName(events, needle) {
  return events.find(e => e.name.includes(needle));
}

test('parseSchedule rolls post-midnight events onto the next day', () => {
  const events = parseSchedule(WRAP_SCHEDULE, { nowSec: NOW });
  assert.strictEqual(events.length, 4, 'all four survive; none dropped as stale');
  assert.match(startIso(byName(events, 'Tigers')), /^2026-06-08T22:40:00/);
  assert.match(startIso(byName(events, 'White Sox')), /^2026-06-08T23:40:00/);
  // the wrap: these are the 9th, not the 8th
  assert.match(startIso(byName(events, 'Blue Jays')), /^2026-06-09T00:37:00/);
  assert.match(startIso(byName(events, 'Nationals')), /^2026-06-09T01:35:00/);
});

test('the rollover is what keeps post-midnight games in the guide at all', () => {
  // Without it these land a day earlier, i.e. already finished, and the
  // relevance window drops them. This is the regression that hid the games.
  const events = parseSchedule(WRAP_SCHEDULE, { nowSec: NOW });
  assert.ok(byName(events, 'Blue Jays'), 'post-midnight game survives the relevance window');
  assert.ok(events.every(e => e.endSec >= NOW - 45 * 60));
});

test('the day only rolls once, even when a category steps backwards twice', () => {
  // dlhd's "Tennis" is not one chronological stream: it lists tournament
  // umbrellas, then per-match rows, stepping backwards more than once. Rolling
  // on every decrease would fling later events days into the future.
  const messy = {
    'Monday 8th June 2026 - Schedule Time UK GMT': {
      'Tennis</span>': [
        { time: '20:30', event: 'Tennis : Umbrella A', channels: [{ channel_id: '1' }] },
        { time: '04:30', event: 'Tennis : Umbrella B', channels: [{ channel_id: '2' }] },
        { time: '20:30', event: 'Tennis : Match One', channels: [{ channel_id: '3' }] },
        { time: '01:00', event: 'Tennis : Match Two', channels: [{ channel_id: '4' }] },
      ],
    },
  };
  const events = parseSchedule(messy, { nowSec: NOW });
  const days = events.map(e => startIso(e).slice(0, 10));
  assert.ok(
    days.every(d => d === '2026-06-08' || d === '2026-06-09'),
    `never rolls past +1 day, got ${JSON.stringify(days)}`,
  );
});

test('an ascending category is never rolled', () => {
  const ascending = {
    'Monday 8th June 2026 - Schedule Time UK GMT': {
      'Soccer</span>': [
        { time: '19:00', event: 'Soccer : A vs B', channels: [{ channel_id: '1' }] },
        { time: '20:00', event: 'Soccer : C vs D', channels: [{ channel_id: '2' }] },
        { time: '21:00', event: 'Soccer : E vs F', channels: [{ channel_id: '3' }] },
      ],
    },
  };
  const events = parseSchedule(ascending, { nowSec: NOW });
  assert.ok(events.every(e => startIso(e).startsWith('2026-06-08')));
});

test('repeated identical times (24/7 feeds) do not trigger a roll', () => {
  // dlhd's Big Brother cams are all listed at 00:00; equal is not a step back.
  const feeds = {
    'Monday 8th June 2026 - Schedule Time UK GMT': {
      'Big Brother</span>': [
        { time: '00:00', event: 'Feeds : Cam 1', channels: [{ channel_id: '1' }] },
        { time: '00:00', event: 'Feeds : Cam 2', channels: [{ channel_id: '2' }] },
        { time: '00:00', event: 'Feeds : Cam 3', channels: [{ channel_id: '3' }] },
      ],
    },
  };
  const events = parseSchedule(feeds, { nowSec: NOW });
  assert.ok(
    events.every(e => startIso(e).startsWith('2026-06-08')),
    'all stay on the header date',
  );
});

test('the roll state is per-category, not shared across the day', () => {
  const twoCats = {
    'Monday 8th June 2026 - Schedule Time UK GMT': {
      'Baseball</span>': [
        { time: '22:40', event: 'MLB : Late Game', channels: [{ channel_id: '1' }] },
        { time: '00:37', event: 'MLB : Wrapped Game', channels: [{ channel_id: '2' }] },
      ],
      'Soccer</span>': [
        { time: '20:00', event: 'Soccer : Plain Game', channels: [{ channel_id: '3' }] },
      ],
    },
  };
  const events = parseSchedule(twoCats, { nowSec: NOW });
  assert.match(startIso(byName(events, 'Wrapped Game')), /^2026-06-09/);
  assert.match(
    startIso(byName(events, 'Plain Game')),
    /^2026-06-08/,
    'a fresh category starts unrolled',
  );
});

test('rolling over a month boundary produces a valid date', () => {
  const monthEnd = {
    'Sunday 30th June 2026 - Schedule Time UK GMT': {
      'Baseball</span>': [
        { time: '23:40', event: 'MLB : Last Of June', channels: [{ channel_id: '1' }] },
        { time: '00:30', event: 'MLB : First Of July', channels: [{ channel_id: '2' }] },
      ],
    },
  };
  const june30 = Date.parse('2026-06-30T18:00:00Z') / 1000;
  const events = parseSchedule(monthEnd, { nowSec: june30 });
  assert.match(startIso(byName(events, 'Last Of June')), /^2026-06-30T23:40:00/);
  assert.match(startIso(byName(events, 'First Of July')), /^2026-07-01T00:30:00/);
});

test('schedule times are read as UTC, not Europe/London', () => {
  // dlhd's header says "Schedule Time UK GMT" and means it literally, even in
  // BST. Read as London time a June 22:40 would be an hour early (21:40 UTC),
  // which would have made a real 5:40 PM CDT first pitch show as 4:40 PM.
  const events = parseSchedule(WRAP_SCHEDULE, { nowSec: NOW, displayTz: 'America/Chicago' });
  const tigers = byName(events, 'Tigers');
  assert.match(startIso(tigers), /^2026-06-08T22:40:00/, 'no BST shift applied');
  assert.match(tigers.name, /5:40 PM CDT$/);
});

// The production path is the HTML scrape, so exercise the rollover through it
// too — cheerio must hand parseSchedule the events in DOM order for the wrap
// detection to mean anything.
const WRAP_HTML = `
<div class="schedule__dayTitle">Monday 8th June 2026 - Schedule Time UK GMT</div>
<div class="schedule__category">
  <div class="schedule__catHeader"><div class="card__meta">Baseball (MLB)</div></div>
  <div class="schedule__categoryBody">
    <div class="schedule__event">
      <div class="schedule__eventHeader">
        <span class="schedule__time" data-time="23:40">23:40</span>
        <span class="schedule__eventTitle">MLB : Evening Game vs Home Team</span>
      </div>
      <div class="schedule__channels"><a href="/watch.php?id=10">Feed</a></div>
    </div>
    <div class="schedule__event">
      <div class="schedule__eventHeader">
        <span class="schedule__time" data-time="00:37">00:37</span>
        <span class="schedule__eventTitle">MLB : Wrapped Game vs Late Team</span>
      </div>
      <div class="schedule__channels"><a href="/watch.php?id=11">Feed</a></div>
    </div>
  </div>
</div>`;

test('parseScheduleHtml rolls a post-midnight event onto the next day', () => {
  const events = parseScheduleHtml(WRAP_HTML, { nowSec: NOW, displayTz: 'America/Chicago' });
  assert.strictEqual(events.length, 2, 'both kept — the wrapped one is no longer dropped as stale');
  assert.match(startIso(byName(events, 'Evening Game')), /^2026-06-08T23:40:00/);
  assert.match(startIso(byName(events, 'Wrapped Game')), /^2026-06-09T00:37:00/);
});
