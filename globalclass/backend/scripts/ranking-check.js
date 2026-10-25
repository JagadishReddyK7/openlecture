// Checks the live ranking indexes (qaService + rankingStrategy) against a real
// Redis: for every strategy, the bounded top-K view read from the sorted sets
// must equal sorting the full question list in memory with the strategy's
// compare function. Also checks the atomic vote/answer edge cases.
//
//   node scripts/ranking-check.js     (from backend/, compose Redis on :6379
//                                      and Postgres on :5432)
import crypto from 'crypto';

process.env.DB_HOST ||= 'localhost';
process.env.DB_PORT ||= '5432';
process.env.DB_NAME ||= 'globalclass';
process.env.DB_USER ||= 'postgres';
process.env.DB_PASSWORD ||= 'postgres';

const { default: qa } = await import('../src/services/qaService.js');
const { default: redis } = await import('../src/config/redis.js');
const { default: pool } = await import('../src/config/db.js');

const TOP_K = 50;
const ANSWERED_K = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pickOne = (a) => a[Math.floor(Math.random() * a.length)];

let failures = 0;
function check(label, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) failures++;
}

async function errorOf(p) {
  try { await p; return null; } catch (err) { return err.message; }
}

const lectureId = crypto.randomUUID();   // not in Postgres: seeding finds nothing
const students = Array.from({ length: 400 }, () => crypto.randomUUID());

try {
  // 300 questions; the tight loop puts several in the same millisecond, so
  // equal created_at values exercise the id tie-break too
  const ids = [];
  for (let i = 0; i < 300; i++) {
    ids.push((await qa.submitQuestion(lectureId, pickOne(students), `q${i}`)).id);
  }

  // 3000 random votes, skewed so many questions share a vote count
  let accepted = 0, dupes = 0;
  for (let i = 0; i < 3000; i++) {
    const qid = ids[Math.floor(Math.random() ** 2 * ids.length)];
    const err = await errorOf(qa.voteQuestion(qid, pickOne(students), lectureId));
    if (err === null) accepted++;
    else if (err === 'Already voted') dupes++;
    else throw new Error(err);
  }

  // Answer 40, a few ms apart so answer order is unambiguous
  const answered = [];
  for (const qid of ids.slice(0, 120).filter((_, i) => i % 3 === 0)) {
    await qa.markAnswered(qid, lectureId);
    answered.push(qid);
    await sleep(3);
  }
  // Votes on answered questions still count (not re-ranked: they're off the board)
  const errAnswered = await errorOf(qa.voteQuestion(answered[0], crypto.randomUUID(), lectureId));
  check('vote on an answered question is accepted', errAnswered === null, errAnswered ?? '');

  const errUnknown = await errorOf(qa.voteQuestion(crypto.randomUUID(), students[0], lectureId));
  check('vote on an unknown question is rejected', errUnknown === 'Question not found', String(errUnknown));
  const vc = await redis.hLen(`qa:live:vc:${lectureId}`);
  check('rejected vote left no vote-count entry', vc <= ids.length, `vc entries=${vc}`);

  const someVoted = await (async () => {
    const qid = ids[200], s = crypto.randomUUID();
    await qa.voteQuestion(qid, s, lectureId);
    return errorOf(qa.voteQuestion(qid, s, lectureId));
  })();
  check('second vote by the same student is rejected', someVoted === 'Already voted');
  console.log(`      ${accepted} votes accepted, ${dupes} duplicates rejected`);

  for (const strategy of ['default', 'votes', 'recency']) {
    const full = await qa.getRankedQuestions(lectureId, strategy);   // HGETALL + in-memory sort
    const expected = full.filter((q) => !q.is_answered).slice(0, TOP_K);
    const view = await qa.getLiveView(lectureId, strategy);
    const same = view.questions.length === expected.length &&
      view.questions.every((q, i) => q.id === expected[i].id && q.vote_count === expected[i].vote_count);
    const firstDiff = view.questions.findIndex((q, i) => q.id !== expected[i]?.id);
    check(`${strategy}: top ${TOP_K} from the index == full sort`, same, same ? '' : `first difference at #${firstDiff}`);
    check(`${strategy}: counts`, view.counts.total === 300 && view.counts.answered === 40 && view.counts.unanswered === 260,
      JSON.stringify(view.counts));
  }

  // votes and default must differ only in how ties break
  const d = (await qa.getLiveView(lectureId, 'default')).questions;
  const v = (await qa.getLiveView(lectureId, 'votes')).questions;
  check('default and votes agree on vote counts position by position', d.every((q, i) => q.vote_count === v[i].vote_count));

  const view = await qa.getLiveView(lectureId);
  const expectAnswered = [...answered].reverse().slice(0, ANSWERED_K);
  check(`answered: latest ${ANSWERED_K}, newest first`,
    view.answered.map((q) => q.id).join() === expectAnswered.join() && view.answered.every((q) => q.is_answered));

  const bytes = JSON.stringify({ type: 'QUESTIONS_UPDATE', seq: 1, strategy: 'default', ...view }).length;
  const fullBytes = JSON.stringify({ type: 'QUESTIONS_UPDATE', seq: 1, questions: await qa.getRankedQuestions(lectureId), strategy: 'default' }).length;
  console.log(`      payload with 300 questions: bounded ${bytes} B vs full list ${fullBytes} B`);
} finally {
  const keys = await redis.keys(`*${lectureId}*`);
  if (keys.length) await redis.del(keys);
  await redis.quit();
  await pool.end();
}

console.log(failures === 0 ? '\nRANKING OK' : `\nRANKING FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
