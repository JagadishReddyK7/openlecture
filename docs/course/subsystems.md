# OpenLecture — Subsystem Overview

**Project:** OpenLecture: A Distributed Platform for Global Academic Lectures
**Course:** S26CS6.401 - Software Engineering
**Team:** 43

---

## Summary Table

| # | Subsystem | Primary Actor |
|---|-----------|--------------|
| 1 | API Gateway & Load Balancer | System |
| 2 | User Management Service | All users |
| 3 | Course Catalog Service | Students, Admins |
| 4 | Lecture Scheduling Service | Instructors |
| 5 | Lecture Streaming Engine | Instructors, Students |
| 6 | Student Interaction (Q&A) Service | Students, Instructors |
| 7 | Notification Service | All users |
| 8 | Analytics Service | Admins |
| 9 | Data & Storage Layer | System |
| 10 | Frontend (Web Client) | All users |

---

## Subsystem Descriptions

### 1. API Gateway & Load Balancer

**Primary Actor:** System

The API Gateway acts as the single entry point for all client requests entering the platform. It is responsible for routing each incoming request to the appropriate microservice, distributing traffic evenly across multiple service instances through load balancing, and enforcing rate limits to prevent abuse during high-traffic lecture sessions. It also handles SSL/TLS termination and performs continuous health checks on downstream services. At a scale of 10,000 concurrent users, this subsystem is critical — without it, no single backend service could absorb the full connection load.

---

### 2. User Management Service

**Primary Actor:** All users (Students, Instructors, Admins)

The User Management Service handles all aspects of identity across the platform. It manages user registration, login, and profile management for students, instructors, and administrators from multiple universities. It enforces Role-Based Access Control (RBAC) to ensure that only authorized users can perform specific actions — for example, only instructors can create lectures. The service also supports cross-institution identity federation using OAuth2 and SAML protocols, enabling students to log in with their university credentials. Session tokens are cached in Redis to allow fast authentication checks without hitting the database on every request.

---

### 3. Course Catalog Service

**Primary Actor:** Students, Admins

The Course Catalog Service maintains a unified, searchable directory of all courses and lectures offered across participating universities. Students can browse, search, and filter courses by institution, topic, or instructor, and enroll in lectures from universities other than their own. The service enforces enrollment eligibility rules and manages seat limits per lecture. Since catalog browsing is a read-heavy operation — especially when thousands of students are searching simultaneously — the service relies on a PostgreSQL read replica and a Redis cache layer to serve requests quickly without overloading the primary database.

---

### 4. Lecture Scheduling Service

**Primary Actor:** Instructors

The Lecture Scheduling Service manages the full lifecycle of a lecture from creation to completion. Instructors use this service to create, schedule, update, and cancel lectures. When a lecture is created or its status changes, the service publishes events (such as `lecture.created` or `lecture.started`) to the Kafka message queue, which other services — such as the Notification Service and the Streaming Engine — consume to take appropriate action. This event-driven decoupling ensures that scheduling activity does not directly impact the performance of the streaming or notification pipelines.

---

### 5. Lecture Streaming Engine

**Primary Actor:** Instructors, Students

The Lecture Streaming Engine is the core subsystem of the platform, responsible for real-time video delivery from instructors to large student audiences. The instructor's video is ingested via WebRTC into a Selective Forwarding Unit (SFU) cluster (e.g., mediasoup or Janus), which handles low-latency distribution to the first segment of viewers. For larger audiences, the stream is transcoded and distributed as Low-Latency HLS (LL-HLS) segments via a CDN, enabling delivery to up to 10,000 concurrent viewers. The client adaptively selects between WebRTC (sub-second latency) and LL-HLS (~2–3 seconds latency) based on session load. The engine also records all streams and stores them in object storage for on-demand playback.

---

### 6. Student Interaction (Q&A) Service

**Primary Actor:** Students, Instructors

The Student Interaction Service enables real-time engagement between students and instructors during a live lecture. Students submit questions through persistent WebSocket connections, and other students can upvote or downvote questions to surface the most relevant ones. A ranking strategy (Strategy Pattern) determines the order in which questions are shown to the instructor. To handle bursts of simultaneous submissions from thousands of students, active question queues are stored in Redis for fast read/write access, while data is asynchronously persisted to PostgreSQL. Instructors can mark questions as answered, and the updated state is broadcast in real time to all connected students.

---

### 7. Notification Service

**Primary Actor:** All users

The Notification Service is responsible for delivering timely alerts and updates to all platform users. It operates as a Kafka consumer, listening for events published by other services — such as `lecture.starting`, `enrollment.confirmed`, or `question.answered` — and dispatches the corresponding notifications via push notifications, in-app alerts, or email. By consuming from Kafka rather than receiving direct API calls, the Notification Service is fully decoupled from the rest of the system. This means that even during a high-traffic lecture with 10,000 simultaneous "lecture starting" alerts, the notification burst does not degrade the streaming or Q&A subsystems.

---

### 8. Analytics Service

**Primary Actor:** Admins

The Analytics Service collects and processes usage data to provide administrators with insights into platform activity and system performance. It consumes events from Kafka — such as student join/leave events, question submissions, and vote activity — and aggregates them into real-time and historical metrics. Admins can view dashboards showing live attendance counts, viewer drop-off rates, Q&A participation, and per-lecture engagement statistics. Because all analytics processing happens asynchronously via Kafka, this subsystem operates entirely off the critical path and never introduces latency into the streaming or interaction experience.

---

### 9. Data & Storage Layer

**Primary Actor:** System

The Data & Storage Layer is the persistence backbone that all other services depend on. It is composed of multiple components optimized for different access patterns:

| Component | Purpose |
|-----------|---------|
| **PostgreSQL (Primary)** | Handles all write operations — users, enrollments, lecture metadata, Q&A history |
| **PostgreSQL (Read Replicas)** | Serves read-heavy queries from the Course Catalog and Analytics services |
| **PgBouncer (Connection Pooler)** | Manages the database connection pool, essential at 10,000 concurrent users where raw connections would exhaust PostgreSQL's limit |
| **Redis** | Provides sub-millisecond access for session tokens, active Q&A queues, and frequently accessed hot data |
| **Media & Recording Storage (S3-compatible)** | Stores recorded lecture videos and LL-HLS stream segments, served to students via CDN |

This layered approach ensures that no single storage component becomes a bottleneck under high concurrency.

---

### 10. Frontend (Web Client)

**Primary Actor:** All users (Students, Instructors, Admins)

The Frontend is the React-based web application through which all users interact with the platform. It provides a live lecture dashboard with an embedded adaptive video player that switches between WebRTC and LL-HLS depending on session load. Students can browse the course catalog, enroll in lectures, join live streams, and participate in the Q&A panel — all through a single responsive interface. Instructors access lecture management tools to create and broadcast sessions. Administrators use a dedicated analytics dashboard to monitor system usage. The frontend communicates with all backend services exclusively through the API Gateway.

---

## Architecture Overview

```
        [Web Clients: Students / Instructors / Admins]
                          |
              [API Gateway + Load Balancer]
                          |
    +-----------+---------+---------+-----------+
    |           |                   |           |
[User Mgmt] [Course Catalog] [Lecture Scheduling] ...
 + Redis      + Read Replica    --> Kafka events
 (sessions)   + Redis cache            |
                               [Kafka Message Queue]
                                |         |
                        [Notification] [Analytics]

[Lecture Streaming Engine]
  Instructor --> WebRTC --> SFU Cluster
                                |
                       Transcoder --> LL-HLS --> CDN --> Students
                                |
                       Media & Recording Storage (S3)

[Student Interaction (Q&A)]
  WebSocket --> Redis (hot queue) --> PostgreSQL (async)

              [Data & Storage Layer]
    PostgreSQL Primary + Read Replicas + PgBouncer
    Redis + S3 Object Storage
```
