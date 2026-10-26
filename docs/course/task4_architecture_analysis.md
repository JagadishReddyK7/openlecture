# Task 4: Architecture Analysis — Q&A Subsystem

## 4.1 Implemented Architecture

The Q&A subsystem uses a **WebSocket-based Event-Driven Architecture (EDA)**. The server maintains persistent bidirectional connections with all clients in a lecture room. When any state-changing event occurs (question submitted, vote cast, question marked answered, strategy changed), the server immediately pushes the updated question list to every connected client.

**Key characteristics:**
- One persistent TCP connection per client, established at lecture join
- Server-initiated push on every state change (`broadcastQuestions`)
- No client-side polling — clients are passive receivers
- Redis cache absorbs repeated reads within 10-second windows

---

## 4.2 Alternative Architecture — HTTP Polling

The alternative considered is **REST-based HTTP polling**, where clients periodically send `GET /api/questions/:lectureId` requests to fetch the latest question list. This is the traditional approach used by most web applications before WebSockets became mainstream.

**Key characteristics:**
- Stateless HTTP request-response per poll cycle
- Client controls the polling interval (e.g., every 2 seconds)
- Server does not maintain any per-client connection state
- Each poll is an independent authenticated request

---

## 4.3 Quantitative Comparison

### NFR 1 — Q&A Round-Trip Latency (Target: ≤ 1 second)

**Scenario:** Student A submits a question. How long before Student B sees it appear?

**WebSocket Push:**

```
Student A submits → server processes → broadcastQuestions() → Student B receives
     ~5ms               ~15ms                ~1ms                  ~50ms*
                                                           ─────────────────
                                                           Total: ~70ms
```
*50ms = typical internet round-trip latency

The update reaches Student B within ~70ms of Student A submitting. This is determined entirely by network latency — there is no artificial delay.

**HTTP Polling (2-second interval):**

```
Student A submits → server processes → Student B polls next cycle → receives update
     ~5ms               ~15ms              0 to 2000ms wait           ~50ms
                                        ──────────────────────────────────────
                                        Total: 70ms to 2070ms (avg ~1035ms)
```

With a 2-second polling interval, Student B may wait anywhere from near-zero (lucky timing) to 2 full seconds before their next poll catches the update. The average wait is half the interval: **~1 second**, which is exactly at the NFR boundary — not a margin, a cliff edge. Reducing the interval to 1 second halves the average latency to ~500ms but doubles the server load.

| Architecture | Best case | Average case | Worst case | NFR met? |
|---|---|---|---|---|
| WebSocket Push | ~70ms | ~70ms | ~150ms | ✅ Comfortably |
| HTTP Polling (2s) | ~70ms | ~1035ms | ~2070ms | ⚠️ Borderline |
| HTTP Polling (1s) | ~70ms | ~535ms | ~1070ms | ⚠️ Borderline |
| HTTP Polling (500ms) | ~70ms | ~285ms | ~570ms | ✅ But at high cost |

---

### NFR 2 — Throughput / Server Load (Target: p95 ≤ 200ms under normal load)

**Scenario:** 500 concurrent students are watching a live lecture and viewing the Q&A panel.

**WebSocket Push:**

Server-side activity per question submission event:
- 1 DB write (INSERT question)
- 1 Redis cache invalidation
- 1 DB read (SELECT questions + votes)
- 1 Redis cache write
- 500 WebSocket sends (fan-out to all clients)

Total requests to the server: **1 event → 1 processing cycle**  
Read operations per second: determined only by how frequently questions are submitted, not by client count.

If 10 questions are submitted per minute during a lecture:
```
Read queries/minute = 10 (one per submission event)
WebSocket sends/minute = 10 × 500 = 5,000 (fan-out, but these are cheap TCP writes)
```

**HTTP Polling (2-second interval):**

Each client polls independently every 2 seconds:
```
Requests/second = 500 clients ÷ 2 seconds = 250 requests/second (reads only)
DB queries/second = 250 (assuming no cache, or cache miss on cold start)
With Redis cache (10s TTL): DB queries every 10s = ~1 query per 10s per unique key
                             but 250 HTTP requests/second still hit the server
```

Even with Redis caching the DB queries, the Node.js server still handles **250 HTTP requests/second** just for polling — before processing any actual question submissions or votes.

| Architecture | Requests/sec (500 clients) | DB reads/sec | Scales to 5,000 clients? |
|---|---|---|---|
| WebSocket Push | ~0 (event-driven) | ~0 (cache hit) | Yes — fan-out cost only |
| HTTP Polling (2s) | 250 req/s | ~1–10/s (cached) | 2,500 req/s — significant |
| HTTP Polling (1s) | 500 req/s | ~1–10/s (cached) | 5,000 req/s — problematic |

At 5,000 concurrent students, HTTP polling at 2-second intervals generates **2,500 HTTP requests/second** to the server purely for reads — this approaches the throughput ceiling of a single Node.js process (~5,000–10,000 req/s for simple handlers). WebSocket push at the same scale generates zero additional polling load — only fan-out writes on actual events.

---

## 4.4 Trade-Off Discussion

### Where WebSocket Push wins

| Dimension | WebSocket Push | HTTP Polling |
|---|---|---|
| Latency | Deterministic, network-bound (~70ms) | Probabilistic, interval-bound (0 to Nms) |
| Server load at scale | O(events) — independent of client count | O(clients × frequency) — grows linearly |
| Real-time feel | Immediate | Delayed by up to polling interval |
| NFR compliance | Comfortably meets ≤ 1s | Requires ≤ 500ms intervals to meet ≤ 1s |

### Where HTTP Polling wins

| Dimension | WebSocket Push | HTTP Polling |
|---|---|---|
| Connection management | Server must track all open sockets | Fully stateless — no server-side state |
| Infrastructure compatibility | Requires WebSocket support (proxies, load balancers) | Works everywhere HTTP works |
| Reliability on poor networks | Dropped connection requires reconnect logic | Each poll is independent; failures are isolated |
| Implementation complexity | Higher — upgrade handshake, room management, broadcast | Lower — standard REST endpoint |
| Client reconnection | Must implement reconnect + rejoin logic | Automatic — next poll just works |

### Why WebSocket Push was chosen for GlobalClass

The proposal's NFR of **Q&A round-trip ≤ 1 second** effectively rules out polling intervals longer than 500ms (to maintain a margin). At 500ms polling with 500+ concurrent students, the server receives 1,000+ HTTP requests/second for reads alone — a significant overhead for what is essentially "nothing changed" responses.

More importantly, the proposal targets **10,000 concurrent students** at scale. HTTP polling at that scale with a 2-second interval generates **5,000 requests/second** of pure polling traffic. WebSocket push scales to 10,000 clients with the same server-side processing cost per event — only the fan-out write count grows, and TCP writes are significantly cheaper than full HTTP request-response cycles.

The trade-off accepted is increased server-side complexity: connection lifecycle management, room cleanup on disconnect, and reconnection handling on the client. These were implemented in `qaHandler.js` (room Map, `ws.on('close')` cleanup) and `useQAWebSocket.js` (cleanup on unmount).

---

## 4.5 Summary

| NFR | Target | WebSocket Push | HTTP Polling (2s) |
|---|---|---|---|
| Q&A round-trip latency | ≤ 1s | ~70ms ✅ | ~1035ms avg ⚠️ |
| Server throughput (500 clients) | p95 ≤ 200ms | ~0 polling load ✅ | 250 req/s polling load ⚠️ |
| Server throughput (5,000 clients) | p95 ≤ 500ms peak | Scales linearly ✅ | 2,500 req/s polling ❌ |
| Implementation complexity | — | Higher | Lower |
| Infrastructure requirements | — | WebSocket support needed | Standard HTTP |

The WebSocket-based EDA architecture was the correct choice for GlobalClass given the real-time interaction requirement and the target scale. HTTP polling would satisfy the latency NFR only at polling intervals that themselves create unsustainable server load at the target concurrency.
