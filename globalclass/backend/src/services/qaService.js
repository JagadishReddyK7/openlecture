// Q&A Service
// Write-behind buffer: writes go to Redis first; flushed to PostgreSQL every 5s
import pool from '../config/db.js';
import redis from '../config/redis.js';
import { rank } from './rankingStrategy.js';
import { v4 as uuidv4 } from 'uuid';

// Redis key helpers
const liveQKey  = (id) => `qa:live:q:${id}`;       // Hash: questionId → JSON
const liveVKey  = (id) => `qa:live:voted:${id}`;   // Hash: questionId:studentId → "1"
const liveVCKey = (id) => `qa:live:vc:${id}`;      // Hash: questionId → vote count
const connKey   = (id) => `qa:conn:${id}`;         // String: WS clients across ALL instances
const stratKey  = (id) => `qa:strategy:${id}`;     // String: active ranking strategy
const flushLock = (id) => `qa:flushlock:${id}`;    // String: one flusher per tick

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

// --- Write (buffer to Redis) ---

// Seed Redis from PostgreSQL when the live buffer is empty (resumed session).
// Without this, the first new question after a session gap would start a
// fresh Redis buffer containing only that one question, causing broadcastQuestions
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
  for (const q of qResult.rows) {
    const { vote_count, ...fields } = q;
    qEntries[q.id] = JSON.stringify({ ...fields, vote_count: 0 });
    if (vote_count > 0) vcEntries[q.id] = String(vote_count);
  }
  await redis.hSet(liveQKey(lectureId), qEntries);
  if (Object.keys(vcEntries).length > 0) {
    await redis.hSet(liveVCKey(lectureId), vcEntries);
  }

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
  await redis.hSet(liveQKey(lectureId), id, JSON.stringify(question));
  return question;
}

export async function voteQuestion(questionId, studentId, lectureId) {
  const bufferSize = await redis.hLen(liveQKey(lectureId));
  if (bufferSize === 0) await seedFromDB(lectureId);

  const voteField = `${questionId}:${studentId}`;
  // HSETNX is atomic: returns true if newly set, false if field already existed
  const added = await redis.hSetNX(liveVKey(lectureId), voteField, '1');
  if (!added) throw new Error('Already voted');
  // Atomic increment of vote count
  await redis.hIncrBy(liveVCKey(lectureId), questionId, 1);
  return { message: 'Vote recorded' };
}

export async function markAnswered(questionId, lectureId) {
  // Update in Redis buffer if question is still live
  const raw = await redis.hGet(liveQKey(lectureId), questionId);
  if (raw) {
    const q = JSON.parse(raw);
    q.is_answered = true;
    await redis.hSet(liveQKey(lectureId), questionId, JSON.stringify(q));
  }
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
redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[5])
return 1
`;

// Final flush: called when the LAST client across all instances leaves.
export async function finalFlushAndClean(lectureId) {
  await flushToDB(lectureId);
  await redis.eval(DELETE_IF_EMPTY, {
    keys: [connKey(lectureId), liveQKey(lectureId), liveVKey(lectureId),
           liveVCKey(lectureId), stratKey(lectureId)],
  });
}

// No-op kept for API compatibility — strategy change no longer needs cache invalidation
// since Redis buffer IS the live data source
export function invalidateCache() { /* no-op */ }

const qaService = {
  getRankedQuestions, submitQuestion, voteQuestion,
  markAnswered, flushToDB, finalFlushAndClean, invalidateCache,
  clientJoined, clientLeft, getStrategy, setStrategy, tryAcquireFlushLock,
};
export default qaService;
