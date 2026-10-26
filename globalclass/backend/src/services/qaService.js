// Q&A Service
// Write-behind buffer: writes go to Redis first; flushed to PostgreSQL every 5s
import pool from '../config/db.js';
import redis from '../config/redis.js';
import { rank, liveIndex } from './rankingStrategy.js';
import { v4 as uuidv4 } from 'uuid';
import { verKey, leaseKey, sentKey, snapKey } from './broadcaster.js';
import { flushDuration, flushRows } from '../metrics.js';

// Redis key helpers
const liveQKey  = (id) => `qa:live:q:${id}`;       // Hash: questionId → JSON
const liveVKey  = (id) => `qa:live:voted:${id}`;   // Hash: questionId:studentId → "1"
const liveVCKey = (id) => `qa:live:vc:${id}`;      // Hash: questionId → vote count
const connKey   = (id) => `qa:conn:${id}`;         // Hash: instanceId → sockets it holds
const stratKey  = (id) => `qa:strategy:${id}`;     // String: active ranking strategy
const flushLock = (id) => `qa:flushlock:${id}`;    // String: one flusher per tick
// Live ordering indexes (see rankingStrategy.js). Members are `${created_at}|${id}`.
const rankKey     = (index, id) => `qa:live:rank:${index}:${id}`; // ZSET: unanswered, per index
const answeredKey = (id) => `qa:live:answered:${id}`;             // ZSET: answered, score = answered ms
const INDEXES = ['votes', 'votesFifo', 'recent'];
const indexKeys = (id) => INDEXES.map((ix) => rankKey(ix, id));
const member = (q) => `${new Date(q.created_at).toISOString()}|${q.id}`;

// Write-behind bookkeeping: ids changed since the last flush, and the batch a
// flush is working on (kept until Postgres commits, so a crash mid-flush
// leaves it for the next flush instead of losing it)
const dirtyQKey    = (id) => `qa:dirty:q:${id}`;      // Set: question ids
const dirtyVKey    = (id) => `qa:dirty:v:${id}`;      // Set: questionId:studentId
const flushingQKey = (id) => `qa:flushing:q:${id}`;
const flushingVKey = (id) => `qa:flushing:v:${id}`;
const ACTIVE = 'qa:active';                           // Set: lectures with a live buffer
const ALIVE_PREFIX = 'qa:alive:';                     // + instanceId: heartbeat, EX ALIVE_TTL
const ALIVE_TTL = 15;                                 // s

// Payload bounds: clients get the top TOP_K unanswered questions and the
// ANSWERED_K most recently answered, plus counts, never the whole list.
const TOP_K = Number(process.env.QA_TOP_K || 50);
const ANSWERED_K = Number(process.env.QA_ANSWERED_K || 20);

// --- Cluster-wide room state ---
// With several core-api instances, each one only sees its own sockets. Anything
// that must be true for the whole lecture (who is connected, which ranking the
// instructor picked) lives in Redis instead of process memory.

//
// Presence is counted per instance (qa:conn:<lecture> = { instanceId: n })
// and each instance refreshes qa:alive:<instanceId> every few seconds. A plain
// lecture-wide INCR/DECR counter (as before) never comes back down when an
// instance is killed: its sockets never run their DECR, so the lecture never
// looks empty, the final flush never runs, and the last seconds of Q&A stay
// in Redis only. Here, an instance whose heartbeat has expired simply stops
// counting, and the sweeper (pruneDead) removes it.

// Lua helper: sockets held by instances that are still alive.
// (Reads qa:alive:* keys not passed in KEYS: fine on a single Redis node,
// would need hash tags on Redis Cluster.)
const LIVE_COUNT = `
local function live(conn, prefix)
  local t = redis.call('HGETALL', conn)
  local n = 0
  for i = 1, #t, 2 do
    if redis.call('EXISTS', prefix .. t[i]) == 1 then n = n + tonumber(t[i + 1]) end
  end
  return n
end
`;

export async function heartbeat(instanceId) {
  await redis.set(`${ALIVE_PREFIX}${instanceId}`, '1', { EX: ALIVE_TTL });
}

export async function clientJoined(lectureId, instanceId) {
  await redis.multi()
    .hIncrBy(connKey(lectureId), instanceId, 1)
    .sAdd(ACTIVE, lectureId)
    .exec();
}

// KEYS: conn. ARGV: instanceId, alive prefix. -> live sockets left in the lecture
const LEAVE = LIVE_COUNT + `
if redis.call('HINCRBY', KEYS[1], ARGV[1], -1) <= 0 then redis.call('HDEL', KEYS[1], ARGV[1]) end
return live(KEYS[1], ARGV[2])
`;

export async function clientLeft(lectureId, instanceId) {
  return redis.eval(LEAVE, { keys: [connKey(lectureId)], arguments: [instanceId, ALIVE_PREFIX] });
}

// Drop counts held by instances whose heartbeat expired (killed, crashed).
// KEYS: conn. ARGV: alive prefix. -> { live sockets, entries removed }
const PRUNE = LIVE_COUNT + `
local t = redis.call('HGETALL', KEYS[1])
local removed = 0
for i = 1, #t, 2 do
  if redis.call('EXISTS', ARGV[1] .. t[i]) == 0 or tonumber(t[i + 1]) <= 0 then
    redis.call('HDEL', KEYS[1], t[i])
    removed = removed + 1
  end
end
return {live(KEYS[1], ARGV[1]), removed}
`;

export async function pruneDead(lectureId) {
  const [live, removed] = await redis.eval(PRUNE, { keys: [connKey(lectureId)], arguments: [ALIVE_PREFIX] });
  return { live, removed };
}

// Every lecture with a live buffer, whichever instance its clients are on
export async function activeLectures() {
  return redis.sMembers(ACTIVE);
}

export async function getStrategy(lectureId) {
  return (await redis.get(stratKey(lectureId))) || 'default';
}

export async function setStrategy(lectureId, strategy) {
  await redis.set(stratKey(lectureId), strategy);
}

// Lecture-wide sequence number (bumped by broadcaster.onMutation after every
// mutation's data is written), so a payload that read seq=N first is
// guaranteed to contain mutations 1..N.
export async function getSeq(lectureId) {
  return Number((await redis.get(verKey(lectureId))) || 0);
}

// Returns true if this instance should run the flush for this tick.
// Without it every instance re-upserts the same rows every 5 seconds.
export async function tryAcquireFlushLock(lectureId) {
  const ok = await redis.set(flushLock(lectureId), '1', { NX: true, PX: 4000 });
  return ok === 'OK';
}

// --- Read ---

export async function getRankedQuestions(lectureId, strategy = 'default') {
  const [qHash, vcHash] = await Promise.all([
    redis.hGetAll(liveQKey(lectureId)),
    redis.hGetAll(liveVCKey(lectureId)),
  ]);

  // Live lecture: buffer has data — serve directly from Redis
  if (qHash && Object.keys(qHash).length > 0) {
    const questions = Object.values(qHash).map(j => {
      const q = JSON.parse(j);
      q.vote_count = Number.parseInt(vcHash?.[q.id] || '0');
      return q;
    });
    return rank(questions, strategy);
  }

  // Fallback: ended lecture or pre-lecture — read from PostgreSQL
  const result = await pool.query(
    `SELECT q.*, COUNT(v.id)::int AS vote_count
     FROM questions q
     LEFT JOIN votes v ON v.question_id = q.id
     WHERE q.lecture_id = $1
     GROUP BY q.id`,
    [lectureId]
  );
  return rank(result.rows, strategy);
}

// Bounded view of a live lecture for broadcasts: the top TOP_K unanswered
// questions in the strategy's order, the latest ANSWERED_K answered ones, and
// counts. One script, so the view is a consistent snapshot, and it reads K
// entries from a sorted set instead of HGETALL + sort over every question.
// KEYS: q, vc, rank index, answered. ARGV: K, answeredK, desc (1|0).
const TOP_K_VIEW = `
local total = redis.call('HLEN', KEYS[1])
if total == 0 then return {0} end
local k = tonumber(ARGV[1])
local top
if ARGV[3] == '1' then top = redis.call('ZREVRANGE', KEYS[3], 0, k - 1)
else top = redis.call('ZRANGE', KEYS[3], 0, k - 1) end
local ans = redis.call('ZREVRANGE', KEYS[4], 0, tonumber(ARGV[2]) - 1)
local function fetch(members)
  local out = {}
  for _, m in ipairs(members) do
    local id = string.match(m, '|(.+)$')
    out[#out + 1] = redis.call('HGET', KEYS[1], id) or ''
    out[#out + 1] = redis.call('HGET', KEYS[2], id) or '0'
  end
  return out
end
return {total, redis.call('ZCARD', KEYS[3]), redis.call('ZCARD', KEYS[4]), fetch(top), fetch(ans)}
`;

function parsePairs(flat) {
  const out = [];
  for (let i = 0; i < flat.length; i += 2) {
    if (!flat[i]) continue;
    const q = JSON.parse(flat[i]);
    q.vote_count = Number(flat[i + 1]);
    out.push(q);
  }
  return out;
}

export async function getLiveView(lectureId, strategy = 'default') {
  const { name, desc } = liveIndex(strategy);
  const r = await redis.eval(TOP_K_VIEW, {
    keys: [liveQKey(lectureId), liveVCKey(lectureId), rankKey(name, lectureId), answeredKey(lectureId)],
    arguments: [String(TOP_K), String(ANSWERED_K), desc ? '1' : '0'],
  });

  if (r[0] === 0) {
    // No live buffer (pre-lecture or ended): build the same view from Postgres
    const all = await getRankedQuestions(lectureId, strategy);
    const open = all.filter((q) => !q.is_answered);
    const done = rank(all.filter((q) => q.is_answered), 'recency');
    return {
      questions: open.slice(0, TOP_K),
      answered: done.slice(0, ANSWERED_K),
      counts: { total: all.length, unanswered: open.length, answered: done.length },
    };
  }
  return {
    questions: parsePairs(r[3]),
    answered: parsePairs(r[4]),
    counts: { total: r[0], unanswered: r[1], answered: r[2] },
  };
}

// --- Write (buffer to Redis) ---

// Seed Redis from PostgreSQL when the live buffer is empty (resumed session).
// Without this, the first new question after a session gap would start a
// fresh Redis buffer containing only that one question, causing the next broadcast
// to wipe all historical questions from every connected client.
async function seedFromDB(lectureId) {
  const [qResult, voteResult] = await Promise.all([
    pool.query(
      `SELECT q.*, COUNT(v.id)::int AS vote_count
       FROM questions q
       LEFT JOIN votes v ON v.question_id = q.id
       WHERE q.lecture_id = $1
       GROUP BY q.id`,
      [lectureId]
    ),
    pool.query(
      `SELECT v.question_id, v.student_id
       FROM votes v
       JOIN questions q ON q.id = v.question_id
       WHERE q.lecture_id = $1`,
      [lectureId]
    ),
  ]);

  if (qResult.rows.length === 0) return;

  const qEntries = {};
  const vcEntries = {};
  const [ixVotes, ixFifo, ixRecent] = indexKeys(lectureId);
  const tx = redis.multi();
  for (const q of qResult.rows) {
    const { vote_count, ...fields } = q;
    qEntries[q.id] = JSON.stringify({ ...fields, vote_count: 0 });
    if (vote_count > 0) vcEntries[q.id] = String(vote_count);
    const m = member(q);
    if (q.is_answered) {
      // answer time isn't stored in Postgres; creation time keeps them ordered
      tx.zAdd(answeredKey(lectureId), { score: new Date(q.created_at).getTime(), value: m });
    } else {
      tx.zAdd(ixVotes, { score: vote_count, value: m });
      tx.zAdd(ixFifo, { score: -vote_count, value: m });
      tx.zAdd(ixRecent, { score: 0, value: m });
    }
  }
  tx.hSet(liveQKey(lectureId), qEntries);
  if (Object.keys(vcEntries).length > 0) tx.hSet(liveVCKey(lectureId), vcEntries);
  await tx.exec();

  if (voteResult.rows.length > 0) {
    const votedEntries = {};
    for (const v of voteResult.rows) {
      votedEntries[`${v.question_id}:${v.student_id}`] = '1';
    }
    await redis.hSet(liveVKey(lectureId), votedEntries);
  }
}

export async function submitQuestion(lectureId, studentId, content) {
  // If the buffer is empty (e.g. first question after a session gap), restore
  // existing questions from PostgreSQL so the broadcast stays complete.
  const bufferSize = await redis.hLen(liveQKey(lectureId));
  if (bufferSize === 0) await seedFromDB(lectureId);

  const id = uuidv4();
  const question = {
    id,
    lecture_id: lectureId,
    student_id: studentId,
    content,
    is_answered: false,
    created_at: new Date().toISOString(),
    vote_count: 0,
  };
  // Question and its index entries land together (MULTI)
  const m = member(question);
  const [ixVotes, ixFifo, ixRecent] = indexKeys(lectureId);
  await redis.multi()
    .hSet(liveQKey(lectureId), id, JSON.stringify(question))
    .zAdd(ixVotes, { score: 0, value: m })
    .zAdd(ixFifo, { score: 0, value: m })
    .zAdd(ixRecent, { score: 0, value: m })
    .sAdd(dirtyQKey(lectureId), id)
    .exec();
  return question;
}

// One atomic step: the question must exist in the live buffer (a vote for an
// unknown id used to be buffered anyway, and its dangling foreign key then
// failed every later flush of the lecture), the voter must be new, and the
// count and both vote indexes move together.
// KEYS: q, voted, vc, rank:votes, rank:votesFifo, dirty votes. ARGV: questionId, studentId.
// -> new count, -1 unknown question, -2 already voted
const VOTE = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return -1 end
local field = ARGV[1] .. ':' .. ARGV[2]
if redis.call('HSETNX', KEYS[2], field, '1') == 0 then return -2 end
redis.call('SADD', KEYS[6], field)
local n = redis.call('HINCRBY', KEYS[3], ARGV[1], 1)
local q = cjson.decode(raw)
if not q.is_answered then
  local m = q.created_at .. '|' .. ARGV[1]
  redis.call('ZADD', KEYS[4], n, m)
  redis.call('ZADD', KEYS[5], -n, m)
end
return n
`;

export async function voteQuestion(questionId, studentId, lectureId) {
  const bufferSize = await redis.hLen(liveQKey(lectureId));
  if (bufferSize === 0) await seedFromDB(lectureId);

  const [ixVotes, ixFifo] = indexKeys(lectureId);
  const n = await redis.eval(VOTE, {
    keys: [liveQKey(lectureId), liveVKey(lectureId), liveVCKey(lectureId), ixVotes, ixFifo, dirtyVKey(lectureId)],
    arguments: [String(questionId), String(studentId)],
  });
  if (n === -1) throw new Error('Question not found');
  if (n === -2) throw new Error('Already voted');
  return { message: 'Vote recorded' };
}

// Flag answered and move the question from the ranking indexes to the
// answered set, atomically. KEYS: q, 3 rank indexes, answered, dirty questions.
// ARGV: questionId, now ms. -> 1 updated, 0 not in the live buffer
const MARK_ANSWERED = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 0 end
local q = cjson.decode(raw)
if q.is_answered then return 1 end
q.is_answered = true
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(q))
redis.call('SADD', KEYS[6], ARGV[1])
local m = q.created_at .. '|' .. ARGV[1]
for i = 2, 4 do redis.call('ZREM', KEYS[i], m) end
redis.call('ZADD', KEYS[5], ARGV[2], m)
return 1
`;

export async function markAnswered(questionId, lectureId) {
  // Update in Redis buffer if question is still live
  await redis.eval(MARK_ANSWERED, {
    keys: [liveQKey(lectureId), ...indexKeys(lectureId), answeredKey(lectureId), dirtyQKey(lectureId)],
    arguments: [String(questionId), String(Date.now())],
  });
  // Also update PostgreSQL in case it was already flushed
  await pool.query(
    `UPDATE questions SET is_answered = TRUE WHERE id = $1`,
    [questionId]
  );
  return { message: 'Marked as answered' };
}

// --- Flush ---
//
// Incremental: only questions and votes changed since the last flush (the
// dirty sets the mutation scripts fill), one multi-row statement per table.
// It used to re-upsert every question and vote of the lecture, row by row,
// every 5 seconds, so flush cost grew with the lecture rather than with the
// rate of change.

// Move the dirty ids into the "flushing" sets and return them. If a previous
// flush died before committing, its leftovers are still in "flushing" and are
// included again (upserts are idempotent).
// KEYS: dirtyQ, dirtyV, flushingQ, flushingV
const TAKE_DIRTY = `
redis.call('SUNIONSTORE', KEYS[3], KEYS[3], KEYS[1])
redis.call('SUNIONSTORE', KEYS[4], KEYS[4], KEYS[2])
redis.call('DEL', KEYS[1], KEYS[2])
return {redis.call('SMEMBERS', KEYS[3]), redis.call('SMEMBERS', KEYS[4])}
`;

// -> { questions, votes, ms }. Throws if Postgres rejects the batch, after
// putting the ids back so the next flush retries them.
export async function flushToDB(lectureId) {
  const t0 = Date.now();
  const [qids, voteFields] = await redis.eval(TAKE_DIRTY, {
    keys: [dirtyQKey(lectureId), dirtyVKey(lectureId), flushingQKey(lectureId), flushingVKey(lectureId)],
  });
  if (qids.length === 0 && voteFields.length === 0) return { questions: 0, votes: 0, ms: 0 };

  const questions = qids.length
    ? (await redis.hmGet(liveQKey(lectureId), qids)).filter(Boolean).map((j) => JSON.parse(j))
    : [];
  const votes = voteFields.map((f) => f.split(':'));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (questions.length) {
      // Questions first: votes reference them
      await client.query(
        `INSERT INTO questions (id, lecture_id, student_id, content, is_answered, created_at)
         SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::boolean[], $6::timestamp[])
         ON CONFLICT (id) DO UPDATE SET is_answered = EXCLUDED.is_answered`,
        [questions.map((q) => q.id), questions.map((q) => q.lecture_id), questions.map((q) => q.student_id),
         questions.map((q) => q.content), questions.map((q) => q.is_answered), questions.map((q) => q.created_at)]
      );
    }
    if (votes.length) {
      await client.query(
        `INSERT INTO votes (question_id, student_id)
         SELECT * FROM unnest($1::uuid[], $2::uuid[])
         ON CONFLICT (question_id, student_id) DO NOTHING`,
        [votes.map((v) => v[0]), votes.map((v) => v[1])]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    // Retry these next time. (Kept in memory too, in case another flusher
    // cleared the "flushing" sets meanwhile.)
    const tx = redis.multi();
    if (qids.length) tx.sAdd(dirtyQKey(lectureId), qids);
    if (voteFields.length) tx.sAdd(dirtyVKey(lectureId), voteFields);
    await tx.exec();
    throw new Error(`flush failed for lecture ${lectureId}: ${err.message}`);
  } finally {
    client.release();
  }
  await redis.del([flushingQKey(lectureId), flushingVKey(lectureId)]);

  const stats = { questions: questions.length, votes: votes.length, ms: Date.now() - t0 };
  console.log(`[Q&A Flush] ${lectureId}: ${stats.questions} questions, ${stats.votes} votes in ${stats.ms} ms`);
  flushDuration.observe(stats.ms / 1000);
  flushRows.inc({ table: 'questions' }, stats.questions);
  flushRows.inc({ table: 'votes' }, stats.votes);
  return stats;
}

// Delete the live buffer only if nobody is connected on a live instance and
// nothing changed since the flush. Check and delete are one Lua script, so a
// client that joins, or a mutation that lands, between the flush and the
// delete keeps the buffer alive (the next flush picks it up).
// KEYS: conn, active set, dirtyQ, dirtyV, then the keys to delete. ARGV: alive prefix, lectureId
const DELETE_IF_EMPTY = LIVE_COUNT + `
if live(KEYS[1], ARGV[1]) > 0 then return 0 end
if redis.call('EXISTS', KEYS[3]) == 1 or redis.call('EXISTS', KEYS[4]) == 1 then return 0 end
redis.call('DEL', KEYS[1], unpack(KEYS, 5))
redis.call('SREM', KEYS[2], ARGV[2])
return 1
`;

// Final flush: when the last client across all live instances leaves, or when
// the sweeper finds a lecture whose only clients were on a dead instance.
// If the flush fails the buffer is kept; the lecture stays in qa:active and
// the sweeper retries.
export async function finalFlushAndClean(lectureId) {
  await flushToDB(lectureId);
  return (await redis.eval(DELETE_IF_EMPTY, {
    keys: [connKey(lectureId), ACTIVE, dirtyQKey(lectureId), dirtyVKey(lectureId),
           liveQKey(lectureId), liveVKey(lectureId),
           liveVCKey(lectureId), stratKey(lectureId), verKey(lectureId),
           leaseKey(lectureId), sentKey(lectureId), snapKey(lectureId),
           ...indexKeys(lectureId), answeredKey(lectureId), flushingQKey(lectureId), flushingVKey(lectureId)],
    arguments: [ALIVE_PREFIX, lectureId],
  })) === 1;
}

// No-op kept for API compatibility — strategy change no longer needs cache invalidation
// since Redis buffer IS the live data source
export function invalidateCache() { /* no-op */ }

const qaService = {
  getRankedQuestions, getLiveView, submitQuestion, voteQuestion,
  markAnswered, flushToDB, finalFlushAndClean, invalidateCache,
  clientJoined, clientLeft, getStrategy, setStrategy, tryAcquireFlushLock,
  getSeq, heartbeat, pruneDead, activeLectures,
};
export default qaService;
