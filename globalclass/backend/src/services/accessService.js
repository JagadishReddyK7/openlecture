// Who may take part in a lecture's Q&A, and one-time tickets for the WebSocket.
//
// Access: the lecture's own instructor, or a student enrolled in it. Any other
// logged-in user used to be able to read and post in any lecture.
//
// Caching: a reconnect storm (an instance dies, hundreds of clients reconnect)
// would otherwise put one Postgres query per client on the hot path. Both
// facts are cached in Redis:
//   lecture:owner:<id>     instructor id (never changes after creation)
//   lecture:enrolled:<id>  set of enrolled student ids, positive entries only
// Only positive answers are cached, so a student who enrolls a second after
// being refused is let in on the next try. There is no unenroll, so a cached
// "yes" cannot go stale. The enroll route adds to the set directly.
//
// Tickets: the browser used to put its JWT in the WebSocket URL, which nginx
// writes to its access log. Now it trades the JWT (sent in a header) for a
// random ticket valid for TICKET_TTL seconds and a single use (GETDEL).
import crypto from 'crypto';
import pool from '../config/db.js';
import redis from '../config/redis.js';

const ownerKey    = (id) => `lecture:owner:${id}`;
const enrolledKey = (id) => `lecture:enrolled:${id}`;
const ticketKey   = (t) => `qa:ticket:${t}`;

const CACHE_TTL = 12 * 60 * 60;   // s
const TICKET_TTL = 30;            // s
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// -> { exists, allowed, isOwner }
export async function checkAccess(lectureId, user) {
  if (!UUID.test(String(lectureId))) return { exists: false, allowed: false, isOwner: false };

  let owner = await redis.get(ownerKey(lectureId));
  if (owner === null) {
    const r = await pool.query('SELECT instructor_id FROM lectures WHERE id = $1', [lectureId]);
    if (!r.rows[0]) return { exists: false, allowed: false, isOwner: false };
    owner = r.rows[0].instructor_id;
    await redis.set(ownerKey(lectureId), owner, { EX: CACHE_TTL });
  }

  if (owner === user.id) return { exists: true, allowed: true, isOwner: true };
  if (user.role !== 'student') return { exists: true, allowed: false, isOwner: false };

  if (await redis.sIsMember(enrolledKey(lectureId), user.id)) {
    return { exists: true, allowed: true, isOwner: false };
  }
  const r = await pool.query(
    'SELECT 1 FROM enrollments WHERE lecture_id = $1 AND student_id = $2',
    [lectureId, user.id]
  );
  if (r.rowCount === 0) return { exists: true, allowed: false, isOwner: false };
  await rememberEnrollment(lectureId, user.id);
  return { exists: true, allowed: true, isOwner: false };
}

export async function rememberEnrollment(lectureId, studentId) {
  await redis.multi()
    .sAdd(enrolledKey(lectureId), studentId)
    .expire(enrolledKey(lectureId), CACHE_TTL)
    .exec();
}

export async function issueTicket(lectureId, user, isOwner) {
  const ticket = crypto.randomBytes(32).toString('base64url');
  const claims = { lectureId, isOwner, user: { id: user.id, role: user.role, name: user.name } };
  await redis.set(ticketKey(ticket), JSON.stringify(claims), { EX: TICKET_TTL });
  return { ticket, expiresIn: TICKET_TTL };
}

// Single use: GETDEL reads and deletes in one step, so a ticket can't be
// replayed even by two connections racing with the same value.
export async function redeemTicket(ticket) {
  if (!ticket || ticket.length > 100) return null;
  const raw = await redis.getDel(ticketKey(ticket));
  return raw ? JSON.parse(raw) : null;
}

const accessService = { checkAccess, rememberEnrollment, issueTicket, redeemTicket };
export default accessService;
