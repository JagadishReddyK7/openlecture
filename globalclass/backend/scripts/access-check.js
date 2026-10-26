// Access-control matrix through the nginx gateway (stack running):
// who may watch (/stream/join), who gets a Q&A ticket, which tickets the
// WebSocket accepts, and who may moderate.
//
//   node scripts/access-check.js      (from backend/; takes ~40 s: one ticket is left to expire)
import WebSocket from 'ws';

const BASE = process.env.BASE || 'http://localhost';
const WS_BASE = BASE.replace(/^http/, 'ws');
const stamp = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
}

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
  const email = `access_${role}_${stamp}_${n}@test.com`;
  await api('POST', '/api/auth/register', { name: `Access ${role} ${n}`, email, password: 'Access123!', role });
  return (await api('POST', '/api/auth/login', { email, password: 'Access123!' })).data.token;
}

async function lecture(owner) {
  const l = await api('POST', '/api/lectures', { title: `Access ${stamp}`, scheduled_at: new Date().toISOString() }, owner);
  await api('POST', `/api/stream/start/${l.data.id}`, null, owner);
  return l.data.id;
}

// Opens /qaws with a raw query string. -> { code } if the server closed it
// within 2 s, else { open: true, first } with the first message; then closes.
function tryWs(query) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}/qaws?${query}`);
    let first = null;
    const done = (r) => { clearTimeout(t); resolve(r); };
    const t = setTimeout(() => { ws.close(); done({ open: true, first }); }, 2000);
    ws.on('message', (raw) => { first ??= JSON.parse(raw); });
    ws.on('close', (code) => done(first ? { open: true, first, code } : { code }));
    ws.on('error', () => {});
  });
}

const ticketFor = async (lectureId, token) => (await api('POST', '/api/qa/ticket', { lectureId }, token));

async function main() {
  const [owner, otherInstr, enrolled, outsider] = [
    await user('instructor', 1), await user('instructor', 2), await user('student', 3), await user('student', 4)];
  const L = await lecture(owner);
  const L2 = await lecture(owner);
  await api('POST', `/api/lectures/${L}/enroll`, null, enrolled);

  console.log('-- /stream/join');
  for (const [who, token, expect] of [['enrolled student', enrolled, 200], ['lecture owner', owner, 200],
    ['not-enrolled student', outsider, 403], ['other instructor', otherInstr, 403]]) {
    const r = await api('POST', `/api/stream/join/${L}`, null, token);
    check(`join: ${who} -> ${expect}`, r.status === expect, `got ${r.status} ${r.data?.code ?? ''}`);
    if (r.status === 200) await api('POST', `/api/stream/leave/${L}`, null, token);
  }

  console.log('-- POST /api/qa/ticket');
  for (const [who, lec, token, expect] of [['enrolled student', L, enrolled, 200], ['lecture owner', L, owner, 200],
    ['not-enrolled student', L, outsider, 403], ['other instructor', L, otherInstr, 403],
    ['unknown lecture', '00000000-0000-4000-8000-000000000000', enrolled, 404],
    ['malformed lecture id', 'abc', enrolled, 404], ['no JWT', L, null, 401]]) {
    const r = await ticketFor(lec, token);
    check(`ticket: ${who} -> ${expect}`, r.status === expect, `got ${r.status}`);
  }

  console.log('-- /qaws');
  const t1 = (await ticketFor(L, enrolled)).data.ticket;
  const ok = await tryWs(`lectureId=${L}&ticket=${encodeURIComponent(t1)}`);
  check('valid ticket: connected and got the question list', ok.open && ok.first?.type === 'QUESTIONS_UPDATE');
  const reuse = await tryWs(`lectureId=${L}&ticket=${encodeURIComponent(t1)}`);
  check('same ticket used twice -> 4001', reuse.code === 4001, JSON.stringify(reuse));

  const t2 = (await ticketFor(L, enrolled)).data.ticket;
  const wrongLecture = await tryWs(`lectureId=${L2}&ticket=${encodeURIComponent(t2)}`);
  check('ticket for another lecture -> 4001', wrongLecture.code === 4001, JSON.stringify(wrongLecture));

  const noTicket = await tryWs(`lectureId=${L}`);
  check('no ticket -> 4001', noTicket.code === 4001, JSON.stringify(noTicket));
  const oldWay = await tryWs(`lectureId=${L}&token=${enrolled}`);
  check('JWT in the URL (old scheme) -> 4001', oldWay.code === 4001, JSON.stringify(oldWay));

  console.log('-- moderation');
  const tStudent = (await ticketFor(L, enrolled)).data.ticket;
  const tOwner = (await ticketFor(L, owner)).data.ticket;
  const ws = await new Promise((resolve) => {
    const s = new WebSocket(`${WS_BASE}/qaws?lectureId=${L}&ticket=${encodeURIComponent(tStudent)}`);
    s.msgs = [];
    s.on('message', (raw) => s.msgs.push(JSON.parse(raw)));
    s.on('open', () => resolve(s));
  });
  await sleep(300);
  ws.send(JSON.stringify({ type: 'SUBMIT_QUESTION', content: 'access check question' }));
  await sleep(600);
  const qid = ws.msgs.filter((m) => m.type === 'QUESTIONS_UPDATE').at(-1)?.questions[0]?.id;
  ws.send(JSON.stringify({ type: 'MARK_ANSWERED', questionId: qid }));
  ws.send(JSON.stringify({ type: 'SET_STRATEGY', strategy: 'recency' }));
  await sleep(500);
  const errs = ws.msgs.filter((m) => m.type === 'ERROR').map((m) => m.message);
  check('student cannot mark answered or change ranking over WS', errs.length === 2, errs.join(' | '));

  const studentPatch = await api('PATCH', `/api/lectures/${L}/questions/${qid}/answer`, null, enrolled);
  check('REST mark-answered: student -> 403', studentPatch.status === 403, `got ${studentPatch.status}`);
  const otherPatch = await api('PATCH', `/api/lectures/${L}/questions/${qid}/answer`, null, otherInstr);
  check('REST mark-answered: other instructor -> 403', otherPatch.status === 403, `got ${otherPatch.status}`);
  const outsiderGet = await api('GET', `/api/lectures/${L}/questions`, null, outsider);
  check('REST question list: not-enrolled student -> 403', outsiderGet.status === 403, `got ${outsiderGet.status}`);

  const ownerWs = await new Promise((resolve) => {
    const s = new WebSocket(`${WS_BASE}/qaws?lectureId=${L}&ticket=${encodeURIComponent(tOwner)}`);
    s.msgs = [];
    s.on('message', (raw) => s.msgs.push(JSON.parse(raw)));
    s.on('open', () => resolve(s));
  });
  await sleep(300);
  ownerWs.send(JSON.stringify({ type: 'MARK_ANSWERED', questionId: qid }));
  await sleep(800);
  const answered = ws.msgs.filter((m) => m.type === 'QUESTIONS_UPDATE').at(-1)?.answered?.some((q) => q.id === qid);
  check('owner marks answered over WS; student sees it', !!answered && !ownerWs.msgs.some((m) => m.type === 'ERROR'));
  ws.close(); ownerWs.close();

  console.log('-- enrollment takes effect at once (no cached "no")');
  const before = await ticketFor(L, outsider);
  await api('POST', `/api/lectures/${L}/enroll`, null, outsider);
  const after = await ticketFor(L, outsider);
  check('refused before enrolling, ticket right after', before.status === 403 && after.status === 200, `${before.status} -> ${after.status}`);

  console.log('-- expiry (waiting 31 s)');
  const t3 = (await ticketFor(L, enrolled)).data.ticket;
  await sleep(31_000);
  const expired = await tryWs(`lectureId=${L}&ticket=${encodeURIComponent(t3)}`);
  check('ticket older than 30 s -> 4001', expired.code === 4001, JSON.stringify(expired));

  await api('POST', `/api/stream/end/${L}`, null, owner);
  await api('POST', `/api/stream/end/${L2}`, null, owner);
  console.log(`\nlecture=${L}`);
  console.log(failures === 0 ? 'ACCESS OK' : `ACCESS FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
