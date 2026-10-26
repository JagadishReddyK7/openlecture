// WebRTC slot cap under a join burst, through the gateway (stack running).
// N enrolled students all call /stream/join at the same moment; exactly
// WEBRTC_PRIORITY_LIMIT of them must get WebRTC, however many
// streaming-engine instances handle the burst.
//
//   node scripts/slot-check.js            (N=1000; set N=... to change)
const BASE = process.env.BASE || 'http://localhost';
const N = Number(process.env.N || 1000);
const stamp = Date.now();

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

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(fn)));
  return out;
}

const email = (i) => `slot_${stamp}_${i}@test.com`;
await api('POST', '/api/auth/register', { name: 'Slot Instructor', email: email('i'), password: 'Slot12345!', role: 'instructor' });
const inst = (await api('POST', '/api/auth/login', { email: email('i'), password: 'Slot12345!' })).data.token;
const lectureId = (await api('POST', '/api/lectures', { title: `Slot ${stamp}`, scheduled_at: new Date().toISOString() }, inst)).data.id;
await api('POST', `/api/stream/start/${lectureId}`, null, inst);

console.log(`registering and enrolling ${N} students...`);
const tokens = await inBatches([...Array(N).keys()], 50, async (i) => {
  await api('POST', '/api/auth/register', { name: `S${i}`, email: email(i), password: 'Slot12345!', role: 'student' });
  const t = (await api('POST', '/api/auth/login', { email: email(i), password: 'Slot12345!' })).data.token;
  await api('POST', `/api/lectures/${lectureId}/enroll`, null, t);
  return t;
});

console.log(`${N} simultaneous joins...`);
const t0 = Date.now();
const res = await Promise.all(tokens.map((t) => api('POST', `/api/stream/join/${lectureId}`, null, t)));
const ms = Date.now() - t0;
const count = (f) => res.filter(f).length;
const webrtc = count((r) => r.data?.viewerTier === 'webrtc');
const hls = count((r) => r.data?.viewerTier === 'hls');
const failed = count((r) => r.status !== 200);
const stats = (await api('GET', `/api/stream/stats/${lectureId}`, null, inst)).data;

console.log(`webrtc ${webrtc}  hls ${hls}  failed ${failed}  (burst took ${ms} ms)`);
console.log(`slots in Redis: ${stats.webrtcSlotsUsed} / limit ${stats.webrtcLimit}`);
const ok = webrtc === stats.webrtcLimit && stats.webrtcSlotsUsed === stats.webrtcLimit && failed === 0 && webrtc + hls === N;
await api('POST', `/api/stream/end/${lectureId}`, null, inst);
console.log(ok ? 'SLOTS OK' : 'SLOTS FAILED');
process.exit(ok ? 0 : 1);
