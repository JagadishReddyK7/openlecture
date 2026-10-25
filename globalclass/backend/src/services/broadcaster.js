// Coalesced Q&A broadcasts, correct across core-api instances.
//
// Before: every mutation on every instance published the full ranked list, so
// N votes/s became N messages/s for every client (P1: 21 votes/s at 200
// clients cost ~80 MB/s). Now at most one broadcast per lecture per window,
// however many mutations arrive and on however many instances.
//
// How (all state in Redis, per lecture):
//   qa:ver:<id>       bumped once per mutation, after its data is written
//   qa:bcast:<id>     lease: which instance is the broadcaster right now
//   qa:sent:<id>      highest seq published so far
//   qa:snapshot:<id>  last published payload (served to new connections)
//
// 1. A mutation runs MARK_DIRTY: INCR ver and SET lease NX, in one script.
//    If it got the lease, this instance publishes now (leading edge, so an
//    isolated vote is not delayed). If not, the lease holder will cover it.
// 2. The holder reads ver, builds the payload, publishes (only if it still
//    holds the lease and ver is newer than sent), waits one window, then runs
//    RELEASE_OR_CONTINUE: if ver did not move, drop the lease; if it did,
//    loop and publish again (trailing edge).
//
// Why the last update is never dropped: take any mutation M. Its INCR and its
// SET NX are one atomic step. If the lease was free, M takes it and publishes.
// If it was held, the holder's release check runs either after M's INCR (sees
// ver moved, publishes again) or before it (lease already gone, so M's SET NX
// succeeds). Redis runs scripts one at a time, so there is no third case.
//
// If the holder crashes, its lease expires after LEASE_MS and the sweeper on
// any instance with sockets in that lecture (ver > sent, lease free) takes
// over. Only the lease holder publishes and the publish script refuses a seq
// <= sent, so seq is strictly increasing on the channel.
import crypto from 'crypto';

export const verKey   = (id) => `qa:ver:${id}`;
export const leaseKey = (id) => `qa:bcast:${id}`;
export const sentKey  = (id) => `qa:sent:${id}`;
export const snapKey  = (id) => `qa:snapshot:${id}`;
export const channel  = (id) => `qa:broadcast:${id}`;

const LEASE_MS = 2000;

// KEYS: ver, lease. ARGV: instanceId, leaseMs. -> { seq, gotLease (1|0) }
const MARK_DIRTY = `
local v = redis.call('INCR', KEYS[1])
if redis.call('SET', KEYS[2], ARGV[1], 'NX', 'PX', ARGV[2]) then return {v, 1} end
return {v, 0}
`;

// KEYS: lease, sent, snapshot. ARGV: instanceId, seq, payload, channel.
// -> -1 lease lost, 0 nothing newer to send, 1 published
const PUBLISH_IF_LEASED = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
if tonumber(redis.call('GET', KEYS[2]) or '0') >= tonumber(ARGV[2]) then return 0 end
redis.call('SET', KEYS[2], ARGV[2])
redis.call('SET', KEYS[3], ARGV[3])
redis.call('PUBLISH', ARGV[4], ARGV[3])
return 1
`;

// KEYS: lease, ver. ARGV: instanceId, seqJustPublished, leaseMs.
// -> -1 lease lost, 0 released (nothing new), 1 kept (ver moved: go again)
const RELEASE_OR_CONTINUE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return -1 end
if tonumber(redis.call('GET', KEYS[2]) or '0') <= tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1])
  return 0
end
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return 1
`;

// KEYS: ver, sent, lease. ARGV: instanceId, leaseMs.
// -> 1 if there is unpublished state and we took the lease
const TRY_SWEEP = `
if tonumber(redis.call('GET', KEYS[1]) or '0') <= tonumber(redis.call('GET', KEYS[2]) or '0') then return 0 end
if redis.call('SET', KEYS[3], ARGV[1], 'NX', 'PX', ARGV[2]) then return 1 end
return 0
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object}   opts
 * @param {object}   opts.redis         node-redis client (commands, not a subscriber)
 * @param {Function} opts.buildPayload  async (lectureId, seq) => string; must read
 *                                      data AFTER seq was read (caller passes seq)
 * @param {number}   [opts.windowMs]    coalescing window
 * @param {string}   [opts.instanceId]  unique per process
 */
export function createBroadcaster({ redis, buildPayload, windowMs = 250, instanceId = crypto.randomUUID() }) {
  const running = new Set();   // lectures this process is broadcasting for
  const rerun = new Set();     // lease (re)acquired while a loop was finishing

  async function run(lectureId) {
    // A loop that is about to exit may already have released the lease that
    // a new mutation here just took. Let that loop go round once more instead
    // of leaving the lease held with nobody publishing.
    if (running.has(lectureId)) { rerun.add(lectureId); return; }
    running.add(lectureId);
    try {
      for (;;) {
        const seq = Number((await redis.get(verKey(lectureId))) || 0);
        const payload = await buildPayload(lectureId, seq);
        const pub = await redis.eval(PUBLISH_IF_LEASED, {
          keys: [leaseKey(lectureId), sentKey(lectureId), snapKey(lectureId)],
          arguments: [instanceId, String(seq), payload, channel(lectureId)],
        });
        if (pub === -1) return;
        await sleep(windowMs);
        const next = await redis.eval(RELEASE_OR_CONTINUE, {
          keys: [leaseKey(lectureId), verKey(lectureId)],
          arguments: [instanceId, String(seq), String(LEASE_MS)],
        });
        if (next !== 1) return;
      }
    } catch (err) {
      // Lease expires on its own; the sweeper on some instance picks it up.
      console.error(`[Broadcast] ${lectureId}:`, err.message);
    } finally {
      running.delete(lectureId);
      if (rerun.delete(lectureId)) run(lectureId);
    }
  }

  // Call after a mutation's data is written. Returns the mutation's seq.
  async function onMutation(lectureId) {
    const [seq, gotLease] = await redis.eval(MARK_DIRTY, {
      keys: [verKey(lectureId), leaseKey(lectureId)],
      arguments: [instanceId, String(LEASE_MS)],
    });
    if (gotLease === 1) run(lectureId);   // not awaited: the sender's ACK shouldn't wait
    return seq;
  }

  // Safety net for a crashed lease holder. Cheap: one script call.
  async function sweep(lectureId) {
    const took = await redis.eval(TRY_SWEEP, {
      keys: [verKey(lectureId), sentKey(lectureId), leaseKey(lectureId)],
      arguments: [instanceId, String(LEASE_MS)],
    });
    if (took === 1) run(lectureId);
    return took === 1;
  }

  const getSnapshot = (lectureId) => redis.get(snapKey(lectureId));

  return { onMutation, sweep, getSnapshot, instanceId };
}
