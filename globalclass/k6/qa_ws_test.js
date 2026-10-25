// =============================================================================
// GlobalClass — Q&A WebSocket load test
// =============================================================================
// CLIENTS students connect to /qaws for one lecture. A few ask questions, the
// rest upvote. Measured only inside the steady window (after everyone has
// connected):
//   qa_update_latency  send → first QUESTIONS_UPDATE whose seq ≥ the seq in
//                      the server's ACK for that mutation (exact, per mutation)
//   qa_msgs / qa_bytes messages and payload bytes received by clients
//   qa_ack_timeouts, qa_errors, qa_abnormal_close, qa_connect_errors
//
// Run through scripts/run-qa-load.ps1, or directly (PowerShell, globalclass/):
//   docker run --rm -i --network globalclass_default -v ${PWD}/k6:/k6 `
//     grafana/k6:1.3.0 run /k6/qa_ws_test.js --env CLIENTS=200
//
// Workload knobs (defaults in brackets):
//   CLIENTS [200]  RAMP s [30]  STEADY s [120]
//   ASK_FRACTION [0.05]  ASK_EVERY s [10-20]  VOTE_EVERY s [5-15]  QMAX [100]
// =============================================================================

import http from 'k6/http';
import exec from 'k6/execution';
import { WebSocket } from 'k6/experimental/websockets';
import { setTimeout, setInterval, clearInterval } from 'k6/timers';
import { Counter, Trend } from 'k6/metrics';

const BASE = 'http://api-gateway';
const WS_BASE = 'ws://api-gateway';

const CLIENTS = parseInt(__ENV.CLIENTS || '200', 10);
const RAMP = parseInt(__ENV.RAMP || '30', 10);
const SETTLE = 5;                       // s after the ramp before measuring
const STEADY = parseInt(__ENV.STEADY || '120', 10);
const DRAIN = 5;                        // s after steady to collect late updates
const ASK_FRACTION = parseFloat(__ENV.ASK_FRACTION || '0.05');
const ASK_MIN = 10, ASK_MAX = 20;       // s between questions per asker
const VOTE_MIN = 5, VOTE_MAX = 15;      // s between votes per voter
const QMAX = parseInt(__ENV.QMAX || '100', 10);
const PENDING_TIMEOUT_MS = 10000;
const UPDATE_PREFIX = '{"type":"QUESTIONS_UPDATE","seq":';
const SEQ_RE = /"seq":(\d+)/;

const updateLatency = new Trend('qa_update_latency', true);
const connectTime = new Trend('qa_connect_time', true);
const msgs = new Counter('qa_msgs');
const bytes = new Counter('qa_bytes');
const updateMsgs = new Counter('qa_update_msgs');
const mutationsSent = new Counter('qa_mutations_sent');
const ackTimeouts = new Counter('qa_ack_timeouts');
const errors = new Counter('qa_errors');
const alreadyVoted = new Counter('qa_already_voted');
const abnormalClose = new Counter('qa_abnormal_close');
const connectErrors = new Counter('qa_connect_errors');

export const options = {
  setupTimeout: '900s',
  scenarios: {
    qa: {
      executor: 'per-vu-iterations',
      vus: CLIENTS,
      iterations: 1,
      maxDuration: `${RAMP + SETTLE + STEADY + DRAIN + 120}s`,
    },
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const json = { headers: { 'Content-Type': 'application/json' } };
const auth = (t) => ({ headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` } });
const rand = (a, b) => a + Math.random() * (b - a);

export function setup() {
  const stamp = Date.now();
  const pass = 'LoadTest123!';

  const instEmail = `qa_inst_${stamp}@test.com`;
  http.post(`${BASE}/api/auth/register`, JSON.stringify(
    { name: 'QA Instructor', email: instEmail, password: pass, role: 'instructor', institution: 'Load U' }), json);
  const inst = http.post(`${BASE}/api/auth/login`, JSON.stringify({ email: instEmail, password: pass }), json).json().token;

  const lecture = http.post(`${BASE}/api/lectures`, JSON.stringify(
    { title: `QA load ${stamp}`, description: 'qa ws load test', scheduled_at: new Date().toISOString() }), auth(inst)).json();
  http.post(`${BASE}/api/stream/start/${lecture.id}`, null, auth(inst));

  // One account per client: votes are deduplicated per user, so clients must
  // not share identities.
  const tokens = [];
  const BATCH = 25;
  for (let b = 0; b < CLIENTS; b += BATCH) {
    const ids = [];
    for (let i = b; i < Math.min(b + BATCH, CLIENTS); i++) ids.push(i);
    const email = (i) => `qa_s_${stamp}_${i}@test.com`;
    http.batch(ids.map((i) => ['POST', `${BASE}/api/auth/register`, JSON.stringify(
      { name: `QA Student ${i}`, email: email(i), password: pass, role: 'student', institution: 'Load U' }), json]));
    const logins = http.batch(ids.map((i) => ['POST', `${BASE}/api/auth/login`,
      JSON.stringify({ email: email(i), password: pass }), json]));
    const batchTokens = logins.map((r) => r.json().token);
    // Enroll now so the same script keeps working once P3 enforces enrollment
    http.batch(batchTokens.map((t) => ['POST', `${BASE}/api/lectures/${lecture.id}/enroll`, null, auth(t)]));
    tokens.push(...batchTokens);
  }
  if (tokens.some((t) => !t)) throw new Error('some student logins failed');

  const base = Date.now() + 2000;
  const steadyStart = base + (RAMP + SETTLE) * 1000;
  const steadyEnd = steadyStart + STEADY * 1000;
  console.log(`LECTURE_ID ${lecture.id}`);
  console.log(`STEADY_WINDOW ${new Date(steadyStart).toISOString()} ${new Date(steadyEnd).toISOString()}`);
  console.log(`WORKLOAD clients=${CLIENTS} askers=${Math.round(CLIENTS * ASK_FRACTION)} ask_every=${ASK_MIN}-${ASK_MAX}s vote_every=${VOTE_MIN}-${VOTE_MAX}s qmax=${QMAX} steady=${STEADY}s`);
  return { lectureId: lecture.id, tokens, base, steadyStart, steadyEnd };
}

export default function (data) {
  const idx = exec.vu.idInTest - 1;
  const isAsker = idx < Math.round(CLIENTS * ASK_FRACTION);
  const connectAt = data.base + (RAMP * 1000 * idx) / CLIENTS;
  const closeAt = data.steadyEnd + DRAIN * 1000;
  const inSteady = (t) => t >= data.steadyStart && t < data.steadyEnd;

  setTimeout(() => run(data, idx, isAsker, closeAt, inSteady), Math.max(0, connectAt - Date.now()));
}

function run(data, idx, isAsker, closeAt, inSteady) {
  const t0 = Date.now();
  const ws = new WebSocket(`${WS_BASE}/qaws?lectureId=${data.lectureId}&token=${data.tokens[idx]}`);

  let questions = [];
  let latestRaw = null;        // newest QUESTIONS_UPDATE, parsed on demand
  let lastSeq = -1;            // older updates (snapshot vs broadcast race) are not applied
  const voted = new Set();
  const pending = new Map();   // clientMsgId -> { sentAt, type, seq }
  const recent = [];           // [{ seq, at }] of received updates, newest last
  let nextId = 0;
  let open = false;
  let closing = false;
  let timer = null;

  function resolve(id, p, at) {
    if (inSteady(p.sentAt)) updateLatency.add(at - p.sentAt, { type: p.type });
    pending.delete(id);
  }

  function send(type, body) {
    if (!open || closing) return;
    const id = `${idx}-${nextId++}`;
    const sentAt = Date.now();
    pending.set(id, { sentAt, type, seq: null });
    if (inSteady(sentAt)) mutationsSent.add(1, { type });
    ws.send(JSON.stringify({ ...body, type, clientMsgId: id }));
  }

  function act() {
    const now = Date.now();
    // expire mutations that never got ACK + matching update
    for (const [id, p] of pending) {
      if (now - p.sentAt > PENDING_TIMEOUT_MS) {
        if (inSteady(p.sentAt)) ackTimeouts.add(1, { type: p.type });
        pending.delete(id);
      }
    }
    if (now >= data.steadyEnd) return;
    if (latestRaw !== null) {
      questions = JSON.parse(latestRaw).questions;
      latestRaw = null;
    }

    if (isAsker) {
      if (questions.length < QMAX) {
        send('SUBMIT_QUESTION', { content: `load question ${idx}-${nextId} ${now}` });
      }
    } else {
      const candidates = questions.filter((q) => !voted.has(q.id));
      if (candidates.length > 0) {
        const q = candidates[Math.floor(Math.random() * candidates.length)];
        voted.add(q.id);
        send('VOTE', { questionId: q.id });
      }
    }
  }

  ws.onopen = () => {
    open = true;
    connectTime.add(Date.now() - t0);
    const [lo, hi] = isAsker ? [ASK_MIN, ASK_MAX] : [VOTE_MIN, VOTE_MAX];
    // Random phase so clients don't fire in lockstep, then a fixed mean rate
    setTimeout(() => {
      act();
      timer = setInterval(act, rand(lo, hi) * 1000);
    }, rand(0, hi) * 1000);
    setTimeout(() => { closing = true; if (timer) clearInterval(timer); ws.close(); }, Math.max(0, closeAt - Date.now()));
  };

  ws.onmessage = (e) => {
    const at = Date.now();
    if (inSteady(at)) {
      msgs.add(1);
      bytes.add(e.data.length);   // ASCII payloads: chars == bytes
    }

    // Updates are large and frequent. Parsing every one in every client made
    // k6 itself the bottleneck, so only seq is read here (the server puts it
    // right after "type"); the list is parsed lazily when a vote needs it.
    if (e.data.startsWith(UPDATE_PREFIX)) {
      const seq = Number(SEQ_RE.exec(e.data.slice(0, 64))[1]);
      if (inSteady(at)) updateMsgs.add(1);
      if (seq >= lastSeq) { lastSeq = seq; latestRaw = e.data; }
      recent.push({ seq, at });
      if (recent.length > 500) recent.shift();
      for (const [id, p] of pending) {
        if (p.seq !== null && seq >= p.seq) resolve(id, p, at);
      }
      return;
    }

    const msg = JSON.parse(e.data);
    if (msg.type === 'ACK') {
      const p = pending.get(msg.clientMsgId);
      if (!p) return;
      p.seq = msg.seq;
      // The broadcast can arrive before the ACK: look back for it
      const hit = recent.find((u) => u.at >= p.sentAt && u.seq >= p.seq);
      if (hit) resolve(msg.clientMsgId, p, hit.at);
    } else if (msg.type === 'ERROR') {
      if (msg.clientMsgId) pending.delete(msg.clientMsgId);
      if (msg.message === 'Already voted') alreadyVoted.add(1);
      else if (inSteady(at)) errors.add(1);
    }
  };

  ws.onerror = () => { if (!open) connectErrors.add(1); };
  ws.onclose = () => {
    if (timer) clearInterval(timer);
    if (!closing) abnormalClose.add(1);
  };
}
