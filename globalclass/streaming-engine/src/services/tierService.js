// Viewer tier allocation (ADR-001)
//
// The first WEBRTC_PRIORITY_LIMIT viewers of a lecture get a WebRTC slot,
// everyone after that is sent to HLS.
//
// Why Redis and not LiveKit's participant count:
//   The old code read numParticipants from LiveKit and then issued a token.
//   That is check-then-act: 1000 students clicking "join" together all read
//   a count below the limit and all got WebRTC. It also counted only people
//   already connected, not tokens handed out, and cost one LiveKit API
//   round-trip on every join.
//
// Now slots live in a Redis sorted set per lecture (member = userId,
// score = time the slot was given). A Lua script checks and claims a slot in
// one atomic step, so the cap can't be exceeded no matter how many
// streaming-engine instances run. Re-joining with the same user reuses the
// same slot.

import { RoomServiceClient } from 'livekit-server-sdk';
import redis from '../config/redis.js';

export const WEBRTC_PRIORITY_LIMIT = parseInt(process.env.WEBRTC_PRIORITY_LIMIT || '500', 10);

const SLOT_TTL_SECONDS = 6 * 60 * 60;   // safety net: a lecture never holds slots > 6h
const STALE_AFTER_MS   = 30_000;        // slot given but user never showed up in LiveKit
const RECONCILE_EVERY  = 15;            // seconds; at most one LiveKit lookup per lecture per window

const slotsKey     = (lectureId) => `stream:webrtc:${lectureId}`;
const reconcileKey = (lectureId) => `stream:reconcile:${lectureId}`;

// Returns 1 if the user holds a WebRTC slot after this call, 0 if the room is full.
const CLAIM_SLOT = `
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 1 end
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[2]) then
  redis.call('ZADD', KEYS[1], ARGV[3], ARGV[1])
  redis.call('EXPIRE', KEYS[1], ARGV[4])
  return 1
end
return 0
`;

let roomService;
function livekit() {
  if (!roomService) {
    roomService = new RoomServiceClient(
      process.env.LIVEKIT_URL,
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET
    );
  }
  return roomService;
}

async function claimSlot(lectureId, userId) {
  const result = await redis.eval(CLAIM_SLOT, {
    keys: [slotsKey(lectureId)],
    arguments: [String(userId), String(WEBRTC_PRIORITY_LIMIT), String(Date.now()), String(SLOT_TTL_SECONDS)],
  });
  return result === 1;
}

// Free slots whose owners closed the tab without calling /leave.
// Only runs when the room is full, and at most once per RECONCILE_EVERY seconds
// per lecture across all instances (SET NX acts as a cluster-wide throttle).
async function reconcile(lectureId) {
  const gotLock = await redis.set(reconcileKey(lectureId), '1', { NX: true, EX: RECONCILE_EVERY });
  if (!gotLock) return false;

  const cutoff = Date.now() - STALE_AFTER_MS;
  const candidates = await redis.zRangeByScore(slotsKey(lectureId), '-inf', cutoff);
  if (candidates.length === 0) return false;

  let connected;
  try {
    const participants = await livekit().listParticipants(lectureId);
    connected = new Set(participants.map((p) => p.identity));
  } catch {
    return false; // LiveKit unreachable: keep slots rather than over-allocate
  }

  const stale = candidates.filter((id) => !connected.has(id));
  if (stale.length > 0) await redis.zRem(slotsKey(lectureId), stale);
  return stale.length > 0;
}

// Decide which tier this viewer gets. Atomic across all instances.
export async function assignTier(lectureId, userId) {
  if (await claimSlot(lectureId, userId)) return 'webrtc';
  if (await reconcile(lectureId) && await claimSlot(lectureId, userId)) return 'webrtc';
  return 'hls';
}

export async function releaseSlot(lectureId, userId) {
  await redis.zRem(slotsKey(lectureId), String(userId));
}

export async function clearSlots(lectureId) {
  await redis.del([slotsKey(lectureId), reconcileKey(lectureId)]);
}

export async function slotsInUse(lectureId) {
  return redis.zCard(slotsKey(lectureId));
}
