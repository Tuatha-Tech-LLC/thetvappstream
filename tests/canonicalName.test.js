const test = require('node:test');
const assert = require('node:assert');
const { stripTime, teamSet, canonicalKey, canonicalEventId } = require('../canonicalName');

const startA = Date.parse('2026-05-22T23:10:00Z') / 1000;

test('stripTime removes the trailing "@ time" suffix', () => {
  assert.strictEqual(
    stripTime('Minnesota Twins vs Boston Red Sox @ May 22 7:10 PM'),
    'Minnesota Twins vs Boston Red Sox',
  );
});

test('teamSet is order- and format-independent', () => {
  assert.deepStrictEqual(
    teamSet('Boston Red Sox vs Minnesota Twins @ May 22 7:10 PM'),
    teamSet('Minnesota Twins at Boston Red Sox @ 7:10pm'),
  );
});

test('canonicalKey matches the same game described two ways', () => {
  const a = {
    league: 'MLB',
    name: 'Minnesota Twins vs Boston Red Sox @ May 22 7:10 PM',
    startSec: startA,
  };
  const b = {
    league: 'mlb',
    name: 'Boston Red Sox at Minnesota Twins @ 7:10pm',
    // 20 min later, same UTC day -> same bucket
    startSec: startA + 20 * 60,
  };
  assert.strictEqual(canonicalKey(a), canonicalKey(b));
});

test('canonicalKey separates different matchups', () => {
  const a = { league: 'MLB', name: 'Twins vs Red Sox', startSec: startA };
  const b = { league: 'MLB', name: 'Twins vs Yankees', startSec: startA };
  assert.notStrictEqual(canonicalKey(a), canonicalKey(b));
});

test('canonicalKey separates the same matchup on different days', () => {
  const a = { league: 'MLB', name: 'Twins vs Red Sox', startSec: startA };
  const b = { league: 'MLB', name: 'Twins vs Red Sox', startSec: startA + 24 * 3600 };
  assert.notStrictEqual(canonicalKey(a), canonicalKey(b));
});

test('canonicalEventId is evt- prefixed and url/xmltv-safe', () => {
  const id = canonicalEventId({
    league: 'MLB',
    name: 'Twins vs Red Sox @ May 22 7:10 PM',
    startSec: startA,
  });
  assert.match(id, /^evt-[a-z0-9-]+$/);
});

const { sameTeam, sameGame, leaguesCompatible } = require('../canonicalName');

test('sameTeam matches nickname-only, abbreviated-city and club-suffix forms', () => {
  assert.ok(sameTeam('Detroit Tigers', 'Tigers'));
  assert.ok(sameTeam('LA Dodgers', 'Los Angeles Dodgers'));
  assert.ok(sameTeam('Inter Miami CF', 'Inter Miami'));
  assert.ok(sameTeam('Arsenal FC', 'Arsenal'));
  assert.ok(!sameTeam('Detroit Tigers', 'Detroit Red Wings'));
  // Shared generic words don't identify a side.
  assert.ok(!sameTeam('Real Madrid', 'Atletico Madrid'));
  assert.ok(!sameTeam('AC Milan', 'Inter Milan'));
  assert.ok(!sameTeam('Ohio State', 'Michigan State'));
  assert.ok(!sameTeam('Manchester United', 'Newcastle United'));
  assert.ok(sameTeam('Manchester United', 'Manchester United FC'));
  assert.ok(!sameTeam('Team 2', 'Squad 2')); // numeric tails don't identify a side
});

test('leaguesCompatible lets a generic Soccer bucket pair with a named competition', () => {
  assert.ok(leaguesCompatible('MLB', 'mlb'));
  assert.ok(leaguesCompatible('Soccer', 'English Premier League'));
  assert.ok(!leaguesCompatible('Soccer', 'MLB'));
  assert.ok(!leaguesCompatible('NHL', 'MLB'));
});

test('sameGame pairs spelling variants within the start window, either home/away order', () => {
  const t = 1_780_000_000;
  const a = { league: 'MLB', name: 'Detroit Tigers vs Cleveland Guardians @ x', startSec: t };
  const b = { league: 'MLB', name: 'Guardians vs Tigers @ y', startSec: t + 20 * 60 };
  assert.ok(sameGame(a, b));
  // Same matchup as a doubleheader nightcap 5h later stays separate.
  assert.ok(!sameGame(a, { ...b, startSec: t + 5 * 3600 }));
  // Same cities, different sport.
  assert.ok(!sameGame(a, { ...b, league: 'NHL' }));
  // Only one side matches.
  assert.ok(!sameGame(a, { ...b, name: 'Tigers vs Royals' }));
});
