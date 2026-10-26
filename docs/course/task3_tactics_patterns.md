# Task 3: Architectural Tactics and Patterns

## 3.1 Architectural Tactics

The following five tactics are employed in the GlobalClass Q&A subsystem. Each is directly tied to a measurable non-functional requirement.

---

### Tactic 1 — Caching (Read-Through with TTL)

**NFR addressed:** API response time p95 ≤ 200ms under normal load; p95 ≤ 500ms under peak load.

**How it works:**  
Every call to `getRankedQuestions` first checks Redis for a cached result keyed by `questions:<lectureId>`. On a cache hit the ranked list is returned immediately without touching PostgreSQL. On a miss the query runs, the result is ranked and stored in Redis with a 10-second TTL, then returned.

On every write (question submission, vote, mark-answered) the cache key is explicitly deleted, ensuring the next read reflects the latest state. The 10-second TTL acts as a safety net for any edge cases where an invalidation is missed.

**Why this matters:**  
During a live lecture many students are simultaneously viewing the Q&A panel. Without caching, each WebSocket broadcast triggers a full `SELECT … GROUP BY … ORDER BY` query against PostgreSQL. With Redis in front, repeated reads within the same 10-second window hit an in-memory store with sub-millisecond response, keeping the p95 target achievable even at high concurrency.

**Implementation reference:**  
`globalclass/backend/src/services/qaService.js` — `getRankedQuestions()`, lines 8–25.

---

### Tactic 2 — Authenticate Users (JWT on WebSocket Upgrade)

**NFR addressed:** Only authenticated users may participate in Q&A (security requirement; also supports audit trails for question authorship).

**How it works:**  
When a client opens a WebSocket connection to `/ws/qa`, the server immediately extracts the JWT from the query string and calls `jwt.verify()` before the client is added to any room. If verification fails the connection is closed with code `4001 Unauthorized` and no further processing occurs. The decoded payload (user ID, role, institution) is attached to the `ws` object and used for all subsequent authorization checks within that session.

**Why this matters:**  
WebSocket connections bypass standard HTTP middleware once the upgrade handshake completes. Performing JWT verification at the upgrade boundary ensures that unauthenticated clients cannot join lecture rooms, submit questions, or receive Q&A data — even if they know the WebSocket URL.

**Implementation reference:**  
`globalclass/backend/src/websocket/qaHandler.js` — lines 20–25.

---

### Tactic 3 — Authorize Actors (Role-Based Access Control)

**NFR addressed:** Data integrity and security — students must not be able to perform instructor-only actions.

**How it works:**  
After authentication, each incoming WebSocket message is checked against the role stored in the JWT payload (`ws.user.role`). The `MARK_ANSWERED` action requires `role === 'instructor'`; if a student sends this message the server responds with an `ERROR` message and does not modify any data. `SUBMIT_QUESTION` and `VOTE` are permitted to all authenticated users regardless of role.

This is enforced server-side on every message, so client-side UI restrictions (e.g., not showing the "Mark Answered" button to students) are a convenience only and are not relied upon for security.

**Why this matters:**  
Without server-side role enforcement, a student could craft a raw WebSocket message to mark all questions as answered, effectively disabling the Q&A session. Enforcing roles on the server closes this attack surface regardless of what the frontend does.

**Implementation reference:**  
`globalclass/backend/src/websocket/qaHandler.js` — lines 48–52.

---

### Tactic 4 — Maintain Data Integrity (Database-Level Uniqueness)

**NFR addressed:** Reliability — each student may cast at most one vote per question; voting counts must be accurate.

**How it works:**  
The `votes` table has a composite unique constraint on `(question_id, student_id)`. When `voteQuestion` is called, it attempts an `INSERT INTO votes`. If the same `(question_id, student_id)` pair already exists, PostgreSQL raises error code `23505` (unique violation). The service layer catches this specific error and throws a user-facing `"Already voted"` error rather than a generic 500.

The constraint is enforced at the database level, meaning it holds even under concurrent requests — no application-level locking or deduplication logic is needed.

**Why this matters:**  
Vote counts directly drive the ranking of questions. If duplicate votes were allowed, a single motivated student could push any question to the top artificially, undermining the usefulness of the ranking for the instructor. Database-level enforcement makes the invariant unconditional.

**Implementation reference:**  
`globalclass/backend/src/db/migrations/001_init.sql` — votes table unique constraint;  
`globalclass/backend/src/services/qaService.js` — `voteQuestion()`, lines 38–54.

---

### Tactic 5 — Event-Driven Push (WebSocket Broadcast)

**NFR addressed:** Q&A round-trip latency ≤ 1 second; 99.9% question delivery reliability.

**How it works:**  
Rather than having clients poll a REST endpoint for updated questions, the server pushes a `QUESTIONS_UPDATE` message to every client in the lecture room immediately after any state-changing event (submit, vote, mark-answered). The server maintains a `rooms` Map from `lectureId` to a `Set<WebSocket>`, and `broadcastQuestions()` iterates this set and sends to all clients whose `readyState === OPEN`.

New clients also receive the current question list immediately on connection (not waiting for the next event), so late joiners are not left with an empty panel.

**Why this matters:**  
HTTP polling at even 2-second intervals means a student who submits a question may wait up to 2 seconds before seeing it appear — and this compounds across vote updates. WebSocket push reduces this to network round-trip time (typically < 100ms on LAN, < 200ms across the internet), comfortably within the ≤ 1s NFR target. It also eliminates the thundering-herd problem where hundreds of students simultaneously poll the server every few seconds during a live lecture.

**Implementation reference:**  
`globalclass/backend/src/websocket/qaHandler.js` — `broadcastQuestions()`, lines 63–69;  
`globalclass/frontend/src/hooks/useWebSocket.js` — `useQAWebSocket` hook.

---

## 3.2 Architectural Patterns

### Architectural Pattern 1 — Layered Architecture

**Role in the Q&A subsystem:**  
The Q&A subsystem is structured as four distinct layers, where each layer only communicates with the layer directly below it. No layer skips a layer to talk to another.

```
┌─────────────────────────────────────────────────────┐
│              Presentation Layer                      │
│   QuestionList.jsx  │  InstructorQAView.jsx          │
│   QuestionInput.jsx │  (React components)            │
└──────────────────────────┬──────────────────────────┘
                           │ sends/receives WebSocket messages
┌──────────────────────────▼──────────────────────────┐
│              Transport Layer                         │
│   useQAWebSocket hook  (frontend)                    │
│   qaHandler.js — WebSocket upgrade + room management│
└──────────────────────────┬──────────────────────────┘
                           │ calls service functions
┌──────────────────────────▼──────────────────────────┐
│              Service Layer                           │
│   qaService.js — business logic, caching             │
│   rankingStrategy.js — ranking algorithms            │
└──────────────────────────┬──────────────────────────┘
                           │ queries
┌──────────────────────────▼──────────────────────────┐
│              Data Layer                              │
│   PostgreSQL (persistent store)                      │
│   Redis (cache + write buffer)                       │
└─────────────────────────────────────────────────────┘
```

**How it supports the tactics:**  
Layering is the structural reason why Tactics 2 and 3 (Authentication and Authorization) work cleanly. Authentication is enforced at the top of the handler layer — no request ever reaches the service layer without passing through the JWT check first. Role checks (RBAC) are enforced in the handler layer before any service call is made. The service layer itself has no knowledge of users or roles; it only processes valid, pre-authorized requests. This separation means security logic is centralized in one place and cannot be accidentally bypassed.

**Why Layered over a flat structure:**  
A flat structure (handler directly querying the database, mixing business logic with WebSocket routing) would make it impossible to enforce consistent security checks, and would make the ranking strategy impossible to swap without rewriting the handler. Layering enforces separation of concerns at the architecture level.

---

### Architectural Pattern 2 — Event-Driven Architecture (EDA)

**Role in the Q&A subsystem:**  
The entire Q&A flow is structured around events rather than request-response. Clients do not ask the server for the current question list — they receive it whenever the server determines state has changed. Every user action (submit, vote, mark-answered, change strategy) is an event that triggers a state update and a broadcast to all subscribers.

```
                    ┌─────────────────────┐
  Student/          │                     │
  Instructor ──────▶│   Event Producer    │  (WebSocket message received)
                    │   qaHandler.js      │
                    └──────────┬──────────┘
                               │ processes event
                    ┌──────────▼──────────┐
                    │   Event Processor   │  (qaService — update DB, bust cache)
                    └──────────┬──────────┘
                               │ emits result event
                    ┌──────────▼──────────┐
                    │   Event Publisher   │  (broadcastQuestions)
                    └──────────┬──────────┘
                               │ QUESTIONS_UPDATE pushed to all
                    ┌──────────▼──────────┐
                    │  Event Consumers    │  (all WebSocket clients in the room)
                    │  Students +         │
                    │  Instructor         │
                    └─────────────────────┘
```

**Event types in the Q&A system:**

| Direction | Event | Trigger |
|---|---|---|
| Client → Server | `SUBMIT_QUESTION` | Student submits a question |
| Client → Server | `VOTE` | Student upvotes a question |
| Client → Server | `MARK_ANSWERED` | Instructor marks a question answered |
| Client → Server | `SET_STRATEGY` | Instructor changes ranking strategy |
| Server → All Clients | `QUESTIONS_UPDATE` | Any of the above events completes |

**How it supports the tactics:**  
EDA directly implements Tactic 5 (Event-Driven Push). The ≤ 1s round-trip NFR is only achievable because clients are passive consumers — they do not poll. The server pushes state exactly when it changes and to exactly who needs it (all room members), with no wasted requests.

**Why EDA over request-response (HTTP polling):**  
With HTTP polling every client would independently request the question list every N seconds. At 500 concurrent students polling every 2 seconds, that is 250 requests/second just for reads — before any actual question activity. With EDA, a broadcast triggered by one vote is one server-side operation that fans out to all 500 clients simultaneously, regardless of how many students are in the room.

---

## 3.3 Design Patterns

### Pattern 1 — Observer Pattern

**Role in architecture:**  
The Observer pattern governs how Q&A state changes are propagated to all connected clients. The Q&A WebSocket handler acts as the **Subject** (also called Publisher). Each connected WebSocket client is an **Observer** (Subscriber). Whenever the subject's state changes — a question is submitted, a vote is cast, or a question is marked answered — it notifies all observers by pushing the updated ranked question list.

**UML Class Diagram:**

```
┌──────────────────────────────┐
│         <<Subject>>          │
│         qaHandler            │
├──────────────────────────────┤
│ - rooms: Map<id, Set<ws>>    │
├──────────────────────────────┤
│ + attach(ws, lectureId)      │
│ + detach(ws, lectureId)      │
│ + broadcastQuestions(id)     │
└──────────────┬───────────────┘
               │ notifies
               ▼
┌──────────────────────────────┐
│        <<Observer>>          │
│      WebSocket Client        │
├──────────────────────────────┤
│ + onmessage(QUESTIONS_UPDATE)│
└──────────────────────────────┘
        ▲               ▲
        │               │
┌───────┴──────┐ ┌──────┴───────┐
│  Student     │ │  Instructor  │
│  (QuestionList│ │(InstructorQA │
│   .jsx)      │ │  View.jsx)   │
└──────────────┘ └──────────────┘
```

**Sequence of a Vote Event:**

```
Student          qaHandler (Subject)       qaService          All Clients (Observers)
   │                    │                      │                       │
   │──VOTE msg─────────▶│                      │                       │
   │                    │──voteQuestion()──────▶│                       │
   │                    │                      │──INSERT votes──▶ DB   │
   │                    │                      │──DEL cache key──▶Redis│
   │                    │◀─────────────────────│                       │
   │                    │──getRankedQuestions()─▶│                      │
   │                    │◀──ranked list─────────│                       │
   │                    │──QUESTIONS_UPDATE─────────────────────────────▶│
   │                    │                      │              (all ws clients)
```

**Why Observer over alternatives:**  
A direct point-to-point notification (e.g., the server calling each client individually with knowledge of who they are) would couple the Q&A logic to client identity. The Observer pattern decouples the subject from its observers — the handler simply iterates the room's Set without caring whether a client is a student or instructor. Adding a new consumer type (e.g., an analytics listener) requires no changes to the subject.

**Implementation reference:**  
`globalclass/backend/src/websocket/qaHandler.js` — full file;  
`globalclass/frontend/src/hooks/useWebSocket.js`;  
`globalclass/frontend/src/components/qa/QuestionList.jsx`;  
`globalclass/frontend/src/components/qa/InstructorQAView.jsx`.

---

### Pattern 2 — Strategy Pattern (Design Pattern)

**Role in architecture:**  
The Strategy pattern governs how student questions are ranked before being sent to clients. The ranking algorithm is encapsulated as an interchangeable strategy, allowing the system to switch between ordering approaches without modifying the calling code in `qaService.js` or the WebSocket handler.

**UML Class Diagram:**

```
┌──────────────────────────────────┐
│         <<Context>>              │
│         qaService                │
├──────────────────────────────────┤
│ + getRankedQuestions(lectureId)  │
│   calls rank(questions, strategy)│
└───────────────┬──────────────────┘
                │ uses
                ▼
┌──────────────────────────────────┐
│       <<Strategy Interface>>     │
│         rank(questions, key)     │
└───┬──────────────┬───────────────┘
    │              │              │
    ▼              ▼              ▼
┌────────┐  ┌──────────┐  ┌────────────────────┐
│byVotes │  │byRecency │  │byVotesThenRecency  │
│        │  │          │  │  (default)         │
└────────┘  └──────────┘  └────────────────────┘
```

**Strategies defined:**

| Strategy key | Sort logic | Use case |
|---|---|---|
| `'votes'` | Descending vote count | Surface most popular questions |
| `'recency'` | Descending creation time | Surface newest questions |
| `'default'` | Votes descending, then creation time ascending | Balanced — popular questions first, ties broken by age |

**How the context uses the strategy:**

```
qaService.getRankedQuestions(lectureId)
    │
    ├── query PostgreSQL for raw questions + vote_count
    │
    └── rank(rows, strategy)          ← strategy selected here
            │
            └── strategies[strategy](questions)  ← interchangeable algorithm
```

**Why Strategy over alternatives:**  
Without this pattern, the ranking logic would be a growing `if/else` block inside `qaService.js`. Adding a new ranking algorithm (e.g., trending — high votes in the last 5 minutes) would require modifying the service itself, violating the Open/Closed Principle. With Strategy, a new algorithm is added by defining a new function and registering it in the `strategies` map — no existing code changes.

**Implementation reference:**  
`globalclass/backend/src/services/rankingStrategy.js` — full file;  
`globalclass/backend/src/services/qaService.js` — `getRankedQuestions()`, line 23.
