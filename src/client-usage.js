// Per-client usage accounting (proxy.clientKeys).
//
// One shared proxy.apiKey means every consumer of a team proxy looks the same:
// the per-account usage the account manager keeps says WHAT was spent, never by
// WHOM. `proxy.clientKeys` gives each consumer their own key + name; the auth
// gates report which entry matched, and the tokens each response reports are
// then booked against that name — per-CLIENT accounting alongside the existing
// per-ACCOUNT accounting, fed by the same response parsing.
//
// The tracker itself is deliberately dumb: a name → counters map. Identity
// resolution (which key matched) lives in the auth gates (server.js / mitm.js);
// token extraction stays where it always was (server.js). This file only
// aggregates, so it can be tested — and reasoned about — in isolation.
//
// Attribution is best-effort by design: loopback traffic that presents no key
// is exempt from the gate and therefore unattributed, as is anything using the
// single shared proxy.apiKey. Deployments that want complete per-client stats
// give every consumer a clientKeys entry and treat the shared key as legacy.

export const DEFAULT_USAGE_DIMENSION_MAX_KEYS = 500;
export const DEFAULT_SESSION_USAGE_MAX_KEYS = 1000;
export const SESSION_USAGE_TTL_MS = 60 * 60 * 1000;
export const USAGE_DIMENSION_VALUE_MAX_LENGTH = 200;

const RESERVED_CUSTOM_HEADER_NAMES = new Set([
  'authorization',
  'x-api-key',
  'x-app',
  'x-claude-code-session-id',
  'x-claude-code-agent-id',
  'x-claude-code-parent-agent-id',
  'x-anthropic-additional-protection',
]);

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/i;
const DIMENSION_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export class ClientUsageTracker {
  constructor({ now = () => Date.now(), maxKeys = Infinity, ttlMs = 0 } = {}) {
    this.clients = new Map(); // name → { requests, inputTokens, outputTokens, lastUsed(ms) }
    this._now = now;
    this.maxKeys = maxKeys;
    this.ttlMs = ttlMs;
  }

  _ensure(name) {
    this._pruneExpired();
    let c = this.clients.get(name);
    if (!c) {
      if (this.clients.size >= this.maxKeys) this._evictOldest();
      if (this.clients.size >= this.maxKeys) return null;
      c = { requests: 0, inputTokens: 0, outputTokens: 0, lastUsed: null };
      this.clients.set(name, c);
    }
    return c;
  }

  _pruneExpired() {
    if (!this.ttlMs) return;
    const cutoff = this._now() - this.ttlMs;
    for (const [name, c] of this.clients) {
      if ((c.lastUsed || 0) < cutoff) this.clients.delete(name);
    }
  }

  _evictOldest() {
    let oldestName = null;
    let oldest = Infinity;
    for (const [name, c] of this.clients) {
      const t = c.lastUsed || 0;
      if (t < oldest) {
        oldest = t;
        oldestName = name;
      }
    }
    if (oldestName != null) this.clients.delete(oldestName);
  }

  /** Book usage against a client name. A null/empty name is dropped (unattributed). */
  record(name, { requests = 0, inputTokens = 0, outputTokens = 0 } = {}) {
    if (!name) return;
    const c = this._ensure(name);
    if (!c) return;
    c.requests += requests;
    c.inputTokens += inputTokens;
    c.outputTokens += outputTokens;
    c.lastUsed = this._now();
  }

  /**
   * Plain-object snapshot for the state file and /teamclaude/status
   * (lastUsed as ISO string, matching how the status endpoint reports times).
   */
  export() {
    this._pruneExpired();
    const out = {};
    for (const [name, c] of this.clients) {
      out[name] = {
        requests: c.requests,
        inputTokens: c.inputTokens,
        outputTokens: c.outputTokens,
        lastUsed: c.lastUsed ? new Date(c.lastUsed).toISOString() : null,
      };
    }
    return out;
  }

  /**
   * Restore a snapshot saved by a previous run. Adds onto anything already
   * recorded (restore runs at startup, but being additive means a late restore
   * can never erase live traffic). Malformed entries are skipped, not fatal —
   * the state file is documented as safe to delete, so it must also be safe to
   * hand-edit badly.
   */
  restore(saved) {
    if (!saved || typeof saved !== 'object') return;
    for (const [name, s] of Object.entries(saved)) {
      if (!name || !s || typeof s !== 'object') continue;
      const c = this._ensure(name);
      if (!c) continue;
      c.requests += Number(s.requests) || 0;
      c.inputTokens += Number(s.inputTokens) || 0;
      c.outputTokens += Number(s.outputTokens) || 0;
      const t = s.lastUsed ? Date.parse(s.lastUsed) : NaN;
      if (!Number.isNaN(t) && (c.lastUsed == null || t > c.lastUsed)) c.lastUsed = t;
    }
  }
}

export class UsageDimensionTracker {
  constructor({ now = () => Date.now(), maxKeys = DEFAULT_USAGE_DIMENSION_MAX_KEYS, sessionMaxKeys = DEFAULT_SESSION_USAGE_MAX_KEYS, sessionTtlMs = SESSION_USAGE_TTL_MS } = {}) {
    this._now = now;
    this._dimensions = new Map();
    this._maxKeys = maxKeys;
    this._sessionMaxKeys = sessionMaxKeys;
    this._sessionTtlMs = sessionTtlMs;
  }

  _tracker(name) {
    const key = normalizeDimensionName(name);
    if (!key) return null;
    let tracker = this._dimensions.get(key);
    if (!tracker) {
      tracker = new ClientUsageTracker({ now: this._now, maxKeys: key === 'session' ? this._sessionMaxKeys : this._maxKeys, ttlMs: key === 'session' ? this._sessionTtlMs : 0 });
      this._dimensions.set(key, tracker);
    }
    return tracker;
  }

  record(dimension, key, usage) {
    const tracker = this._tracker(dimension);
    if (!tracker || !key) return;
    tracker.record(key, usage);
  }

  export({ includeSessions = true } = {}) {
    const out = {};
    for (const [name, tracker] of this._dimensions) {
      if (!includeSessions && name === 'session') continue;
      const entries = tracker.export();
      if (Object.keys(entries).length) out[name] = entries;
    }
    return out;
  }

  restore(saved) {
    if (!saved || typeof saved !== 'object') return;
    for (const [name, entries] of Object.entries(saved)) {
      if (name === 'session') continue;
      const tracker = this._tracker(name);
      if (tracker) tracker.restore(entries);
    }
  }
}

export function resolveUsageDimensions(proxyConfig, headers = {}) {
  const out = [];
  const configured = Array.isArray(proxyConfig?.usageDimensions) ? proxyConfig.usageDimensions : [];
  for (const entry of configured) {
    const name = normalizeDimensionName(entry?.name);
    const header = normalizeUsageHeaderName(entry?.header);
    if (!name || !header) continue;
    const value = sanitizeUsageDimensionValue(headers[header]);
    if (value) out.push({ name, key: value });
  }
  const session = sanitizeSessionId(headers['x-claude-code-session-id']);
  if (session) out.push({ name: 'session', key: session });
  return out;
}

export function createUsageRecorder({ client, clientUsage, dimensions, dimensionUsage }) {
  const targets = [];
  if (client && clientUsage) targets.push({ tracker: clientUsage, key: client });
  if (dimensionUsage) {
    for (const dimension of dimensions || []) {
      targets.push({ tracker: dimensionUsage, dimension: dimension.name, key: dimension.key });
    }
  }
  if (!targets.length) return { recordRequest: () => {}, onUsage: null };
  return {
    recordRequest() {
      for (const target of targets) {
        if (target.dimension) target.tracker.record(target.dimension, target.key, { requests: 1 });
        else target.tracker.record(target.key, { requests: 1 });
      }
    },
    onUsage(inputTokens, outputTokens) {
      for (const target of targets) {
        if (target.dimension) target.tracker.record(target.dimension, target.key, { inputTokens, outputTokens });
        else target.tracker.record(target.key, { inputTokens, outputTokens });
      }
    },
  };
}

function normalizeDimensionName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return DIMENSION_NAME_RE.test(name) ? name : null;
}

function normalizeUsageHeaderName(value) {
  if (typeof value !== 'string') return null;
  const header = value.trim().toLowerCase();
  if (!header || !HEADER_NAME_RE.test(header)) return null;
  if (RESERVED_CUSTOM_HEADER_NAMES.has(header)) return null;
  return header;
}

export function sanitizeUsageDimensionValue(value, { maxLength = USAGE_DIMENSION_VALUE_MAX_LENGTH } = {}) {
  if (Array.isArray(value)) value = value.join(', ');
  if (typeof value !== 'string') return null;
  const sanitized = value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]|\p{C}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!sanitized) return null;
  return sanitized.length > maxLength ? sanitized.slice(0, maxLength) : sanitized;
}

function sanitizeSessionId(value) {
  const sanitized = sanitizeUsageDimensionValue(value, { maxLength: 80 });
  return sanitized && /^[A-Za-z0-9._:-]+$/.test(sanitized) ? sanitized : null;
}
