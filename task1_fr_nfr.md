# Task 1: Functional and Non-Functional Requirements

## Introduction

GlobalClass is a distributed classroom platform designed to enable scalable, live lecture streaming across universities. It allows professors from participating institutions to deliver lectures to large global audiences while supporting real-time student interaction. This document identifies and describes the functional and non-functional requirements of the system, and explains their architectural significance.

---

## Functional Requirements

Functional requirements define the specific behaviors and capabilities the system must support. The following requirements are derived from the core and supporting features described in the project proposal.

---

### FR1 – Scalable Live Lecture Streaming

**ID:** FR1 | **Priority:** Critical

**Description**
The system shall support live video streaming of lectures from an instructor to thousands of concurrent students across multiple institutions simultaneously.

**Architectural Significance**
This is the core feature of the platform. It drives the choice of WebRTC for low-latency transport, a microservices architecture for isolation of the streaming subsystem, and load balancing strategies to distribute viewer traffic. Without scalable streaming the platform cannot fulfill its primary purpose.

---

### FR2 – Cross-Institution Course Enrollment

**ID:** FR2 | **Priority:** High

**Description**
The system shall maintain a global course catalog and allow students from any participating institution to browse, enroll in, and access lectures offered by instructors at other institutions.

**Architectural Significance**
Requires a unified identity and authentication model across institutions. Role-based access control (RBAC) must distinguish students, instructors, and administrators from different organizations. A shared relational schema (PostgreSQL) is needed to link users, institutions, courses, and enrollments.

---

### FR3 – User Authentication and Role-Based Access Control

**ID:** FR3 | **Priority:** Critical

**Description**
The system shall authenticate users from multiple institutions and enforce role-based permissions that differentiate students, instructors, and administrators.

**Architectural Significance**
Security is a cross-cutting concern. The authentication subsystem must handle federated identity across institutions. Architectural decisions around JWT tokens, OAuth2/SSO integration, and API gateway enforcement are all driven by this requirement.

---

### FR4 – Real-Time Question Submission and Voting

**ID:** FR4 | **Priority:** High

**Description**
During a live lecture, students shall be able to submit questions and upvote existing questions. The system shall rank and surface the most-voted questions to the instructor in real time.

**Architectural Significance**
Drives the adoption of an event-driven architecture (Node.js with WebSockets) for real-time bidirectional communication. The Strategy Pattern is applied for flexible question-ranking algorithms. This subsystem must remain operational even under peak streaming load, requiring independent deployment.

---

### FR5 – Lecture Recording and Playback

**ID:** FR5 | **Priority:** Medium

**Description**
The system shall record live lectures and make them available for on-demand playback by enrolled students after the session ends.

**Architectural Significance**
Introduces storage and media management concerns. The recording pipeline must be decoupled from the live stream to avoid adding latency. Object storage (e.g., S3-compatible) and a separate playback service are architecturally required.

---

### FR6 – Lecture Participation Analytics

**ID:** FR6 | **Priority:** Medium

**Description**
The system shall collect and display analytics on lecture participation including viewer counts, question activity, and attendance trends, accessible to instructors and administrators via dashboards.

**Architectural Significance**
Analytics data must be aggregated without impacting live stream performance. This motivates a dedicated analytics microservice, use of an event bus (Observer Pattern), and eventual consistency for non-critical metrics.

---

### FR7 – Notifications for Lecture Updates

**ID:** FR7 | **Priority:** Low–Medium

**Description**
The system shall notify enrolled students of upcoming lectures, schedule changes, and newly published recordings via push or email notifications.

**Architectural Significance**
Implements the Observer Pattern. A notification service subscribes to lecture lifecycle events and delivers alerts asynchronously, fully decoupled from core lecture management logic.

---

## Non-Functional Requirements

Non-functional requirements (NFRs) govern the quality attributes of the system. The following NFRs are quantified based on the scale and interaction model of GlobalClass, where peak loads may involve thousands of simultaneous users consuming live video.

---

### NFR1 – Scalability

**Target**
The system shall support a minimum of 10,000 concurrent viewers per live lecture session without degradation in stream quality, Q&A responsiveness, or API response times.

**Rationale**
GlobalClass is specifically designed for high-demand lectures. A university with 5,000 enrolled students supplemented by learners from partner institutions can easily exceed the capacity of traditional videoconferencing tools. Ten thousand concurrent users is therefore a conservative baseline that the architecture must satisfy from day one.

**Architectural Impact**
- Microservices architecture isolates the streaming service so it can be scaled horizontally, independently of other services.
- A Content Delivery Network (CDN) or Selective Forwarding Unit (SFU) relay layer distributes WebRTC streams and reduces origin server load.
- Stateless API services behind a load balancer allow auto-scaling of Node.js instances under surge demand.
- The Factory Pattern supports dynamic provisioning of new lecture session objects and their associated resources at runtime.

---

### NFR2 – Reliability

**Target**
99.9% delivery rate for student question submissions. Stream interruptions must trigger automatic client reconnection within 5 seconds. No submitted question shall be permanently lost due to a transient service failure.

**Rationale**
In a live academic setting students rely on their questions being registered and surfaced to the instructor. Lost interactions erode trust in the platform and discourage participation. Stream drops that affect hundreds of simultaneous viewers must be handled gracefully to minimize disruption.

**Architectural Impact**
- Fault isolation via microservices ensures that a failure in the analytics subsystem does not cascade into the streaming or Q&A subsystems.
- Durable message queuing (e.g., Kafka or RabbitMQ) between the Q&A service and the database protects question submissions during transient failures.
- Client-side reconnection logic and server-side session resumption are first-class concerns in the streaming service design.
- The Repository Pattern abstracts database access, enabling fallback strategies such as write-behind caching when the primary database is briefly unavailable.

---

### NFR3 – Latency

**Target**
- Live video stream end-to-end latency: ≤3 seconds under normal network conditions.
- Q&A interactions (question submission, vote updates visible to all): ≤1 second round-trip.
- Lecture catalog and enrollment API responses: ≤200 ms at the 95th percentile under normal load.

**Rationale**
If the stream lags significantly behind the instructor's speech, students cannot respond to real-time demonstrations, polls, or time-sensitive questions. Sub-second Q&A interaction is essential for the platform to feel live rather than asynchronous.

**Architectural Impact**
- WebRTC is selected over HLS precisely because it achieves sub-3-second latency, whereas adaptive HLS typically introduces 10–30 seconds of delay.
- Edge caching via CDN for static assets and course catalog data reduces perceived API latency for geographically distributed users.
- The Q&A service uses persistent WebSocket connections rather than HTTP polling to achieve sub-second message delivery at scale.
- Database query optimization and indexing on hot-path queries (course lookup, enrollment verification) are required to satisfy the 200 ms API target.

---

### NFR4 – Availability

**Target**
The platform shall maintain ≥99.5% uptime during scheduled lecture hours (measured monthly). Planned maintenance shall occur outside scheduled lecture windows. Mean Time to Recovery (MTTR) from an unplanned outage shall not exceed 10 minutes.

**Rationale**
A live lecture interrupted mid-session cannot simply be restarted without disrupting the instructor and potentially hundreds of students. Unlike asynchronous tools, high availability during scheduled hours is non-negotiable.

**Architectural Impact**
- Active-active or active-passive redundancy for the streaming gateway, authentication service, and Q&A service.
- Automated health monitoring with fast failover reduces MTTR below the 10-minute target.
- PostgreSQL streaming replication with automatic leader election prevents the data tier from becoming a single point of failure.
- Circuit breakers between microservices (e.g., using a service mesh) prevent a failing downstream service from causing cascading outages.

---

### NFR5 – Performance

**Target**
- REST API p95 response time: ≤200 ms under normal load (< 1,000 concurrent users).
- REST API p95 response time: ≤500 ms under peak load (up to 10,000 concurrent users).
- Lecture join time (from button click to first video frame): ≤4 seconds.
- Analytics dashboard Time to Interactive: ≤2 seconds.

**Rationale**
Students and instructors interact with the platform immediately before and during live sessions. Any slowness in the catalog, enrollment, or join flow causes students to miss live content and creates a poor first impression of the platform.

**Architectural Impact**
- In-memory caching (Redis) for frequently read data such as course catalogs, live viewer counts, and enrollment states eliminates redundant database round-trips.
- Connection pooling at the database layer reduces overhead under high-concurrency request bursts.
- Lazy loading of non-critical dashboard components (analytics charts, historical trends) prioritizes Time to Interactive for the lecture join flow.
- Node.js's event-driven, non-blocking I/O model efficiently handles large numbers of lightweight concurrent API requests without thread-per-connection overhead.

---

## Architecturally Significant Requirements: Summary

Not all requirements equally influence architectural decisions. The table below identifies the requirements that most constrain or shape the system architecture and briefly states the primary reason for their significance.

| ID | Requirement | Why Architecturally Significant |
|---|---|---|
| FR1 | Live Lecture Streaming | Forces microservices decomposition, WebRTC adoption, CDN/SFU integration, and horizontal scaling. |
| FR3 | Authentication & RBAC | Cross-cutting security concern; shapes API gateway design, token management, and inter-service authorization. |
| FR4 | Real-Time Q&A | Requires persistent WebSocket connections, event-driven backend, and independent scaling from the stream. |
| NFR1 | Scalability (10K users) | Mandates stateless services, load balancing, CDN relay, and auto-scaling infrastructure. |
| NFR2 | Reliability (99.9% delivery) | Drives message queue adoption, fault isolation patterns, and durable write strategies. |
| NFR3 | Latency (≤3 s stream) | Determines streaming protocol choice (WebRTC over HLS), caching strategy, and database indexing requirements. |
| NFR4 | Availability (99.5% uptime) | Necessitates service redundancy, automated failover, circuit breakers, and replicated database topology. |
| NFR5 | Performance (200 ms API p95) | Requires Redis caching, connection pooling, and query optimization on all hot data paths. |

These eight requirements collectively constrain the most consequential architectural decisions in GlobalClass: the choice of streaming protocol, the microservices decomposition, the database and caching topology, and the fault-tolerance mechanisms. Satisfying them simultaneously requires careful trade-off analysis throughout the design process.
