// Q&A Service
// Write-behind buffer: writes go to Redis first; flushed to PostgreSQL every 5s
import pool from '../config/db.js';
import redis from '../config/redis.js';
import { rank, liveIndex } from './rankingStrategy.js';
import { v4 as uuidv4 } from 'uuid';
import { verKey, leaseKey, sentKey, snapKey } from './broadcaster.js';

// Redis key helpers
const liveQKey  = (id) => `qa:live:q:${id}`;       // Hash: questionId → JSON
const liveVKey  = (id) => `qa:live:voted:${id}`;   // Hash: questionId:studentId → "1"
const liveVCKey = (id) => `qa:live:vc:${id}`;      // Hash: questionId → vote count
const connKey   = (id) => `qa:conn:${id}`;         // String: WS clients across ALL instances
const stratKey  = (id) => `qa:strategy:${id}`;     // String: active ranking strategy
const flushLock = (id) => `qa:flushlock:${id}`;    // String: one flusher per tick
// Live ordering indexes (see rankingStrategy.js). Members are `${created_at}|${id}`.
const rankKey     = (index, id) => `qa:live:rank:${index}:${id}`; // ZSET: unanswered, per index
const answeredKey = (id) => `qa:live:answered:${id}`;             // ZSET: answered, score = answered ms
const INDEXES = ['votes', 'votesFifo', 'recent'];
const indexKeys = (id) => INDEXES.map((ix) => rankKey(ix, id));
const member = (q) => `${new Date(q.created_at).toISOString()}|${q.id}`;

// Payload bounds: clients get the top TOP_K unanswered questions and the
// ANSWERED_K most recently answered, plus counts, never the whole list.
const TOP_K = Number(process.env.QA_TOP_K || 50);
const ANSWERED_K = Number(process.env.QA_ANSWERED_K || 20);

// --- Cluster-wide room state ---
// With several core-api instances, each one only sees its own sockets. Anything
// that must be true for the whole lecture (who is connected, which ranking the
// instructor picked) lives in Redis instead of process memory.

export async function clientJoined(lectureId) {
  return redis.incr(connKey(lectureId));
}

export async function clientLeft(lectureId) {
  return redis.decr(connKey(lectureId));
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
    .exec();
  return question;
}

// One atomic step: the question must exist in the live buffer (a vote for an
// unknown id used to be buffered anyway, and its dangling foreign key then
// failed every later flush of the lecture), the voter must be new, and the
// count and both vote indexes move together.
// KEYS: q, voted, vc, rank:votes, rank:votesFifo. ARGV: questionId, studentId.
// -> new count, -1 unknown question, -2 already voted
const VOTE = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return -1 end
if redis.call('HSETNX', KEYS[2], ARGV[1] .. ':' .. ARGV[2], '1') == 0 then return -2 end
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
    keys: [liveQKey(lectureId), liveVKey(lectureId), liveVCKey(lectureId), ixVotes, ixFifo],
    arguments: [String(questionId), String(studentId)],
  });
  if (n === -1) throw new Error('Question not found');
  if (n === -2) throw new Error('Already voted');
  return { message: 'Vote recorded' };
}

// Flag answered and move the question from the ranking indexes to the
// answered set, atomically. KEYS: q, 3 rank indexes, answered.
// ARGV: questionId, now ms. -> 1 updated, 0 not in the live buffer
const MARK_ANSWERED = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 0 end
local q = cjson.decode(raw)
if q.is_answered then return 1 end
q.is_answered = true
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(q))
local m = q.created_at .. '|' .. ARGV[1]
for i = 2, 4 do redis.call('ZREM', KEYS[i], m) end
redis.call('ZADD', KEYS[5], ARGV[2], m)
return 1
`;

export async function markAnswered(questionId, lectureId) {
  // Update in Redis buffer if question is still live
  await redis.eval(MARK_ANSWERED, {
    keys: [liveQKey(lectureId), ...indexKeys(lectureId), answeredKey(lectureId)],
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

// Periodic flush: upsert buffered data into PostgreSQL without clearing Redis
export async function flushToDB(lectureId) {
  const [qHash, votedHash] = await Promise.all([
    redis.hGetAll(liveQKey(lectureId)),
    redis.hGetAll(liveVKey(lectureId)),
  ]);

  if (!qHash || Object.keys(qHash).length === 0) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const json of Object.values(qHash)) {
      const q = JSON.parse(json);
      await client.query(
        `INSERT INTO questions (id, lecture_id, student_id, content, is_answered, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET is_answered = EXCLUDED.is_answered`,
        [q.id, q.lecture_id, q.student_id, q.content, q.is_answered, q.created_at]
      );
    }

    if (votedHash) {
      for (const field of Object.keys(votedHash)) {
        const [questionId, studentId] = field.split(':');
        await client.query(
          `INSERT INTO votes (question_id, student_id)
           VALUES ($1, $2)
           ON CONFLICT (question_id, student_id) DO NOTHING`,
          [questionId, studentId]
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[Q&A Flush] Failed for lecture ${lectureId}:`, err.message);
  } finally {
    client.release();
  }
}

// Delete the live buffer only if nobody reconnected while we were flushing.
// Check and delete happen inside one Lua script, so a client that joins
// (INCR) between the flush and the delete keeps the buffer alive.
const DELETE_IF_EMPTY = `
if tonumber(redis.call('GET', KEYS[1]) or '0') > 0 then return 0 end
redis.call('DEL', unpack(KEYS))
return 1
`;

// Final flush: called when the LAST client across all instances leaves.
export async function finalFlushAndClean(lectureId) {
  await flushToDB(lectureId);
  await redis.eval(DELETE_IF_EMPTY, {
    keys: [connKey(lectureId), liveQKey(lectureId), liveVKey(lectureId),
           liveVCKey(lectureId), stratKey(lectureId), verKey(lectureId),
           leaseKey(lectureId), sentKey(lectureId), snapKey(lectureId),
           ...indexKeys(lectureId), answeredKey(lectureId)],
  });
}

// No-op kept for API compatibility — strategy change no longer needs cache invalidation
// since Redis buffer IS the live data source
export function invalidateCache() { /* no-op */ }

const qaService = {
  getRankedQuestions, getLiveView, submitQuestion, voteQuestion,
  markAnswered, flushToDB, finalFlushAndClean, invalidateCache,
  clientJoined, clientLeft, getStrategy, setStrategy, tryAcquireFlushLock,
  getSeq,
};
export default qaService;
