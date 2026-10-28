// Input limits and per-account rate limits, through the gateway (stack running).
//
//   node scripts/abuse-check.js
import WebSocket from 'ws';
import { execSync } from 'child_process';

const BASE = process.env.BASE || 'http://localhost';
const WS_BASE = BASE.replace(/^http/, 'ws');
const stamp = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => execSync(cmd, { cwd: new URL('../..', import.meta.url), encoding: 'utf8' }).trim();

let failures = 0;
function check(label, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
}

async function api(method, path, body, token, raw) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

async function user(role, n) {
  const email = `abuse_${role}_${stamp}_${n}@test.com`;
  await api('POST', '/api/auth/register', { name: `Abuse ${n}`, email, password: 'Abuse123!', role });
  return { email, token: (await api('POST', '/api/auth/login', { email, password: 'Abuse123!' })).data.token };
}

async function socket(lectureId, token) {
  const t = await api('POST', '/api/qa/ticket', { lectureId }, token);
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}/qaws?lectureId=${lectureId}&ticket=${encodeURIComponent(t.data.ticket)}`);
    ws.msgs = [];
    ws.on('message', (m) => ws.msgs.push(JSON.parse(m)));
    ws.on('error', () => {});
    ws.on('open', () => resolve(ws));
  });
}
const errorsOf = (ws) => ws.msgs.filter((m) => m.type === 'ERROR').map((m) => m.message);

async function main() {
  const inst = await user('instructor', 0);
  const lectureId = (await api('POST', '/api/lectures', { title: `Abuse ${stamp}`, scheduled_at: new Date().toISOString() }, inst.token)).data.id;
  const s = await user('student', 1);
  await api('POST', `/api/lectures/${lectureId}/enroll`, null, s.token);
  const ws = await socket(lectureId, s.token);
  await sleep(300);

  console.log('-- input limits');
  ws.send(JSON.stringify({ type: 'SUBMIT_QUESTION', content: 'x'.repeat(1001) }));
  ws.send(JSON.stringify({ type: 'SUBMIT_QUESTION', content: '   ' }));
  ws.send(JSON.stringify({ type: 'SUBMIT_QUESTION', content: { not: 'a string' } }));
  ws.send(JSON.stringify({ type: 'VOTE', questionId: 'not-a-uuid' }));
  await sleep(500);
  const errs = errorsOf(ws);
  check('1,001-character question refused', errs.includes('A question must be 1-1000 characters'));
  check('blank and non-string questions refused', errs.filter((e) => e.startsWith('A question must')).length === 3, `${errs.length} errors`);
  check('malformed question id refused', errs.includes('Invalid question id'));
  ws.send(JSON.stringify({ type: 'SUBMIT_QUESTION', content: 'y'.repeat(1000) }));
  await sleep(500);
  check('exactly 1,000 characters accepted', ws.msgs.some((m) => m.type === 'ACK'));

  const rest = await api('POST', `/api/lectures/${lectureId}/questions`, { content: 'z'.repeat(5000) }, s.token);
  check('REST: oversized question -> 400', rest.status === 400, `got ${rest.status}`);
  const body = await api('POST', `/api/lectures/${lectureId}/questions`, null, s.token, JSON.stringify({ content: 'a'.repeat(20_000) }));
  check('REST: 20 KB request body -> 413', body.status === 413, `got ${body.status}`);

  // The server must survive it, not just close the socket: before the fix an
  // unhandled socket 'error' event exited the whole core-api process.
  const running = () => sh('docker compose ps -q --status running core-api').split('\n').filter(Boolean).length;
  const before = running();
  const big = await socket(lectureId, s.token);
  const closed = new Promise((r) => big.on('close', (code) => r(code)));
  big.send('x'.repeat(20 * 1024));
  check('20 KB WebSocket frame closes the socket with 1009', (await closed) === 1009);
  await sleep(1500);
  const after = running();
  check('...and every core-api instance is still running', after === before, `${before} -> ${after}`);

  console.log('-- rate limits (per account)');
  // 1 question already counted (the 1,000-char one); refused input is rejected before counting
  for (let i = 0; i < 12; i++) ws.send(JSON.stringify({ type: 'SUBMIT_QUESTION', content: `rate ${i}`, clientMsgId: `r${i}` }));
  await sleep(800);
  const acked = ws.msgs.filter((m) => m.type === 'ACK' && String(m.clientMsgId).startsWith('r')).length;
  const limited = errorsOf(ws).filter((e) => e.startsWith('Too many question')).length;
  check('questions: 10 per minute, the rest refused', acked === 9 && limited === 3, `acked ${acked} (+1 earlier), limited ${limited}`);

  const other = await user('student', 2);
  await api('POST', `/api/lectures/${lectureId}/enroll`, null, other.token);
  const ws2 = await socket(lectureId, other.token);
  await sleep(300);
  ws2.send(JSON.stringify({ type: 'SUBMIT_QUESTION', content: 'another student is not limited' }));
  await sleep(400);
  check('the limit is per account (another student can still ask)', ws2.msgs.some((m) => m.type === 'ACK'));

  for (let i = 0; i < 11; i++) await api('POST', '/api/auth/login', { email: s.email, password: 'wrong' });
  const locked = await api('POST', '/api/auth/login', { email: s.email, password: 'Abuse123!' });
  check('login: locked after 10 failures, even with the right password', locked.status === 429, `got ${locked.status}`);
  const otherLogin = await api('POST', '/api/auth/login', { email: other.email, password: 'Abuse123!' });
  check('login lockout is per account', otherLogin.status === 200, `got ${otherLogin.status}`);

  [ws, ws2].forEach((w) => w.close());
  console.log(failures === 0 ? '\nABUSE OK' : `\nABUSE FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
