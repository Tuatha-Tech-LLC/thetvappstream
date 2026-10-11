const { PROVIDERS, ENABLE_EVENT_STREAMS, M3U_SOURCES } = require('../config');
const Aggregator = require('../Aggregator');
const TheTvAppProvider = require('./thetvapp');
const DaddyLiveProvider = require('./daddylive');
const M3uProvider = require('./m3u');
const { parseM3uSources } = require('./m3u/parse');

// Provider registry. Each entry is a lazy factory so only the providers named
// in the PROVIDERS env var get constructed. Add new sources here — nothing else
// in the app needs to change.
const REGISTRY = {
  thetvapp: () => new TheTvAppProvider({ enableEvents: ENABLE_EVENT_STREAMS }),
  daddylive: () => new DaddyLiveProvider(),
};

// One provider per M3U_SOURCES entry, appended after the PROVIDERS list (they
// carry no events, so their order only affects channel numbering). A bad entry
// is logged and skipped rather than taking the whole server down.
function createM3uProviders(raw = M3U_SOURCES, taken = new Set()) {
  let sources = [];
  try {
    sources = parseM3uSources(raw);
  } catch (e) {
    console.error(`[providers] ${e.message}`);
    return [];
  }
  const out = [];
  for (const src of sources) {
    if (REGISTRY[src.name] || taken.has(src.name)) {
      console.error(`[providers] M3U source name '${src.name}' clashes with a provider, skipping`);
      continue;
    }
    taken.add(src.name);
    out.push(new M3uProvider(src));
  }
  return out;
}

function createProviders(names = PROVIDERS, m3uSources = M3U_SOURCES) {
  const providers = [];
  for (const name of names) {
    const factory = REGISTRY[name];
    if (!factory) {
      console.error(`[providers] unknown provider '${name}', skipping`);
      continue;
    }
    providers.push(factory());
  }
  providers.push(...createM3uProviders(m3uSources, new Set(providers.map(p => p.name))));
  if (providers.length === 0) {
    console.error('[providers] no providers configured (check PROVIDERS env var)');
  }
  return providers;
}

function createAggregator(names = PROVIDERS, m3uSources = M3U_SOURCES) {
  return new Aggregator(createProviders(names, m3uSources));
}

module.exports = { REGISTRY, createProviders, createM3uProviders, createAggregator };
