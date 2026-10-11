const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseLeagueListing,
  parseRelativeStartSec,
  isEndedBadge,
  parseWatchPage,
  parseEmbedPlaylist,
  LEAGUE_BY_PATH,
} = require('../providers/thetvapp/parse');

const LISTING = `
<div class="col-lg-12"><h4>MLB</h4>
<ol class="list-group list-group-numbered mb-4">
  <a class="list-group-item" href="https://the-tv.app/tv-live/mlb/new-york-yankees-cleveland-guardians/7515936008">Cleveland Guardians vs New York Yankees: <span class="time-badge"> In Progress </span> HD</a>
  <a class="list-group-item" href="/tv-live/mlb/san-diego-padres-cincinnati-reds/7515952976">San Diego Padres vs Cincinnati Reds: <span class="time-badge">13 minutes from now</span> HD</a>
  <a class="list-group-item" href="/tv-live/mlb/x-y/7515958632">Team X vs Team Y: <span class="time-badge">Final</span> HD</a>
</ol></div>`;

test('parseLeagueListing extracts matchup, path, time badge', () => {
  const rows = parseLeagueListing(LISTING, 'MLB');
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].matchup, 'Cleveland Guardians vs New York Yankees');
  assert.strictEqual(rows[0].href, '/tv-live/mlb/new-york-yankees-cleveland-guardians/7515936008');
  assert.strictEqual(rows[0].timeText, 'In Progress');
  assert.strictEqual(rows[1].href, '/tv-live/mlb/san-diego-padres-cincinnati-reds/7515952976');
  assert.strictEqual(rows[1].matchup, 'San Diego Padres vs Cincinnati Reds');
});

test('parseRelativeStartSec handles in-progress / minutes / hours / unknown', () => {
  const now = 1_000_000;
  assert.strictEqual(parseRelativeStartSec('In Progress', now), now);
  assert.strictEqual(parseRelativeStartSec('13 minutes from now', now), now + 13 * 60);
  assert.strictEqual(parseRelativeStartSec('2 hours from now', now), now + 2 * 3600);
  assert.strictEqual(parseRelativeStartSec('Starting Soon', now), now + 5 * 60);
  assert.strictEqual(parseRelativeStartSec('Final', now), null);
  assert.strictEqual(parseRelativeStartSec('', now), null);
});

test('isEndedBadge flags only finished games', () => {
  assert.ok(isEndedBadge('Final'));
  assert.ok(isEndedBadge('Full Time'));
  assert.ok(isEndedBadge('Postponed'));
  assert.ok(!isEndedBadge('In Progress'));
  assert.ok(!isEndedBadge('2 hours from now'));
  // A weather delay is a live game that resumes — it must not drop the channel.
  assert.ok(!isEndedBadge('Delayed'));
  assert.ok(!isEndedBadge('Rain Delay'));
  assert.ok(isEndedBadge('FT'));
  assert.ok(isEndedBadge('Abandoned'));
});

const WATCH = `
<h1>Giants vs Nationals</h1>
<p>Start Time: 56 seconds from now</p>
<button onclick="window.changeStream(51828)">Server1</button>
<button onclick="window.changeStream(51829)">Backup</button>
<div>Date: 2026-06-10 15:45ET</div>
<iframe src="https://gooz.aapmains.net/new-stream-embed/51828"></iframe>`;

test('parseWatchPage reads absolute ET time, stream ids, embed host', () => {
  const { startSec, streamIds, embedHost } = parseWatchPage(WATCH);
  assert.deepStrictEqual(streamIds, ['51828', '51829']);
  assert.strictEqual(embedHost, 'gooz.aapmains.net');
  // 2026-06-10 15:45 ET == 19:45 UTC (EDT, UTC-4)
  const d = new Date(startSec * 1000);
  assert.strictEqual(d.getUTCHours(), 19);
  assert.strictEqual(d.getUTCMinutes(), 45);
});

test('parseEmbedPlaylist extracts the load-playlist url', () => {
  const embed = `clappr.Player({source: "https://chatgpt.hereisman.net/playlist/51828/load-playlist"});`;
  assert.strictEqual(
    parseEmbedPlaylist(embed, 'https://gooz.aapmains.net'),
    'https://chatgpt.hereisman.net/playlist/51828/load-playlist',
  );
  // relative source resolves against the embed origin
  assert.strictEqual(
    parseEmbedPlaylist(`source:'/playlist/9/load-playlist'`, 'https://gooz.aapmains.net'),
    'https://gooz.aapmains.net/playlist/9/load-playlist',
  );
  assert.strictEqual(parseEmbedPlaylist('<html>no source</html>', 'https://x.y'), null);
});

test('LEAGUE_BY_PATH maps cfb -> NCAAF and covers the nav tabs', () => {
  assert.strictEqual(LEAGUE_BY_PATH['/watch/cfb-streams'], 'NCAAF');
  assert.strictEqual(LEAGUE_BY_PATH['/watch/mlb-streams'], 'MLB');
  assert.strictEqual(Object.keys(LEAGUE_BY_PATH).length, 11);
});
