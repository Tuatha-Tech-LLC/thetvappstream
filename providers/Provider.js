// Base contract every stream source implements. The Aggregator talks ONLY to
// this surface, so adding a source is a new subclass with zero changes to
// M3U/EPG assembly or the HTTP layer.
//
// streamRef is opaque to the aggregator: whatever a provider puts on an event /
// channel here is handed straight back to resolveStream(). resolveStream may
// return required request headers (Referer/Origin) for embed-based sources that
// won't play from a bare redirect.
class Provider {
  get name() {
    throw new Error('provider must define a name');
  }

  // Idempotent readiness: session bootstrap, cookie warmup, base-URL probing.
  async ensureReady() {}

  // Re-scrape time-sensitive event listings. No-op for sources without events.
  async refreshEvents() {}

  // Persistent 24/7 channels as { displayName: streamRef }, or an array of
  // { name, ref, logo?, group? } when the source supplies its own artwork and
  // groups. Event-only sources return {}.
  async listLinearChannels() {
    return {};
  }

  // Live sport events, normalized:
  //   [{ league, name, startSec, endSec, streamRef, logo }]
  // `name` is preserved verbatim downstream (the Dispatcharr scheduler parses
  // the "@ <time>" suffix out of it), so keep it human-readable.
  async listEvents() {
    return [];
  }

  // EPG for THIS provider's LINEAR channels, pre-merge:
  //   { items: [{ name, chid, logo }],
  //     programmesByChid: { chid: [{ title, startTime, endTime,
  //                                  episodeTitle?, desc?, categories?, icon? }] } }
  // Event programmes are synthesized by the Aggregator from listEvents(), so
  // they must NOT be included here.
  async getEpgData() {
    return { items: [], programmesByChid: {} };
  }

  // Resolve an opaque streamRef to a playable stream:
  //   { url, headers? }
  async resolveStream(streamRef) {
    throw new Error(`provider '${this.name}' must implement resolveStream (ref=${streamRef})`);
  }
}

module.exports = Provider;
