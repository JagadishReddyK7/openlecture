# ADR-002: Microservices Architecture over Monolithic Architecture

**Date:** 2026-04-13
**Status:** Accepted

---

## Context

OpenLecture must support a diverse set of functionalities — user authentication, course catalog management, lecture scheduling, real-time video streaming, Q&A interaction, notifications, and analytics — each with distinct scalability, availability, and performance characteristics.

Two primary architectural styles were considered for structuring the backend:

### Option A: Monolithic Architecture
All functional modules are packaged and deployed as a single application unit sharing one process, one database, and one deployment pipeline.

- **Advantages:** Simpler to develop initially, easier to debug locally, no network overhead between modules.
- **Problems for OpenLecture:**
  - The Lecture Streaming Engine has drastically different resource needs (high CPU, high network I/O) compared to the Course Catalog (low CPU, high DB reads). Deploying them together forces every component to scale together, even when only one is under load.
  - A bug or crash in one module (e.g., the Analytics module) takes down the entire platform, violating the 99.5% uptime requirement (NFR4) and making the MTTR ≤10 minute target impossible to achieve.
  - Deploying a fix to the Notification Service requires redeploying the entire application — high deployment risk.
  - At 10,000 concurrent users, bottlenecks in one area (e.g., Q&A write storms) cannot be independently scaled without scaling everything.

### Option B (Chosen): Microservices Architecture
Each major functional area is implemented as an independent, separately deployable service that communicates with others via well-defined APIs or an event bus.

Services identified:
- User Management Service
- Course Catalog Service
- Lecture Scheduling Service
- Lecture Streaming Engine
- Student Interaction (Q&A) Service
- Notification Service
- Analytics Service

Each service owns its own data store and is scaled, deployed, and monitored independently.

---

## Decision

We will adopt a **Microservices Architecture** for the OpenLecture backend.

Each service will:
- Be independently deployable via containers (Docker)
- Own its own data store (no shared database between services)
- Communicate synchronously via REST/HTTP through the API Gateway for request-response interactions
- Communicate asynchronously via Kafka for event-driven interactions (e.g., notifications, analytics)
- Be horizontally scalable — multiple instances can be run behind the load balancer

---

## Consequences

### Positive
- **Independent scalability:** The Lecture Streaming Engine can be scaled to 20 instances during a large lecture while the Course Catalog runs on 2 instances — no wasted resources.
- **Fault isolation:** A crash in the Analytics Service does not affect streaming or Q&A. Services can fail independently without cascading failure, directly supporting the 99.5% uptime target (NFR4) and enabling MTTR ≤10 minutes through targeted restarts rather than full-platform recovery.
- **Active-active / active-passive redundancy:** Critical services (Streaming Engine, User Management, Q&A) can be deployed in active-active redundancy configurations. If one instance fails, traffic is automatically routed to healthy instances — directly enabling NFR4's MTTR target.
- **Independent deployment:** Fixes and features can be shipped to individual services without redeploying the entire platform — reducing deployment risk and downtime.
- **Technology flexibility:** Each service can use the most appropriate technology. The Q&A Service uses Redis for write performance; the Catalog Service uses PostgreSQL read replicas — these choices are invisible to other services.
- **Team parallelism:** A team of five can divide ownership of services and develop in parallel without merge conflicts.

### Negative / Trade-offs
- **Operational complexity:** Running, monitoring, and debugging 7+ services is significantly harder than a single application. Requires container orchestration (Docker Compose for prototype; Kubernetes in production).
- **Network overhead:** Inter-service calls introduce latency that would not exist in a monolith. Synchronous REST calls between services add ~1–5ms per hop.
- **Distributed system challenges:** Failures must be handled at the network boundary between services. **Circuit breakers** (e.g., via a service mesh) are required between microservices to prevent a slow or failing downstream service (e.g., the Analytics Service under load) from causing cascading outages across the platform — a pattern explicitly required by NFR4. This adds configuration and monitoring overhead that does not exist in a monolith.
- **Data duplication:** Because services own their own stores, some data (e.g., user IDs referenced in course enrollments) is duplicated across service boundaries, requiring synchronisation strategies.
- **Higher initial setup cost:** More infrastructure to configure upfront compared to starting with a monolith.
