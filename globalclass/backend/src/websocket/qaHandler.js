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

import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import qaService from '../services/qaService.js';
import { createRedisClient } from '../config/redis.js';
import redis from '../config/redis.js';

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

const pubChannel = (lectureId) => `qa:broadcast:${lectureId}`;

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

// Fetch the current ranked question list and publish it to the Redis channel.
// Every subscribed Core API instance will receive this and relay to its local clients.
// The strategy is read from Redis, so a vote landing on any instance ranks
// questions the way the instructor chose.
export async function broadcastQuestions(lectureId) {
  const strategy = await qaService.getStrategy(lectureId);
  const questions = await qaService.getRankedQuestions(lectureId, strategy);
  const payload = JSON.stringify({ type: 'QUESTIONS_UPDATE', questions, strategy });

  const count = await redis.publish(pubChannel(lectureId), payload);
  console.log(`[WS] Published QUESTIONS_UPDATE to channel ${pubChannel(lectureId)} (${count} subscribers)`);
}

export function initQAWebSocket() {
  qaWss.on('connection', async (ws, req) => {
    // Robust query string parsing unaffected by proxy route changes
    const queryString = req.url.split('?')[1] || '';
    const params = new URLSearchParams(queryString);
    const lectureId = params.get('lectureId');
    const token = params.get('token');

    console.log(`[WS] Incoming connection. req.url: ${req.url}`);
    console.log(`[WS] Parsed lectureId: '${lectureId}'`);

    try {
      ws.user = jwt.verify(token, process.env.JWT_SECRET);
      console.log(`[WS] User ${ws.user.id} (${ws.user.role}) connected to lecture ${lectureId}`);
    } catch (err) {
      console.log('[WS] Unauthorized connection rejected:', err.message);
      ws.close(4001, 'Unauthorized');
      return;
    }

    // Register this client in the local room map
    if (!rooms.has(lectureId)) rooms.set(lectureId, new Set());
    rooms.get(lectureId).add(ws);
    ws.lectureId = lectureId;
    console.log(`[WS] Room ${lectureId} now has ${rooms.get(lectureId).size} local clients`);

    // Count this client lecture-wide (all instances), then subscribe this
    // instance to the lecture's broadcast channel
    await qaService.clientJoined(lectureId);
    await ensureSubscribed(lectureId);

    // Push current state immediately so late joiners see existing questions
    try {
      const strategy = await qaService.getStrategy(lectureId);
      const questions = await qaService.getRankedQuestions(lectureId, strategy);
      ws.send(JSON.stringify({ type: 'QUESTIONS_UPDATE', questions, strategy }));
    } catch (err) {
      ws.send(JSON.stringify({ type: 'ERROR', message: err.message }));
    }

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw);
        console.log(`[WS] Received message from ${ws.user.role}:`, msg.type);

        if (msg.type === 'SUBMIT_QUESTION') {
          console.log(`[WS] Submitting question for lecture ${lectureId}`);
          await qaService.submitQuestion(lectureId, ws.user.id, msg.content);
          await broadcastQuestions(lectureId); // publishes to Redis → all instances
        }

        if (msg.type === 'VOTE') {
          await qaService.voteQuestion(msg.questionId, ws.user.id, lectureId);
          await broadcastQuestions(lectureId);
        }

        if (msg.type === 'MARK_ANSWERED') {
          if (ws.user.role !== 'instructor') {
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Only instructors can mark questions answered' }));
            return;
          }
          await qaService.markAnswered(msg.questionId, lectureId);
          await broadcastQuestions(lectureId);
        }

        if (msg.type === 'SET_STRATEGY') {
          if (ws.user.role !== 'instructor') {
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Only instructors can change ranking strategy' }));
            return;
          }
          const valid = ['default', 'votes', 'recency'];
          if (!valid.includes(msg.strategy)) {
            ws.send(JSON.stringify({ type: 'ERROR', message: 'Invalid strategy' }));
            return;
          }
          // Stored in Redis so every instance ranks the same way from now on
          await qaService.setStrategy(lectureId, msg.strategy);
          await broadcastQuestions(lectureId);
        }
      } catch (err) {
        console.error('[Q&A WebSocket Message Error]:', err);
        ws.send(JSON.stringify({ type: 'ERROR', message: err.message }));
      }
    });

    ws.on('close', async () => {
      const room = rooms.get(lectureId);
      room?.delete(ws);

      // Last client on THIS instance: stop listening to the channel, nothing more.
      if (room?.size === 0) {
        rooms.delete(lectureId);
        await maybeUnsubscribe(lectureId);
      }

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

  console.log('[WS] Q&A WebSocket initialized with Redis Pub/Sub broadcast');
}
