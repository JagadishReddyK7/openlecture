// Correctness check for services/broadcaster.js against a real Redis.
// Three broadcasters (three "instances", each with its own connection) share
// one lecture. Asserts:
//   1. every mutation is covered by a broadcast with seq >= its own seq,
//      within one window + slack (no dropped last update, no lease left idle)
//   2. seq is strictly increasing on the channel (one publisher at a time)
//   3. consecutive broadcasts are at least one window apart (the rate bound)
//   4. a crashed lease holder is replaced by the sweeper
//
//   node scripts/coalesce-check.js     (from backend/, compose Redis on :6379)
import { createClient } from 'redis';
import { createBroadcaster, channel, verKey, leaseKey, sentKey, snapKey } from '../src/services/broadcaster.js';

const WINDOW = 250;
const SLACK = 150;          // build + Redis round trips + timer jitter
const url = `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

let failures = 0;
function check(label, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
}

async function client() {
  const c = createClient({ url });
  await c.connect();
  return c;
}

// One scenario on a fresh lecture id. `drive(instances, record)` performs the
// mutations; record(seq) logs each one with its time.
async function scenario(name, drive, { sweep = true, wrap = (redis) => redis } = {}) {
  const lectureId = `coalesce-check-${name}-${Date.now()}`;
  const published = [];   // { seq, at }
  const sub = await client();
  await sub.subscribe(channel(lectureId), (msg) => published.push({ seq: JSON.parse(msg).seq, at: Date.now() }));

  const conns = await Promise.all([client(), client(), client()]);
  const instances = conns.map((redis, i) => createBroadcaster({
    redis: wrap(redis, i),
    windowMs: WINDOW,
    instanceId: `inst-${i}`,
    // simulate building the ranked list
    buildPayload: async (_id, seq) => { await sleep(rand(0, 15)); return JSON.stringify({ type: 'QUESTIONS_UPDATE', seq }); },
  }));
  const sweeper = sweep && setInterval(() => instances.forEach((b) => b.sweep(lectureId).catch(() => {})), 1000);

  const mutations = [];   // { seq, at }
  const t0 = Date.now();
  await drive(instances, lectureId, (seq) => mutations.push({ seq, at: Date.now() }));
  const driveMs = Date.now() - t0;
  await sleep(WINDOW * 4 + 3000);   // let the last window and any sweep finish

  if (sweeper) clearInterval(sweeper);
  await sub.quit();
  const r = conns[0];
  const finalVer = Number(await r.get(verKey(lectureId)));
  await r.del([verKey(lectureId), leaseKey(lectureId), sentKey(lectureId), snapKey(lectureId)]);
  await Promise.all(conns.map((c) => c.quit()));
  return { mutations, published, finalVer, driveMs };
}

function analyse(name, { mutations, published, finalVer, driveMs }, maxLatency) {
  const lastPub = published.at(-1)?.seq ?? 0;
  check(`${name}: last broadcast seq == final ver`, lastPub === finalVer, `last=${lastPub} ver=${finalVer}`);

  const increasing = published.every((p, i) => i === 0 || p.seq > published[i - 1].seq);
  check(`${name}: seq strictly increasing on the channel`, increasing);

  const gaps = published.slice(1).map((p, i) => p.at - published[i].at);
  const minGap = gaps.length ? Math.min(...gaps) : Infinity;
  check(`${name}: broadcasts >= one window apart`, minGap >= WINDOW - 10, `min gap ${minGap} ms`);

  // For each mutation, time until the first broadcast whose seq covers it
  let worst = 0;
  let j = 0;
  const sorted = [...mutations].sort((a, b) => a.seq - b.seq);
  const lat = [];
  for (const m of sorted) {
    while (j < published.length && published[j].seq < m.seq) j++;
    if (j === published.length) { worst = Infinity; break; }
    const l = published[j].at - m.at;
    lat.push(l);
    worst = Math.max(worst, l);
  }
  lat.sort((a, b) => a - b);
  const p50 = lat[Math.floor(lat.length / 2)];
  check(`${name}: every mutation covered within ${maxLatency} ms`, worst <= maxLatency, `worst ${worst} ms, p50 ${p50} ms`);
  console.log(`      ${mutations.length} mutations in ${(driveMs / 1000).toFixed(1)} s -> ${published.length} broadcasts`);
}

async function main() {
  // 1. Storm: 10,000 mutations from 3 instances, 30 concurrent writers each
  const storm = await scenario('storm', async (inst, id, record) => {
    let left = 10_000;
    const worker = async (b) => {
      while (left-- > 0) { record(await b.onMutation(id)); await sleep(rand(20, 100)); }
    };
    await Promise.all(inst.flatMap((b) => Array.from({ length: 30 }, () => worker(b))));
  });
  analyse('storm', storm, WINDOW + SLACK);

  // 2. Window boundary: single mutations spaced around one window, so the
  //    lease is often released and re-taken (where a lost update would hide)
  const edge = await scenario('edge', async (inst, id, record) => {
    for (let i = 0; i < 200; i++) {
      record(await inst[i % 3].onMutation(id));
      await sleep(rand(WINDOW - 40, WINDOW + 40));
    }
  });
  analyse('edge', edge, WINDOW + SLACK);

  // 3. Isolated mutation after quiet: published immediately (leading edge)
  const single = await scenario('single', async (inst, id, record) => { record(await inst[1].onMutation(id)); });
  const lat = single.published[0] ? single.published[0].at - single.mutations[0].at : Infinity;
  check('single: isolated mutation published without waiting a window', lat < 50, `${lat} ms`);

  // 4. Hand-off race, forced: instance 0's client pauses 100 ms after a
  //    release reply (lease already deleted in Redis, loop not yet exited).
  //    A mutation on the same instance in that gap takes the lease while the
  //    old loop is still "running". It must still be published promptly,
  //    not after the lease expires (~2 s) and a sweep picks it up.
  let released;
  const slowRelease = (redis, i) => (i !== 0 ? redis : new Proxy(redis, {
    get(target, key) {
      if (key !== 'eval') { const v = target[key]; return typeof v === 'function' ? v.bind(target) : v; }
      return async (script, opts) => {
        const r = await target.eval(script, opts);
        if (script.includes('PEXPIRE') && r === 0) { released?.(); await sleep(100); }
        return r;
      };
    },
  }));
  const handoff = await scenario('handoff', async (inst, id, record) => {
    const gap = new Promise((r) => { released = r; });
    record(await inst[0].onMutation(id));   // leading-edge publish, then window, then release
    await gap;                              // lease is free, loop is paused before exiting
    record(await inst[0].onMutation(id));
  }, { wrap: slowRelease });
  const second = handoff.published.find((p) => p.seq >= 2);
  const handoffLat = second ? second.at - handoff.mutations[1].at : Infinity;
  check('handoff: mutation during a loop exit is published promptly', handoffLat <= WINDOW + SLACK, `${handoffLat} ms`);

  // 5. Crashed lease holder: a "dead" instance takes the lease and never
  //    publishes. Sweepers run every 1 s; the lease expires after 2 s.
  const crash = await scenario('crash', async (inst, id, record) => {
    const r = await client();
    await r.set(leaseKey(id), 'dead-instance', { PX: 2000 });
    record(await inst[0].onMutation(id));       // can't get the lease
    record(await inst[2].onMutation(id));
    await r.quit();
  });
  const covered = crash.published.find((p) => p.seq >= 2);
  const crashLat = covered ? covered.at - crash.mutations[1].at : Infinity;
  check('crash: sweeper publishes after the dead lease expires', crashLat <= 3500, `${crashLat} ms (lease 2 s + sweep <= 1 s)`);

  console.log(failures === 0 ? '\nCOALESCE OK' : `\nCOALESCE FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
