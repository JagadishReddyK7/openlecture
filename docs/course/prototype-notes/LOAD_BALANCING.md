# Load Balancing — Testing & Demonstration Guide

> **Purpose:** Step-by-step instructions to start, scale, verify, and demonstrate
> load balancing across all GlobalClass microservices. Use this during your viva
> to prove that the system scales horizontally without breaking any feature.

---

## Architecture Recap

```
Browser
  │
  ▼
Nginx (port 80) — least_conn load balancer
  ├── /api/stream/*  →  streaming-engine  (stateless, scale freely)
  ├── /api/*         →  core-api          (stateful — Redis Pub/Sub syncs Q&A)
  └── /qaws          →  core-api          (WebSocket — Redis Pub/Sub broadcast)

Redis  ←──  shared by all core-api instances for Q&A state + Pub/Sub
PostgreSQL  ←── shared by all instances for persistence
LiveKit Cloud  ←── actual video routing (not inside Docker)
```

| Service | Stateful? | Extra coordination needed to scale? |
|---|---|---|
| `core-api` | ✅ Yes — in-memory WebSocket rooms | ✅ Redis Pub/Sub (already implemented) |
| `streaming-engine` | ❌ No — just generates JWT tokens | ❌ None — scale freely |
| `postgres` | ✅ Yes | Out of scope (single node for prototype) |
| `redis` | ✅ Yes | Out of scope (single node for prototype) |

---

## Prerequisites

All commands are run from the `globalclass/` directory:

```powershell
cd c:\my_workspace\SE\project-3\openLecture\globalclass
```

Make sure Docker Desktop is running and all containers started at least once:
```powershell
docker compose up -d
```

---

## Section 1 — Starting with Multiple Instances

### Scale both services

```powershell
docker compose up -d --build --scale core-api=3 --scale streaming-engine=3
```

Nginx must be restarted after scaling so it re-resolves Docker DNS and discovers new instances:
```powershell
docker restart globalclass-api-gateway-1
Start-Sleep -Seconds 3
```

### Verify all instances are running

```powershell
docker compose ps
```

Expected — you should see 3 of each:
```
NAME                               STATUS          PORTS
globalclass-api-gateway-1          Up              0.0.0.0:80->80/tcp
globalclass-core-api-1             Up              4000/tcp
globalclass-core-api-2             Up              4000/tcp
globalclass-core-api-3             Up              4000/tcp
globalclass-postgres-1             Up (healthy)    0.0.0.0:5432->5432/tcp
globalclass-redis-1                Up (healthy)    0.0.0.0:6379->6379/tcp
globalclass-streaming-engine-1     Up              4001/tcp
globalclass-streaming-engine-2     Up              4001/tcp
globalclass-streaming-engine-3     Up              4001/tcp
```

---

## Section 2 — Verifying Load Balancing is Working

### Test 1: REST API requests are distributed across core-api instances

Fire 9 requests through Nginx on port 80:
```powershell
1..9 | ForEach-Object {
  Invoke-WebRequest -Uri http://localhost/api/lectures `
    -Headers @{Authorization="Bearer fake"} `
    -UseBasicParsing -ErrorAction SilentlyContinue | Out-Null
  Write-Host "Request $_ sent"
}
```

Check which instances handled the requests:
```powershell
docker compose logs --tail 40 core-api | Select-String "PostgreSQL connected|Invalid"
```

You will see `core-api-1`, `core-api-2`, and `core-api-3` all appear in the output —
proving Nginx distributed the 9 requests across all three instances.

### Test 2: Streaming engine requests are distributed

```powershell
1..9 | ForEach-Object {
  Invoke-WebRequest -Uri http://localhost/api/stream/start `
    -Method POST `
    -Headers @{Authorization="Bearer fake"; "Content-Type"="application/json"} `
    -Body '{"lectureId":"test"}' `
    -UseBasicParsing -ErrorAction SilentlyContinue | Out-Null
}

docker compose logs --tail 30 streaming-engine
```

You will see `streaming-engine-1`, `streaming-engine-2`, `streaming-engine-3` interleaved.

### Test 3: Health endpoint confirms all instances are reachable

```powershell
Invoke-WebRequest -Uri http://localhost/health/core -UseBasicParsing | Select-Object -ExpandProperty Content
# Expected: {"status":"ok","service":"core-api"}

Invoke-WebRequest -Uri http://localhost/health/streaming -UseBasicParsing | Select-Object -ExpandProperty Content
# Expected: {"status":"ok","service":"streaming-engine"}
```

---

## Section 3 — Proving Q&A Pub/Sub Works Across Instances

This is the most important demo — it proves that a question submitted to one
core-api instance is broadcast to students connected to a different instance.

### Step 1: Watch all instance logs simultaneously

Open a dedicated PowerShell window and run:
```powershell
docker compose logs -f core-api
```

Leave it open. You will see logs from all instances prefixed with their name.

### Step 2: Open the app and join a lecture

1. Open http://localhost:3000 in two or three browser tabs
2. Log in as instructor in one tab, students in others
3. Instructor creates a lecture and clicks **Go Live → Open Room**
4. Students enroll and click **Join Live**

### Step 3: Submit a question and watch the logs

In a student tab, type a question and click **↑ Ask**.

In the logs you will see something like:

```
core-api-2 | [WS] Received message from student: SUBMIT_QUESTION
core-api-2 | [WS] Submitting question for lecture abc-123
core-api-2 | [WS] Published QUESTIONS_UPDATE to channel qa:broadcast:abc-123 (3 subscribers)
core-api-1 | [WS] Subscribed to Redis channel: qa:broadcast:abc-123   ← (relaying to its local clients)
core-api-3 | [WS] Subscribed to Redis channel: qa:broadcast:abc-123   ← (relaying to its local clients)
```

The question appears in all tabs — even tabs whose WebSocket is connected to a
different instance than the one that received the submission.

### Step 4: Inspect the Redis channel directly

Find your lecture ID from the logs above, then open the Redis CLI:
```powershell
docker exec -it globalclass-redis-1 redis-cli
```

List all active broadcast channels:
```
KEYS qa:broadcast:*
```

Subscribe to one and watch messages arrive live as questions are submitted:
```
SUBSCRIBE qa:broadcast:<your-lecture-id>
```

Every question submission, vote, or mark-answered event will appear as a full
JSON payload. Press `Ctrl+C` to exit when done.

---

## Section 4 — Fault Tolerance Demo

### Demo: Kill one core-api instance, system keeps working

```powershell
# Stop one instance
docker stop globalclass-core-api-2

# Verify API still responds (Nginx fails over to the remaining two)
Invoke-WebRequest -Uri http://localhost/health/core -UseBasicParsing | Select-Object -ExpandProperty Content
# Expected: {"status":"ok","service":"core-api"}
```

Q&A submissions and all REST API calls continue working. Nginx automatically
stops routing to the dead container and distributes to `core-api-1` and `core-api-3`.

Restore it:
```powershell
docker start globalclass-core-api-2
```

### Demo: Kill one streaming-engine instance, streaming keeps working

```powershell
docker stop globalclass-streaming-engine-2

# Students can still join — requests route to instances 1 and 3
Invoke-WebRequest -Uri http://localhost/health/streaming -UseBasicParsing | Select-Object -ExpandProperty Content
# Expected: {"status":"ok","service":"streaming-engine"}

# Restore
docker start globalclass-streaming-engine-2
```

### Demo: Fault isolation — kill streaming, Q&A still works

This demonstrates the microservices architecture from ADR-002:
```powershell
docker compose stop streaming-engine
```

Now in the browser: Q&A panel works perfectly — students can submit questions,
votes update in real time, mark answered works. Only the LiveKit streaming
token endpoint fails gracefully (`"Failed to start stream"` — not a crash).

```powershell
# Restore streaming
docker compose start streaming-engine
```

---

## Section 5 — Monitoring All Instances

### Watch a specific service's logs (all instances)

```powershell
docker compose logs -f core-api          # all core-api instances
docker compose logs -f streaming-engine  # all streaming-engine instances
```

### Watch a single instance only

```powershell
docker logs -f globalclass-core-api-1
docker logs -f globalclass-core-api-2
docker logs -f globalclass-core-api-3
```

### Count active WebSocket rooms in Redis

```powershell
docker exec globalclass-redis-1 redis-cli KEYS "qa:broadcast:*"
docker exec globalclass-redis-1 redis-cli KEYS "qa:live:q:*"
```

### Check Redis memory usage

```powershell
docker exec globalclass-redis-1 redis-cli INFO memory | Select-String "used_memory_human"
```

---

## Section 6 — Scaling Up and Down

```powershell
# Scale to 2 instances each
docker compose up -d --scale core-api=2 --scale streaming-engine=2
docker restart globalclass-api-gateway-1

# Scale to 5 instances for a stress demo
docker compose up -d --scale core-api=5 --scale streaming-engine=5
docker restart globalclass-api-gateway-1

# Scale back to 1 (normal development mode)
docker compose up -d --scale core-api=1 --scale streaming-engine=1
docker restart globalclass-api-gateway-1
```

> **Important:** Always restart `api-gateway` after scaling so Nginx re-resolves
> Docker's internal DNS and discovers the new containers.

---

## Section 7 — Quick Reference Card

```
─────────────────────────────────────────────────────────────
LOAD BALANCING QUICK COMMANDS
─────────────────────────────────────────────────────────────
Scale up:
  docker compose up -d --scale core-api=3 --scale streaming-engine=3
  docker restart globalclass-api-gateway-1

Verify instances:
  docker compose ps

Watch all logs:
  docker compose logs -f core-api
  docker compose logs -f streaming-engine

Test REST load balancing:
  1..9 | ForEach-Object {
    Invoke-WebRequest http://localhost/api/lectures `
      -Headers @{Authorization="Bearer x"} `
      -UseBasicParsing -ErrorAction SilentlyContinue | Out-Null
  }
  docker compose logs --tail 30 core-api

Monitor Redis Pub/Sub:
  docker exec -it globalclass-redis-1 redis-cli
  > SUBSCRIBE qa:broadcast:<lectureId>

Kill one instance (fault tolerance test):
  docker stop globalclass-core-api-2
  Invoke-WebRequest http://localhost/health/core -UseBasicParsing
  docker start globalclass-core-api-2

Fault isolation (streaming down, Q&A up):
  docker compose stop streaming-engine
  # → verify Q&A still works in browser
  docker compose start streaming-engine

Scale back to 1:
  docker compose up -d --scale core-api=1 --scale streaming-engine=1
  docker restart globalclass-api-gateway-1
─────────────────────────────────────────────────────────────
```

---

## What to Say in the Viva

**On load balancing:**
> "Nginx uses `least_conn` load balancing — new HTTP requests are forwarded to
> whichever upstream instance has the fewest active connections. When we scale
> with `--scale core-api=3`, Docker's internal DNS resolves the service name to
> all three container IPs, and Nginx distributes across them."

**On Q&A across instances:**
> "The key challenge with stateful WebSocket services is that in-memory rooms
> are local to each instance. We solved this using Redis Pub/Sub — every
> state-mutating event publishes to a per-lecture Redis channel, and every
> subscribed instance relays the payload to its local WebSocket clients. This
> means a student on Instance 1 and a student on Instance 3 see the same
> question the moment it's submitted, regardless of which instance received it."

**On streaming-engine scaling:**
> "The streaming engine is fully stateless — it just validates enrollment and
> generates a signed LiveKit JWT token. There's no shared in-memory state to
> coordinate, so it scales with a single command. The actual video routing is
> handled by LiveKit's cloud SFU, not our container."

**On fault tolerance:**
> "You can see fault isolation in action: stopping the streaming engine
> doesn't affect Q&A at all — both services are completely independent. Nginx
> automatically stops routing to failed instances and redistributes traffic
> to healthy ones within seconds."
