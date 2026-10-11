// Keeps a source reachable across domain rotation. These sites (thetvapp,
// daddylive, streameast, ...) cycle base domains constantly, so each provider
// holds an ordered list of candidate base URLs and a liveness probe; this class
// tracks which one is currently live and rotates to the next when the active
// one stops responding.
//
// The probe is provider-supplied (e.g. "GET / returns 200 with the expected
// markup") so MirrorResolver stays transport-agnostic and unit-testable.
class MirrorResolver {
  constructor(name, urls, { probe } = {}) {
    const cleaned = [
      ...new Set((urls || []).map(u => String(u).trim().replace(/\/+$/, '')).filter(Boolean)),
    ];
    if (cleaned.length === 0) throw new Error(`MirrorResolver(${name}): no candidate urls`);
    this.name = name;
    this.urls = cleaned;
    this.probe = probe || (async () => true);
    this.activeIndex = 0;
    this._resolving = null;
  }

  active() {
    return this.urls[this.activeIndex];
  }

  // Probe candidates starting at `start`, wrapping around the ring, and set the
  // active mirror to the first that responds. Returns the live URL, or null if
  // none respond (active is left unchanged so callers can keep trying it).
  // Concurrent calls share one in-flight probe pass.
  async resolve({ start = this.activeIndex } = {}) {
    if (this._resolving) return this._resolving;
    this._resolving = (async () => {
      for (let i = 0; i < this.urls.length; i++) {
        const idx = (start + i) % this.urls.length;
        const url = this.urls[idx];
        let live = false;
        try {
          live = await this.probe(url);
        } catch {
          live = false;
        }
        if (live) {
          if (idx !== this.activeIndex) {
            console.log(`[${this.name}] mirror -> ${url}`);
            this.activeIndex = idx;
          }
          return url;
        }
      }
      console.error(`[${this.name}] no live mirror among ${this.urls.length} candidate(s)`);
      return null;
    })();
    try {
      return await this._resolving;
    } finally {
      this._resolving = null;
    }
  }

  // Re-probe from the top of the list so the active mirror returns to the most
  // preferred live domain once it recovers. Leaves the active mirror alone
  // when nothing probes live.
  async preferFirst() {
    return this.resolve({ start: 0 });
  }

  // Treat the current mirror as failed: probe forward from the NEXT candidate so
  // a dead active domain is skipped before retrying it.
  async rotate() {
    if (this.urls.length === 1) return this.active();
    return this.resolve({ start: (this.activeIndex + 1) % this.urls.length });
  }
}

module.exports = MirrorResolver;
