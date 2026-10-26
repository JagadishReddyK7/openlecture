# ADR-004: Redis for Session Management and Hot Data Caching

**Date:** 2026-04-13
**Status:** Accepted

---

## Context

OpenLecture targets 10,000 concurrent users. This volume creates two specific performance bottlenecks that a single relational database (PostgreSQL) cannot handle efficiently without an intermediate caching and session management layer:

### Bottleneck 1 — Authentication at Scale
Every API request from every connected user carries a JWT token that must be validated. At 10,000 concurrent users, each actively making requests (stream keep-alives, Q&A submissions, catalog browsing), this generates tens of thousands of token validation lookups per minute.

- **Option A — Validate against PostgreSQL every time:** Each validation requires a DB query to check token validity and user role. PostgreSQL's default connection limit is ~100–500 connections (without pooling). At 10,000 concurrent users, this becomes the primary bottleneck, driving API latency well above the NFR5 targets (p95 ≤200ms normal, ≤500ms peak).
- **Option B — Stateless JWT validation only:** Pure stateless JWT validation (signature check only) avoids DB lookups but prevents token revocation — a compromised token remains valid until expiry, which is a significant security risk in an academic platform.
- **Option C (Chosen) — Redis session store:** JWT tokens are validated by signature, and the session state (user ID, role, institution, revocation flag) is cached in Redis. Redis can handle **100,000+ reads/second** at sub-millisecond latency, eliminating the DB as the auth bottleneck.

### Bottleneck 2 — Q&A Write Storms
During a large lecture, thousands of students may submit questions or votes within a short time window (e.g., at the end of a lecture segment). A direct write-per-event model to PostgreSQL would result in thousands of write operations per second on the primary DB.

- **Option A — Write directly to PostgreSQL:** Standard relational writes. At 1,000+ writes/second, this saturates PostgreSQL's write throughput, increases lock contention, and degrades latency across all other services sharing the DB.
- **Option B (Chosen) — Redis as write buffer + async PostgreSQL persistence:** Active Q&A state (live question list, vote counts) is stored in Redis for the duration of a lecture. Redis absorbs all high-frequency writes at in-memory speed. A background worker periodically flushes the Redis state to PostgreSQL. After the lecture ends, a final flush ensures full persistence.

### Bottleneck 3 — Read-Heavy Hot Data
Certain data is read extremely frequently but changes rarely: the course catalog, lecture metadata for an ongoing session, and institution lists. Repeatedly querying PostgreSQL for this data under 10,000 concurrent users creates unnecessary read load.

- **Option (Chosen) — Cache hot data in Redis with TTL:** Frequently accessed, rarely changing data is cached in Redis with a time-to-live (TTL). Cache invalidation is triggered explicitly when the underlying data changes (e.g., a lecture is updated).

---

## Decision

We will use **Redis** as a shared in-memory data store to serve three distinct roles within the OpenLecture platform:

1. **Session Store:** User session data (user ID, role, institution, token revocation status) is stored in Redis. The User Management Service writes to Redis on login; all services read from Redis for auth checks. Tokens are invalidated in Redis on logout.

2. **Q&A Write Buffer:** The Student Interaction Service writes all question submissions and vote updates to Redis during a live lecture. A background worker flushes to PostgreSQL every 5 seconds and performs a final flush when the lecture ends.

3. **Hot Data Cache:** The Course Catalog Service and Lecture Scheduling Service cache frequently read, infrequently changing data (course lists, lecture metadata) in Redis with appropriate TTLs (e.g., 60 seconds for catalog, 10 seconds for live lecture state).

Redis will be deployed in a **master-replica configuration** to ensure high availability — if the master node fails, a replica is promoted automatically, preventing a single point of failure.

Additionally, **PgBouncer** (connection pooler) will be deployed in front of PostgreSQL. At 10,000 concurrent users, raw PostgreSQL connections would be exhausted. PgBouncer multiplexes thousands of application-level connections onto a bounded pool of actual database connections, satisfying NFR5's performance targets under peak load (p95 ≤500ms at 10,000 concurrent users).

**PostgreSQL streaming replication with automatic leader election** (NFR4) will be configured: a replica is kept in sync with the primary, and if the primary fails, the replica is promoted automatically. This prevents the data tier from becoming a single point of failure and contributes to the 99.5% uptime target.

---

## Consequences

### Positive
- **Auth performance at scale:** Token validation becomes a sub-millisecond Redis read rather than a PostgreSQL query — directly enables meeting NFR5's p95 ≤200ms target under normal load and ≤500ms under peak load (10,000 concurrent users).
- **Q&A scalability:** Redis absorbs write bursts from thousands of simultaneous question submissions, decoupling the Q&A experience from PostgreSQL write throughput.
- **Reduced DB load:** Caching hot data in Redis significantly reduces read pressure on PostgreSQL, freeing it for writes and complex queries.
- **Secure token revocation:** Unlike stateless-only JWT, the Redis session store allows immediate token invalidation on logout or account suspension — a security requirement in a multi-institution academic environment.
- **High availability:** Master-replica Redis configuration ensures the session store and Q&A buffer remain available even if one Redis node fails. PostgreSQL streaming replication with automatic leader election ensures the data tier meets the 99.5% uptime target (NFR4) without a single point of failure.
- **NFR2 Q&A reliability:** The Redis write buffer combined with periodic PostgreSQL flushes ensures that no question submission is permanently lost during transient database unavailability — directly supporting the 99.9% question delivery rate required by NFR2.
- **Lecture join performance:** By caching enrollment status and live lecture state in Redis, the lecture join flow avoids cold database queries — directly enabling the NFR5 join ≤4 seconds target.

### Negative / Trade-offs
- **Data durability risk for Q&A:** Because active Q&A state lives in Redis (in-memory), a Redis failure between flush intervals could result in loss of the last few seconds of votes and question submissions. This is mitigated by frequent flush intervals (every 5 seconds) and Redis AOF (Append-Only File) persistence, but a small loss window remains.
- **Cache invalidation complexity:** Stale data in Redis can cause inconsistencies — for example, a cached course listing showing a lecture that was just cancelled. Explicit cache invalidation logic must be implemented and tested carefully, especially for time-sensitive lecture data.
- **Additional infrastructure:** Redis is an additional service to deploy, configure, monitor, and back up. In a production environment, Redis Sentinel or Redis Cluster is needed for full fault tolerance.
- **Memory cost:** All cached data and session state lives in RAM. At 10,000 active sessions and large course catalogs, Redis memory usage must be monitored and bounded with appropriate eviction policies (e.g., `allkeys-lru`).

---

## Prototype Implementation

The prototype fully implements the Redis write buffer pattern described in this ADR.

**Write path:**
- `submitQuestion` generates a UUID on the application side and writes the question as a JSON entry into a Redis hash (`qa:live:q:<lectureId>`). PostgreSQL is not touched at write time.
- `voteQuestion` uses Redis `HSETNX` on a voted-tracking hash (`qa:live:voted:<lectureId>`) for atomic duplicate detection, and `HINCRBY` on a vote-count hash (`qa:live:vc:<lectureId>`) for a race-condition-free increment. Neither operation hits PostgreSQL.

**Read path:**
- `getRankedQuestions` reads directly from the Redis live buffer (`qa:live:q` + `qa:live:vc`) for active lectures. PostgreSQL is only consulted as a fallback for ended lectures where the Redis buffer has been cleaned up.

**Flush mechanism:**
- A `setInterval` in `qaHandler.js` fires every 5 seconds and calls `flushToDB(lectureId)` for all active lecture rooms. This upserts all buffered questions and votes into PostgreSQL using `INSERT … ON CONFLICT DO UPDATE/NOTHING`.
- When the last WebSocket client disconnects from a lecture room, `finalFlushAndClean(lectureId)` performs a final flush and deletes all three Redis buffer keys, ensuring complete durability before the in-memory state is cleared.

**Known limitation:**
The final flush is triggered by the last client disconnecting, not by an explicit "lecture ended" event. In production, a Kafka consumer on the `lecture.lifecycle` topic (ADR-003) would trigger the final flush reliably regardless of client connection state. This integration is outside prototype scope.
