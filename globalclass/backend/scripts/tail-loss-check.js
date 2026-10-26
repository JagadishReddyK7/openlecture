// Last-seconds durability after an instance crash, through the gateway.
//
// 30 students connect to one lecture (spread over the core-api instances),
// then one instance is killed. The survivors ask and vote, wait for every
// ACK, and all disconnect at once, i.e. less than one flush interval after
// their last change. Then: are all ACKed changes in Postgres?
//
// With the old lecture-wide INCR/DECR counter the killed instance's sockets
// never decremented, so the lecture never looked empty, the final flush never
// ran, and with no sockets left nobody ran the periodic flush either.
//
//   node scripts/tail-loss-check.js      (stack running with 3 core-api;
//                                         kills one; bring it back afterwards)
import WebSocket from 'ws';
import { execSync } from 'child_process';

const BASE = process.env.BASE || 'http://localhost';
const WS_BASE = BASE.replace(/^http/, 'ws');
const SETTLE_S = Number(process.env.SETTLE_S || 30);   // heartbeat TTL 15 s + one 5 s sweep + margin
const stamp = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => execSync(cmd, { cwd: new URL('../..', import.meta.url), encoding: 'utf8' }).trim();

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
  const email = `tail_${role}_${stamp}_${n}@test.com`;
  await api('POST', '/api/auth/register', { name: `Tail ${n}`, email, password: 'Tail12345!', role });
  return (await api('POST', '/api/auth/login', { email, password: 'Tail12345!' })).data.token;
}

function client(lectureId, token) {
  return api('POST', '/api/qa/ticket', { lectureId }, token).then((t) => new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}/qaws?lectureId=${lectureId}&ticket=${encodeURIComponent(t.data.ticket)}`);
    ws.acks = new Set();
    ws.latest = null;
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'ACK') ws.acks.add(m.clientMsgId);
      if (m.type === 'QUESTIONS_UPDATE') ws.latest = m;
    });
    ws.on('error', () => {});
    ws.on('open', () => resolve(ws));
  }));
}

async function main() {
  const instructor = await user('instructor', 0);
  const lec = await api('POST', '/api/lectures', { title: `Tail ${stamp}`, scheduled_at: new Date().toISOString() }, instructor);
  const lectureId = lec.data.id;
  const tokens = [];
  for (let i = 0; i < 30; i++) {
    const t = await user('student', i);
    await api('POST', `/api/lectures/${lectureId}/enroll`, null, t);
    tokens.push(t);
  }
  const socks = [];
  for (const t of tokens) socks.push(await client(lectureId, t));
  await sleep(1000);

  const victim = sh('docker compose ps -q core-api').split('\n')[0];
  sh(`docker kill ${victim}`);
  await sleep(1500);
  const alive = socks.filter((s) => s.readyState === WebSocket.OPEN);
  console.log(`killed ${victim.slice(0, 12)}: ${socks.length - alive.length} sockets dropped, ${alive.length} still connected`);

  // Survivors: 5 questions, then every survivor votes on each of them
  const want = new Set();
  let n = 0;
  const send = (ws, msg) => { const id = `m${n++}`; want.add(`${socks.indexOf(ws)}:${id}`); ws.send(JSON.stringify({ ...msg, clientMsgId: id })); return id; };
  for (let i = 0; i < 5; i++) send(alive[i], { type: 'SUBMIT_QUESTION', content: `tail question ${i} ${stamp}` });
  await sleep(1000);
  const qids = alive[0].latest.questions.map((q) => q.id);
  for (const ws of alive) for (const q of qids) send(ws, { type: 'VOTE', questionId: q });
  await sleep(1500);
  const acked = alive.reduce((a, ws) => a + ws.acks.size, 0);
  const ackedQ = 5, ackedV = acked - ackedQ;
  console.log(`acked: ${ackedQ} questions, ${ackedV} votes (sent ${n})`);

  alive.forEach((ws) => ws.close());   // everyone leaves < 5 s after the last change
  console.log(`all disconnected; waiting ${SETTLE_S} s for the dead instance to expire and the sweeper to flush...`);
  await sleep(SETTLE_S * 1000);

  const pg = (sql) => sh(`docker compose exec -T postgres psql -U postgres -d globalclass -tAc "${sql}"`);
  const storedQ = Number(pg(`SELECT count(*) FROM questions WHERE lecture_id = '${lectureId}'`));
  const storedV = Number(pg(`SELECT count(*) FROM votes v JOIN questions q ON q.id = v.question_id WHERE q.lecture_id = '${lectureId}'`));
  const left = sh(`docker compose exec -T redis redis-cli --scan --pattern "qa:*${lectureId}"`).split('\n').filter(Boolean).length;

  const ok = storedQ === ackedQ && storedV === ackedV;
  console.log(`Postgres: ${storedQ}/${ackedQ} questions, ${storedV}/${ackedV} votes  -> ${ok ? 'NO LOSS' : 'LOST ' + (ackedQ - storedQ) + ' questions, ' + (ackedV - storedV) + ' votes'}`);
  console.log(`Redis keys left for the lecture: ${left}`);
  console.log(`lecture=${lectureId}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
