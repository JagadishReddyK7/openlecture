// Delivery after a Redis subscriber reconnect, through the gateway.
//
// Each round simulates a flapping connection between core-api and Redis: for
// FLAP_MS every Pub/Sub connection is killed as fast as possible (CLIENT KILL
// TYPE pubsub in a loop), and in the middle of it the instructor makes one
// change. Then the lecture goes quiet. Does an observing student end up with
// that change? Before the fix an instance whose subscriber was down missed the
// broadcast and nothing ever re-sent it.
//
// A single kill shows nothing: node-redis re-subscribes within a few ms,
// before the change gets through nginx and core-api to its publish. A missed
// message needs an outage longer than publish latency, hence the flapping.
//
//   node scripts/resync-check.js      (ROUNDS=40 FLAP_MS=400; Redis on :6379)
import WebSocket from 'ws';
import { createClient } from 'redis';

const BASE = process.env.BASE || 'http://localhost';
const WS_BASE = BASE.replace(/^http/, 'ws');
const ROUNDS = Number(process.env.ROUNDS || 40);
const FLAP_MS = Number(process.env.FLAP_MS || 400);
const stamp = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

async function user(role, n) {
  const email = `resync_${role}_${stamp}_${n}@test.com`;
  await api('POST', '/api/auth/register', { name: `Resync ${n}`, email, password: 'Resync123!', role });
  return (await api('POST', '/api/auth/login', { email, password: 'Resync123!' })).data.token;
}

async function socket(lectureId, token) {
  const t = await api('POST', '/api/qa/ticket', { lectureId }, token);
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}/qaws?lectureId=${lectureId}&ticket=${encodeURIComponent(t.data.ticket)}`);
    ws.lastSeq = -1;
    ws.acks = new Map();
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'QUESTIONS_UPDATE') ws.lastSeq = Math.max(ws.lastSeq, m.seq);
      if (m.type === 'ACK') ws.acks.set(m.clientMsgId, m.seq);
    });
    ws.on('error', () => {});
    ws.on('open', () => resolve(ws));
  });
}

async function main() {
  const inst = await user('instructor', 0);
  const lectureId = (await api('POST', '/api/lectures', { title: `Resync ${stamp}`, scheduled_at: new Date().toISOString() }, inst)).data.id;
  // Observers spread over the core-api instances by nginx
  const observers = [];
  for (let i = 0; i < 6; i++) {
    const t = await user('student', i);
    await api('POST', `/api/lectures/${lectureId}/enroll`, null, t);
    observers.push(await socket(lectureId, t));
  }
  const owner = await socket(lectureId, inst);
  const redis = createClient({ url: 'redis://localhost:6379' });
  await redis.connect();
  await sleep(500);

  let staleObservations = 0, roundsWithStale = 0;
  for (let r = 0; r < ROUNDS; r++) {
    await sleep(600);   // previous broadcast window over: the change below publishes immediately
    const end = Date.now() + FLAP_MS;
    const flap = (async () => {
      while (Date.now() < end) await redis.sendCommand(['CLIENT', 'KILL', 'TYPE', 'pubsub']);
    })();
    await sleep(FLAP_MS / 2);
    const id = `round${r}`;
    owner.send(JSON.stringify({ type: 'SET_STRATEGY', strategy: r % 2 ? 'recency' : 'votes', clientMsgId: id }));
    await flap;
    await sleep(1500);  // quiet: no further changes this round
    const seq = owner.acks.get(id);
    const stale = observers.filter((o) => o.lastSeq < seq).length;
    staleObservations += stale;
    if (stale) roundsWithStale++;
  }

  const total = ROUNDS * observers.length;
  console.log(`rounds ${ROUNDS}, observers ${observers.length}, flapping ${FLAP_MS} ms per round`);
  console.log(`stale after the lecture went quiet: ${staleObservations} of ${total} observations (${roundsWithStale} of ${ROUNDS} rounds)`);
  [...observers, owner].forEach((w) => w.close());
  await redis.quit();
  process.exit(staleObservations === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
