// Q&A WebSocket Handler
// Observer Pattern: broadcasts ranked question updates to all clients in a lecture room.
//
// LOAD BALANCING DESIGN (Redis Pub/Sub):
//   When the Core API is scaled to N instances (docker compose up --scale core-api=N),
//   each instance manages its own in-memory WebSocket rooms. A question submitted to
//   Instance 1 would never reach students connected to Instance 2 without a shared bus.
//
//   Solution: every state-mutating action publishes to a Redis channel (qa:broadcast:<lectureId>).
//   Every instance subscribes to that channel and broadcasts to its *local* WebSocket clients.
//   This way, all N instances stay in sync with zero direct coupling between them.
//
// COALESCING (services/broadcaster.js): mutations don't publish directly.
//   One instance per lecture holds a short Redis lease and publishes at most
//   once per QA_BROADCAST_WINDOW_MS, re-publishing if more mutations arrived.

import { WebSocketServer } from 'ws';
import accessService from '../services/accessService.js';
import qaService from '../services/qaService.js';
import { createRedisClient } from '../config/redis.js';
import redis from '../config/redis.js';
import { createBroadcaster, channel as pubChannel } from '../services/broadcaster.js';

// lectureId -> Set of WebSocket clients (local to this instance only)
const rooms = new Map();

// Ranking strategy and the lecture-wide connection count live in Redis
// (see qaService), not here: this process only knows about its own sockets.

export const qaWss = new WebSocketServer({ noServer: true });

// Dedicated Redis subscriber connection.
// A subscribed Redis client cannot issue regular commands, so it must be separate
// from the shared client used by qaService for data reads/writes.
const subscriber = createRedisClient();

// Track which lecture channels this instance is already subscribed to,
// so we don't re-subscribe on every new client connection to the same lecture.
const subscribedChannels = new Set();

// Subscribe this instance to a lecture channel (idempotent).
async function ensureSubscribed(lectureId) {
  const channel = pubChannel(lectureId);
  if (subscribedChannels.has(channel)) return;

  await subscriber.subscribe(channel, (message) => {
    // Received a broadcast from any Core API instance (including ourselves).
    // Relay it to every local WebSocket client in this room.
    const room = rooms.get(lectureId);
    room?.forEach((client) => {
      if (client.readyState === 1) client.send(message);
    });
  });

  subscribedChannels.add(channel);
  console.log(`[WS] Subscribed to Redis channel: ${channel}`);
}

// Unsubscribe when the last local client leaves this lecture.
async function maybeUnsubscribe(lectureId) {
  const room = rooms.get(lectureId);
  if (room && room.size > 0) return; // other local clients still connected
  const channel = pubChannel(lectureId);
  if (!subscribedChannels.has(channel)) return;
  await subscriber.unsubscribe(channel);
  subscribedChannels.delete(channel);
  console.log(`[WS] Unsubscribed from Redis channel: ${channel}`);
}

// Build the update a client sees: ranked list + the lecture's sequence number.
// seq must be read BEFORE the data. Every mutation writes its data and only
// then bumps seq, so a payload tagged seq=N always includes mutations 1..N.
// The strategy is read from Redis, so whichever instance builds the payload
// ranks questions the way the instructor chose.
async function buildUpdate(lectureId, seq) {
  if (seq === undefined) seq = await qaService.getSeq(lectureId);
  const strategy = await qaService.getStrategy(lectureId);
  // Bounded: top K unanswered + latest answered + counts, not the whole list
  const { questions, answered, counts } = await qaService.getLiveView(lectureId, strategy);
  // "type" and "seq" first: clients read seq from the prefix without parsing
  return JSON.stringify({ type: 'QUESTIONS_UPDATE', seq, strategy, counts, questions, answered });
}

const broadcaster = createBroadcaster({
  redis,
  buildPayload: buildUpdate,
  windowMs: Number(process.env.QA_BROADCAST_WINDOW_MS || 250),
});

// For mutations that don't come over the socket (REST routes): bump seq and
// let the broadcaster publish, exactly like a WebSocket mutation.
export function notifyMutation(lectureId) {
  return broadcaster.onMutation(lectureId);
}

// Applies one client message. Returns true if Q&A state changed.
async function applyMessage(ws, lectureId, msg) {
  switch (msg.type) {
    case 'SUBMIT_QUESTION':
      await qaService.submitQuestion(lectureId, ws.user.id, msg.content);
      return true;

    case 'VOTE':
      await qaService.voteQuestion(msg.questionId, ws.user.id, lectureId);
      return true;

    // Instructor actions are limited to THIS lecture's instructor (isOwner comes
    // from the ticket); checking role alone let any instructor moderate any lecture.
    case 'MARK_ANSWERED':
      if (!ws.isOwner) throw new Error("Only this lecture's instructor can mark questions answered");
      await qaService.markAnswered(msg.questionId, lectureId);
      return true;

    case 'SET_STRATEGY': {
      if (!ws.isOwner) throw new Error("Only this lecture's instructor can change ranking strategy");
      const valid = ['default', 'votes', 'recency'];
      if (!valid.includes(msg.strategy)) throw new Error('Invalid strategy');
      // Stored in Redis so every instance ranks the same way from now on
      await qaService.setStrategy(lectureId, msg.strategy);
      return true;
    }

    default:
      return false;
  }
}

export function initQAWebSocket() {
  qaWss.on('connection', (ws, req) => {
    // Robust query string parsing unaffected by proxy route changes
    const queryString = req.url.split('?')[1] || '';
    const params = new URLSearchParams(queryString);
    const lectureId = params.get('lectureId');
    const ticket = params.get('ticket');

    // Listeners are attached synchronously, before any await. `ws` does not
    // buffer events, so a message sent right after the socket opens (or an
    // early close) used to be lost while the setup below was still running.
    // Handlers wait on `ready` instead.
    const ready = (async () => {
      // One-time ticket from POST /api/qa/ticket (see accessService). It was
      // issued only to this lecture's instructor or an enrolled student, and
      // GETDEL makes it single use. The JWT never appears in the URL.
      const claims = await accessService.redeemTicket(ticket);
      if (!claims || claims.lectureId !== lectureId) {
        ws.close(4001, 'Unauthorized');
        throw new Error('Unauthorized');
      }
      ws.user = claims.user;
      ws.isOwner = claims.isOwner;
      console.log(`[WS] User ${ws.user.id} (${ws.user.role}) connected to lecture ${lectureId}`);

      // Register this client in the local room map
      if (!rooms.has(lectureId)) rooms.set(lectureId, new Set());
      rooms.get(lectureId).add(ws);
      ws.lectureId = lectureId;
      ws.inRoom = true;

      // Count this client lecture-wide (all instances), then subscribe this
      // instance to the lecture's broadcast channel
      await qaService.clientJoined(lectureId);
      ws.counted = true;
      await ensureSubscribed(lectureId);

      // Push current state immediately so late joiners see existing questions.
      // The last published payload is one GET; building it costs two HGETALLs
      // and a sort per connection, which adds up in a reconnect storm. If a
      // newer broadcast is pending it arrives right after (we're subscribed).
      try {
        ws.send((await broadcaster.getSnapshot(lectureId)) ?? (await buildUpdate(lectureId)));
      } catch (err) {
        ws.send(JSON.stringify({ type: 'ERROR', message: err.message }));
      }
    })();
    // A refused ticket rejects `ready`; handle it now, not when 'close' fires,
    // or Node reports an unhandled rejection (fatal by default in Node 18).
    ready.catch(() => {});

    ws.on('message', async (raw) => {
      let msg = {};
      try {
        msg = JSON.parse(raw);
        try { await ready; } catch { return; }   // not admitted: ignore
        if (!(await applyMessage(ws, lectureId, msg))) return;

        // Data is written; bump the lecture's seq and let the broadcaster
        // publish (now, or at the end of the current window). The sender gets
        // seq in an ACK, so it can tell which broadcast first includes its change.
        const seq = await broadcaster.onMutation(lectureId);
        ws.send(JSON.stringify({ type: 'ACK', clientMsgId: msg.clientMsgId, seq }));
      } catch (err) {
        if (err.message !== 'Already voted') console.error('[Q&A WebSocket Message Error]:', err);
        ws.send(JSON.stringify({ type: 'ERROR', clientMsgId: msg.clientMsgId, message: err.message }));
      }
    });

    ws.on('close', async () => {
      // Undo only what the setup actually did. Waiting for it also makes sure
      // the INCR in `ready` lands before this DECR, or the count drifts.
      await ready.catch(() => {});

      if (ws.inRoom) {
        const room = rooms.get(lectureId);
        room?.delete(ws);
        // Last client on THIS instance: stop listening to the channel, nothing more.
        if (room?.size === 0) {
          rooms.delete(lectureId);
          await maybeUnsubscribe(lectureId);
        }
      }
      if (!ws.counted) return;

      // Last client on ANY instance: persist and clear the live buffer.
      // (Previously this ran when one instance's room emptied, wiping the
      // Redis buffer while students on other instances were still asking.)
      const remaining = await qaService.clientLeft(lectureId);
      if (remaining <= 0) {
        await qaService.finalFlushAndClean(lectureId);
      }
    });
  });

  // Flush all active lecture buffers to PostgreSQL every 5 seconds (NFR2 durability).
  // A short Redis lock makes sure only one instance flushes a lecture per tick.
  setInterval(async () => {
    for (const [lectureId] of rooms) {
      try {
        if (await qaService.tryAcquireFlushLock(lectureId)) {
          await qaService.flushToDB(lectureId);
        }
      } catch (err) {
        console.error(`[Q&A Flush] ${lectureId}:`, err.message);
      }
    }
  }, 5000);

  // If a lease holder crashed mid-window, its lease expires and any instance
  // with sockets in that lecture publishes the missed state. (An instance
  // with no sockets there has nobody to deliver to.)
  setInterval(async () => {
    for (const [lectureId] of rooms) {
      try {
        await broadcaster.sweep(lectureId);
      } catch (err) {
        console.error(`[Broadcast sweep] ${lectureId}:`, err.message);
      }
    }
  }, 1000);

  console.log('[WS] Q&A WebSocket initialized with Redis Pub/Sub broadcast');
}
