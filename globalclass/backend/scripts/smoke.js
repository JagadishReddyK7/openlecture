// End-to-end smoke test through the Nginx gateway (no browser, no video).
// Instructor creates + starts a lecture, two students enroll and join, one asks,
// the other votes; both sockets must see the update, and the rows must reach
// Postgres after the 5 s flush.
//
//   node scripts/smoke.js            (from globalclass/backend, stack running)
//   $env:BASE="http://localhost"; node scripts/smoke.js
import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://localhost';
const WS_BASE = BASE.replace(/^http/, 'ws');
const stamp = Date.now();

let failures = 0;
function check(label, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
}

async function api(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

async function user(role, n) {
  const email = `smoke_${role}_${stamp}_${n}@test.com`;
  await api('POST', '/api/auth/register',
    { name: `Smoke ${role} ${n}`, email, password: 'Smoke123!', role, institution: 'Smoke U' });
  const { data } = await api('POST', '/api/auth/login', { email, password: 'Smoke123!' });
  return data.token;
}

// Opens a Q&A socket (ticket first, see POST /api/qa/ticket) and records
// every QUESTIONS_UPDATE it receives.
async function openQA(lectureId, token) {
  const t = await api('POST', '/api/qa/ticket', { lectureId }, token);
  if (t.status !== 200) throw new Error(`ticket refused: ${t.status} ${JSON.stringify(t.data)}`);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/qaws?lectureId=${lectureId}&ticket=${encodeURIComponent(t.data.ticket)}`);
    ws.updates = [];
    ws.errors = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'QUESTIONS_UPDATE') ws.updates.push(msg);
      if (msg.type === 'ERROR') { ws.errors.push(msg.message); console.log('  ws error:', msg.message); }
    });
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// Resolves once some update satisfies pred, or null after timeoutMs.
function waitFor(ws, pred, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = ws.updates.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - t0 > timeoutMs) return resolve(null);
      setTimeout(tick, 20);
    };
    tick();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const instructor = await user('instructor', 0);
  const [s1, s2] = [await user('student', 1), await user('student', 2)];
  check('users registered and logged in', !!(instructor && s1 && s2));

  const lec = await api('POST', '/api/lectures',
    { title: `Smoke ${stamp}`, description: 'smoke', scheduled_at: new Date().toISOString() }, instructor);
  check('lecture created', lec.status === 201, `status=${lec.status}`);
  const lectureId = lec.data.id;

  const start = await api('POST', `/api/stream/start/${lectureId}`, null, instructor);
  check('stream started', start.status === 200 && !!start.data.livekitToken, `status=${start.status}`);

  for (const s of [s1, s2]) {
    const e = await api('POST', `/api/lectures/${lectureId}/enroll`, null, s);
    check('student enrolled', e.status === 200, `status=${e.status}`);
    const j = await api('POST', `/api/stream/join/${lectureId}`, null, s);
    check('student joined stream', j.status === 200 && !!j.data.viewerTier, `tier=${j.data?.viewerTier}`);
  }

  const [w1, w2, wi] = await Promise.all([openQA(lectureId, s1), openQA(lectureId, s2), openQA(lectureId, instructor)]);
  // Let the connection setup (Redis INCR + SUBSCRIBE) finish before mutating.
  await sleep(500);

  const content = `smoke question ${stamp}`;
  w1.send(JSON.stringify({ type: 'SUBMIT_QUESTION', content }));
  const hasQ = (u) => u.questions.some((q) => q.content === content);
  const [u1, u2, ui] = await Promise.all([waitFor(w1, hasQ), waitFor(w2, hasQ), waitFor(wi, hasQ)]);
  check('asker sees own question', !!u1);
  check('other student sees question', !!u2);
  check('instructor sees question', !!ui);

  const qid = (u2 || u1)?.questions.find((q) => q.content === content)?.id;
  w2.send(JSON.stringify({ type: 'VOTE', questionId: qid }));
  const voted = (u) => u.questions.some((q) => q.id === qid && q.vote_count === 1);
  const [v1, v2] = await Promise.all([waitFor(w1, voted), waitFor(w2, voted)]);
  check('vote visible to asker', !!v1);
  check('vote visible to voter', !!v2);

  // Duplicate vote must be rejected (HSETNX)
  w2.send(JSON.stringify({ type: 'VOTE', questionId: qid }));
  await sleep(500);
  const last = w1.updates.at(-1).questions.find((q) => q.id === qid);
  check('duplicate vote rejected', last.vote_count === 1, `vote_count=${last.vote_count}`);

  // A vote for a question that doesn't exist must be refused. It used to be
  // buffered anyway, and its dangling foreign key then failed every flush
  // of the lecture (checked below: the data must still reach Postgres).
  w2.send(JSON.stringify({ type: 'VOTE', questionId: '00000000-0000-4000-8000-000000000000' }));
  await sleep(500);
  check('vote on unknown question rejected', w2.errors.includes('Question not found'));

  // Instructor answers it: it leaves the ranked list for the answered list
  wi.send(JSON.stringify({ type: 'MARK_ANSWERED', questionId: qid }));
  const moved = (u) => u.answered?.some((q) => q.id === qid && q.is_answered) && !u.questions.some((q) => q.id === qid);
  check('answered question moves to the answered list', !!(await waitFor(w1, moved)));

  // Cross-instance fan-out: with 3 core-api replicas, 12 more sockets are
  // spread over all of them by nginx, so every one receiving the update
  // means the Redis Pub/Sub relay works between instances.
  const extra = [];
  for (let i = 0; i < 12; i++) extra.push(await openQA(lectureId, s1));
  await sleep(500);
  const content2 = `smoke fan-out ${stamp}`;
  w2.send(JSON.stringify({ type: 'SUBMIT_QUESTION', content: content2 }));
  const hasQ2 = (u) => u.questions.some((q) => q.content === content2);
  const got = await Promise.all(extra.map((w) => waitFor(w, hasQ2)));
  check('fan-out reaches all 12 extra sockets', got.every(Boolean), `${got.filter(Boolean).length}/12`);
  extra.forEach((w) => w.close());

  // Last socket closes -> final flush to Postgres, then the Redis buffer is
  // deleted. The REST read below therefore comes from Postgres, not Redis.
  [w1, w2, wi].forEach((w) => w.close());
  await sleep(2000);
  const rest = await api('GET', `/api/lectures/${lectureId}/questions`, null, s1);
  const persisted = rest.data.find((q) => q.id === qid);
  check('question persisted to Postgres with its vote and answered flag',
    !!persisted && persisted.vote_count === 1 && persisted.is_answered === true,
    persisted ? `votes=${persisted.vote_count} answered=${persisted.is_answered}` : 'missing');
  check('both questions persisted', rest.data.length === 2, `rows=${rest.data.length}`);

  const end = await api('POST', `/api/stream/end/${lectureId}`, null, instructor);
  check('stream ended by owner', end.status === 200, `status=${end.status}`);

  console.log(`\nlectureId=${lectureId} questionId=${qid}`);
  console.log(failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
