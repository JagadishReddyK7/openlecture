// Per-account rate limits, shared by every core-api instance (Redis).
//
// Keyed by account, not by IP: behind a campus NAT (and behind Docker
// Desktop here) thousands of students share one address, so a per-IP limit
// would throttle a whole university, or the whole load test.
//
// Fixed window: one INCR per request, the key expires with its window. The
// known weakness is a burst of up to 2x the limit straddling a window edge;
// a sliding window or token bucket fixes that for one more Redis operation.
import redis from '../config/redis.js';

// KEYS: counter. ARGV: window seconds. -> count in the current window
const HIT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`;

export const LIMITS = {
  question: { max: 10, windowSec: 60 },   // per student
  vote:     { max: 30, windowSec: 10 },   // per student
  ticket:   { max: 30, windowSec: 60 },   // per account (reconnect loops)
  loginFail: { max: 10, windowSec: 900 }, // failed logins per email
};

export class RateLimitError extends Error {
  constructor(what) {
    super(`Too many ${what} requests, slow down`);
    this.status = 429;
  }
}

// Counts this request; throws RateLimitError once the window's limit is passed
export async function hit(kind, who) {
  const { max, windowSec } = LIMITS[kind];
  const n = await redis.eval(HIT, { keys: [`rl:${kind}:${who}`], arguments: [String(windowSec)] });
  if (n > max) throw new RateLimitError(kind);
}

// For counting failures only (login): is the limit already reached?
export async function exhausted(kind, who) {
  return Number((await redis.get(`rl:${kind}:${who}`)) || 0) >= LIMITS[kind].max;
}

const rateLimit = { hit, exhausted, LIMITS, RateLimitError };
export default rateLimit;
