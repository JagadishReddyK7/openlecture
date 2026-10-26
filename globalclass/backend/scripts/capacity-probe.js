// Measures the per-unit costs docs/capacity.md builds on, against the real
// Redis (run inside a core-api container so Postgres/Redis hosts resolve):
//   1. Redis commands per vote / per question (Lua inner commands included)
//      and client round trips per mutation
//   2. Redis memory of a live lecture as questions and votes grow
//
//   docker compose exec -T core-api node scripts/capacity-probe.js
// Uses a throwaway lecture id (not in Postgres) and deletes its keys after.
import crypto from 'crypto';

const { default: qa } = await import('../src/services/qaService.js');
const { default: redis } = await import('../src/config/redis.js');
const { default: pool } = await import('../src/config/db.js');
const { createBroadcaster } = await import('../src/services/broadcaster.js');

const lectureId = crypto.randomUUID();
const pattern = `*${lectureId}*`;
// Publishes nothing useful; only here so onMutation runs its real script
const broadcaster = createBroadcaster({ redis, buildPayload: async () => '{}', windowMs: 250 });

async function commands() {
  const info = await redis.info('stats');
  return Number(/total_commands_processed:(\d+)/.exec(info)[1]);
}

async function lectureBytes() {
  const keys = await redis.keys(pattern);
  let total = 0;
  for (const k of keys) total += Number(await redis.memoryUsage(k, { SAMPLES: 0 })) || 0;
  return { keys: keys.length, bytes: total };
}

// Counts commands Redis executed for `fn`, minus the INFO call used to read them
async function measure(n, fn) {
  const before = await commands();
  for (let i = 0; i < n; i++) await fn(i);
  return ((await commands()) - before - 1) / n;
}

const kb = (b) => (b / 1024).toFixed(1) + ' KB';
try {
  // Prime: the first submit seeds from Postgres (empty for this id)
  await qa.submitQuestion(lectureId, crypto.randomUUID(), 'warm-up');

  const qIds = [];
  const perQuestion = await measure(200, async (i) => {
    qIds.push((await qa.submitQuestion(lectureId, crypto.randomUUID(), `capacity question ${i} with typical length text`)).id);
    await broadcaster.onMutation(lectureId);
  });
  const perVote = await measure(2000, async () => {
    await qa.voteQuestion(qIds[Math.floor(Math.random() * qIds.length)], crypto.randomUUID(), lectureId);
    await broadcaster.onMutation(lectureId);
  });
  console.log(`Redis commands per question: ${perQuestion.toFixed(1)}  (client round trips: 3 = HLEN, MULTI/EXEC, mark-dirty EVAL)`);
  console.log(`Redis commands per vote:     ${perVote.toFixed(1)}  (client round trips: 3 = HLEN, vote EVAL, mark-dirty EVAL)`);

  // Memory: grow to 1000 questions / 20,000 votes, sampling along the way.
  // Dirty sets are emptied by every flush (5 s), so they are reported apart.
  await new Promise((r) => setTimeout(r, 500));
  const rows = [];
  const sample = async (label) => {
    const all = await lectureBytes();
    const dirty = (Number(await redis.memoryUsage(`qa:dirty:q:${lectureId}`, { SAMPLES: 0 })) || 0)
      + (Number(await redis.memoryUsage(`qa:dirty:v:${lectureId}`, { SAMPLES: 0 })) || 0);
    rows.push({ label, keys: all.keys, total: all.bytes, dirty });
  };
  let votes = 2000;
  for (const [targetQ, targetV] of [[200, 2000], [500, 10000], [1000, 20000]]) {
    while (qIds.length < targetQ) qIds.push((await qa.submitQuestion(lectureId, crypto.randomUUID(), `capacity question ${qIds.length} with typical length text`)).id);
    for (; votes < targetV; votes++) await qa.voteQuestion(qIds[Math.floor(Math.random() * qIds.length)], crypto.randomUUID(), lectureId);
    await sample(`${qIds.length + 1} questions, ${votes} votes`);
  }
  console.log('\nRedis memory of one live lecture (MEMORY USAGE, all its keys):');
  for (const r of rows) {
    console.log(`  ${r.label.padEnd(28)} ${String(r.keys).padStart(2)} keys  ${kb(r.total).padStart(9)}  (of which unflushed-change sets ${kb(r.dirty)})`);
  }
  const last = rows.at(-1);
  console.log(`
  steady state at ${last.label} (change sets excluded): ${kb(last.total - last.dirty)}`);
} finally {
  const keys = await redis.keys(pattern);
  if (keys.length) await redis.del(keys);
  await redis.quit();
  await pool.end();
  process.exit(0);
}
