/**
 * Rate Limiter Middleware — Phase 5
 *
 * Two layers:
 *   1. HTTP rate limiter (express-rate-limit) on REST endpoints
 *   2. WebSocket token-bucket limiter per connection
 *
 * HTTP limits (per IP, per window):
 *   - General API:      120 req / 1 min
 *   - Dashboard API:    60  req / 1 min
 *
 * WebSocket limits (per connection):
 *   - transcript:       20 messages / 10s   (roughly 1 per 500ms)
 *   - monitoring_batch: 10 messages / 10s
 *   - other:            30 messages / 10s
 *
 * Pitfall (LLD note):
 *   express-rate-limit uses an in-memory store by default — not shared
 *   across cluster workers. For production, pass a Redis store:
 *     import { RedisStore } from 'rate-limit-redis';
 *     store: new RedisStore({ client: redisClient })
 */

import rateLimit from 'express-rate-limit';

// --- HTTP Rate Limiters ---

export const generalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

export const dashboardApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many dashboard requests, please slow down.' },
});

// --- WebSocket Token Bucket ---

/**
 * Per-message-type token bucket for a single WebSocket connection.
 *
 * Creates a bucket registry on the ws object itself.
 * Call checkWsRateLimit(ws, messageType) before processing each message.
 *
 * Returns true if the message is allowed, false if it should be dropped.
 */

const WS_LIMITS = {
  transcript:       { tokens: 20, refillEvery: 10_000 },
  monitoring_batch: { tokens: 10, refillEvery: 10_000 },
  monitoring_event: { tokens: 20, refillEvery: 10_000 },
  start_interview:  { tokens: 3,  refillEvery: 60_000 },
  end_interview:    { tokens: 3,  refillEvery: 60_000 },
  ping:             { tokens: 60, refillEvery: 60_000 },
  default:          { tokens: 30, refillEvery: 10_000 },
};

export function initWsBuckets(ws) {
  ws._rateBuckets = {};
  for (const [type, cfg] of Object.entries(WS_LIMITS)) {
    ws._rateBuckets[type] = {
      tokens: cfg.tokens,
      max: cfg.tokens,
      lastRefill: Date.now(),
      refillEvery: cfg.refillEvery,
    };
  }
}

export function checkWsRateLimit(ws, messageType) {
  if (!ws._rateBuckets) return true; // Buckets not initialized — allow

  const bucketKey = ws._rateBuckets[messageType] ? messageType : 'default';
  const bucket = ws._rateBuckets[bucketKey];

  const now = Date.now();
  const elapsed = now - bucket.lastRefill;

  if (elapsed >= bucket.refillEvery) {
    bucket.tokens = bucket.max;
    bucket.lastRefill = now;
  }

  if (bucket.tokens <= 0) {
    console.warn(`[RateLimit] WS message type "${messageType}" rate limited on connection`);
    return false;
  }

  bucket.tokens--;
  return true;
}
