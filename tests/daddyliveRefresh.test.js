const test = require('node:test');
const assert = require('node:assert');
const DaddyLiveProvider = require('../providers/daddylive');

const NOW = Math.floor(Date.now() / 1000);

function provider(get) {
  const p = new DaddyLiveProvider({ urls: ['https://a.example'], enableEvents: true });
  p.client = { get };
  p.mirrors.rotate = async () => null;
  return p;
}

function event(name, endSec) {
  return { league: 'NHL', name, startSec: endSec - 3 * 3600, endSec, streamRef: '51' };
}

test('refreshEvents keeps unfinished last-good events when both schedule sources fail', async () => {
  const p = provider(async () => {
    throw new Error('connect ECONNREFUSED');
  });
  p.eventsCache = [event('Live game', NOW + 3600), event('Finished game', NOW - 60)];

  await p.refreshEvents();

  assert.deepStrictEqual(
    (await p.listEvents()).map(e => e.name),
    ['Live game'],
  );
});

test('refreshEvents keeps last-good events when the JSON fallback parses to nothing', async () => {
  const p = provider(async url =>
    url.endsWith('.json')
      ? { status: 200, data: { 'Tuesday 28th April 2026 - Schedule Time UK GMT': {} } }
      : { status: 200, data: '<html>no schedule</html>' },
  );
  p.eventsCache = [event('Live game', NOW + 3600)];

  await p.refreshEvents();

  assert.strictEqual((await p.listEvents()).length, 1);
});
