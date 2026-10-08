# GlobalClass — Distributed Platform for Global Academic Lectures

A prototype implementation for the OpenLecture Software Engineering project (Team 43).

## Features Implemented

| Feature | Owner | Status |
|---------|-------|--------|
| User Auth (JWT + RBAC) | Suresh | ✅ Complete |
| Course Catalog & Enrollment | Suresh | ✅ Complete |
| Real-Time Q&A (Redis Pub/Sub) | Aayush | ✅ Complete |
| Live Video Streaming (WebRTC + HLS) | Karthik | ✅ Complete |
| Load Balancing (Nginx) | Jagadish | ✅ Complete |


## Tech Stack

- **Frontend:** React 18, React Router, LiveKit SDK
- **Core API:** Node.js, Express, WebSocket (ws)
- **Streaming Engine:** Node.js (Stateless LiveKit Token Gen)
- **Database:** PostgreSQL 15
- **Real-time Sync:** Redis 7 (Pub/Sub for cross-instance Q&A)
- **API Gateway:** Nginx (Load Balancer & Proxy)
- **Storage/CDN:** MinIO (Local S3 for HLS segments)

## Project Structure

```
globalclass/
├── backend/            # Core API (Auth, Catalog, Q&A)
├── streaming-engine/   # Streaming service (LiveKit JWTs, HLS egress)
├── frontend/           # React dashboard & players
├── nginx/              # Nginx gateway & load balancer config
├── docker-compose.yml  # Microservices orchestration
├── load_test.js        # k6 load testing script
└── LOAD_BALANCING.md   # Scaling & verification guide
```

## Setup Instructions

### Setup with Docker (Recommended)

The system runs as a distributed microservices platform.

```bash
# 1. Start all services
docker-compose up -d --build

# 2. Run database migrations
docker-compose exec backend npm run migrate

# 3. Access the application
# Frontend: http://localhost:3000
# API Gateway: http://localhost:80
```

To demonstrate horizontal scaling:
```bash
docker compose up -d --scale core-api=3 --scale streaming-engine=3
docker restart globalclass-api-gateway-1 # Re-resolve DNS
```

### Option 2: Manual Setup

Refer to [SETUP.md](file:///home/karthik/Desktop/SE/openLecture/globalclass/SETUP.md) for detailed manual configuration of PostgreSQL, Redis, and MinIO.

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | None | Register user |
| POST | `/api/auth/login` | None | Login, get JWT |
| GET | `/api/lectures` | Any | Browse all lectures |
| POST | `/api/lectures` | Instructor | Create lecture |
| PATCH | `/api/lectures/:id/status` | Instructor | Go live / end |
| POST | `/api/lectures/:id/enroll` | Student | Enroll in lecture |
| GET | `/api/lectures/:id/questions` | Any | Get ranked Q&A |
| POST | `/api/lectures/:id/questions` | Any | Submit question |
| POST | `/api/lectures/:id/questions/:qid/vote` | Any | Upvote question |
| PATCH | `/api/lectures/:id/questions/:qid/answer` | Instructor | Mark answered |

## WebSocket Endpoints

| Path | Purpose | Port |
|------|---------|------|
| `ws://localhost/qaws` | Real-time Q&A (Gateway) | 80 |
| `ws://localhost:4000/ws/qa` | Real-time Q&A (Direct) | 4000 |

### Q&A WebSocket Message Types

**Client → Server:**
```json
{ "type": "SUBMIT_QUESTION", "content": "What is ..." }
{ "type": "VOTE", "questionId": "uuid" }
{ "type": "MARK_ANSWERED", "questionId": "uuid" }
```

**Server → Client:**
```json
{ "type": "QUESTIONS_UPDATE", "questions": [...] }
{ "type": "ERROR", "message": "..." }
```

## Design Patterns Demonstrated

- **Strategy Pattern** — `rankingStrategy.js`: pluggable question ranking (by votes, recency, combined)
- **Observer Pattern** — `qaHandler.js`: WebSocket broadcasts ranked updates to all clients in a lecture room

## Individual Contributions

| Member | Contribution |
|--------|-------------|
| Aayush | Q&A system, Redis Pub/Sub, Strategy Pattern |
| Karthik | WebRTC Live Streaming, LiveKit Integration, HLS Tiers |
| Jagadish | Nginx Load Balancing, Docker Orchestration, Fault Tolerance |
| Suresh | Auth Subsystem, Course Catalog, Database Schema |



## Scaling & Load Testing

Detailed instructions for verifying load distribution and horizontal scaling can be found in:
- [LOAD_BALANCING.md](file:///home/karthik/Desktop/SE/openLecture/globalclass/LOAD_BALANCING.md) — Scaling & Fault Tolerance Demo.
- [load_test.js](file:///home/karthik/Desktop/SE/openLecture/globalclass/load_test.js) — k6 script for stress testing.

To run a k6 load test:
```bash
docker run --rm -i --network globalclass_default -v $(pwd)/load_test.js:/load_test.js grafana/k6 run /load_test.js
```

