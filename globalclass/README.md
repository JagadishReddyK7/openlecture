# GlobalClass: code reference

The implementation of OpenLecture. For what the system does, the design
decisions and the measured results, start at the [root README](../README.md).
This file is the reference for the code itself.

## Layout

```
globalclass/
├── backend/            core-api: auth, catalog/enrollment, Q&A (REST + WebSocket)
│   ├── src/services/   qaService (Redis write-behind, Lua), broadcaster (coalescing),
│   │                   rankingStrategy (Strategy pattern), accessService (enrollment, tickets)
│   ├── src/websocket/  qaHandler: /qaws, presence, sweeper, flush loop
│   └── scripts/        smoke, access, ranking, coalescing, tail-loss, capacity checks
├── streaming-engine/   LiveKit tokens, WebRTC/HLS tier allocation (Redis Lua), HLS egress (prototype)
├── frontend/           React 18, LiveKit components, hls.js
├── nginx/              gateway: routing, least_conn, failover timeouts, HLS cache headers
├── k6/qa_ws_test.js    Q&A WebSocket load test
├── load_test.js        HTTP load test (join / HLS / catalog)
├── scripts/            run-qa-load.ps1, chaos-kill-core.ps1, sample-stats.ps1
├── observability/      Prometheus + Grafana (compose profile "observability")
└── docker-compose.yml
```

## Run (PowerShell, from this directory)

```powershell
Copy-Item .env.example .env          # then fill in the LiveKit keys
docker compose up -d --build --scale core-api=3 --scale streaming-engine=3
docker compose restart api-gateway   # nginx resolves upstream IPs only at startup
cd frontend; npm install; npm start  # http://localhost:3000 (talks to the gateway on :80)
```

The database schema is applied automatically when core-api starts. Add
`--profile observability` to the `up` command for Prometheus (`:9090`) and
Grafana (`:3001`).

## REST API (via the gateway on :80)

| Method | Path | Who | Description |
|---|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login` | anyone | account, JWT |
| GET | `/api/lectures` | logged in | catalog |
| POST | `/api/lectures` | instructor | create lecture |
| PATCH | `/api/lectures/:id/status` | the lecture's instructor | status |
| POST | `/api/lectures/:id/enroll` | student | enroll |
| GET | `/api/lectures/:id/questions` | the lecture's instructor or an enrolled student | full ranked list |
| POST | `/api/lectures/:id/questions` | same | submit (broadcast to live clients) |
| POST | `/api/lectures/:id/questions/:qid/vote` | same | upvote |
| PATCH | `/api/lectures/:id/questions/:qid/answer` | the lecture's instructor | mark answered |
| POST | `/api/qa/ticket` | same as the Q&A routes | one-time WebSocket ticket (30 s) |
| POST | `/api/stream/start/:id`, `/end/:id` | the lecture's instructor | start / end stream |
| POST | `/api/stream/join/:id` | the lecture's instructor or an enrolled student | WebRTC token or HLS URL |
| POST | `/api/stream/leave/:id` | logged in | release WebRTC slot |

## Q&A WebSocket

`POST /api/qa/ticket {lectureId}` with the JWT in the `Authorization` header,
then `ws://localhost/qaws?lectureId=<id>&ticket=<ticket>`. The ticket is
single use. Reconnect with a new one.

Client → server (`clientMsgId` is optional and echoed back in the ACK):

```jsonc
{ "type": "SUBMIT_QUESTION", "content": "What is ...", "clientMsgId": "c1" }
{ "type": "VOTE", "questionId": "uuid" }
{ "type": "MARK_ANSWERED", "questionId": "uuid" }          // the lecture's instructor
{ "type": "SET_STRATEGY", "strategy": "default|votes|recency" }   // the lecture's instructor
```

Server → client:

```jsonc
{ "type": "QUESTIONS_UPDATE", "seq": 42, "strategy": "default",
  "counts": { "total": 120, "unanswered": 95, "answered": 25 },
  "questions": [ /* top 50 unanswered */ ], "answered": [ /* latest 20 */ ] }
{ "type": "ACK", "clientMsgId": "c1", "seq": 42 }
{ "type": "ERROR", "clientMsgId": "c1", "message": "Already voted" }
```

Updates are coalesced to at most one per lecture per 250 ms. `seq` increases
with every mutation. A client should ignore an update with a lower `seq` than
one it already applied.

## Tests and tools

| Command | What it checks |
|---|---|
| `cd backend; node scripts/smoke.js` | end-to-end API + Q&A through the gateway, including the Postgres flush |
| `cd backend; node scripts/access-check.js` | access-control matrix (23 cases) |
| `cd backend; node scripts/coalesce-check.js` | broadcaster correctness against Redis (needs Redis on :6379) |
| `docker compose exec -T core-api node scripts/ranking-check.js` | Redis ranking indexes == in-memory sort |
| `cd backend; node scripts/tail-loss-check.js` | no data loss when an instance is killed (kills one core-api) |
| `.\scripts\run-qa-load.ps1 -Clients 1000 -Tag x` | Q&A WebSocket load test, results to `../docs/raw/` |
| `.\scripts\chaos-kill-core.ps1 -Clients 1000 -Tag x` | the same, with one core-api killed mid-run |

## Design patterns

- **Strategy:** `rankingStrategy.js`. Each ranking has an in-memory comparator
  and a live Redis sorted-set index, and `ranking-check.js` keeps the two in agreement.
- **Observer:** `qaHandler.js`. Redis Pub/Sub delivers each lecture update to
  every core-api instance, which relays it to its local sockets.

## Course phase (Team 43)

This prototype started as the Team 43 course project. Feature ownership during
the course is kept here as it was. Later work is described in the root README
and `docs/results.md`.

| Feature | Owner | Status |
|---------|-------|--------|
| User Auth (JWT + RBAC) | Suresh | ✅ Complete |
| Course Catalog & Enrollment | Suresh | ✅ Complete |
| Real-Time Q&A (Redis Pub/Sub) | Aayush | ✅ Complete |
| Live Video Streaming (WebRTC + HLS) | Karthik | ✅ Complete |
| Load Balancing (Nginx) | Jagadish | ✅ Complete |

| Member | Contribution |
|--------|-------------|
| Aayush | Q&A system, Redis Pub/Sub, Strategy Pattern |
| Karthik | WebRTC Live Streaming, LiveKit Integration, HLS Tiers |
| Jagadish | Nginx Load Balancing, Docker Orchestration, Fault Tolerance |
| Suresh | Auth Subsystem, Course Catalog, Database Schema |

The course-era setup and scaling notes (SETUP, LOAD_BALANCING, …) are in
[docs/course/prototype-notes](../docs/course/prototype-notes/). Some commands
in them predate the changes above.
