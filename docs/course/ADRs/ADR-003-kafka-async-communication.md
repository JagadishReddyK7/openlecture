# ADR-003: Kafka for Asynchronous Event-Driven Communication over Synchronous REST

**Date:** 2026-04-13
**Status:** Accepted

---

## Context

In a microservices architecture, services need to communicate with each other when significant events occur. For OpenLecture, several cross-service communication scenarios were identified:

1. When a lecture starts → Notification Service must alert 10,000 enrolled students simultaneously
2. When a student joins/leaves a stream → Analytics Service must record the event
3. When a lecture is created or updated → Notification and Catalog Services must react
4. When a question is answered → Notification Service must alert the student who asked

A critical driver for this decision is **NFR2 (Reliability)**: the system must achieve a **99.9% delivery rate for student question submissions**. No submitted question shall be permanently lost due to a transient service failure. Under synchronous communication, a temporary outage in any downstream service (e.g., the database) during a high-traffic lecture directly causes question loss — violating this requirement.

Two patterns were considered for handling this cross-service communication:

### Option A: Synchronous REST (Direct HTTP Calls)
When an event occurs (e.g., lecture starts), the originating service makes direct HTTP POST calls to each dependent service (Notification Service, Analytics Service, etc.).

- **Problem 1 — Tight coupling:** The Lecture Scheduling Service must know the addresses and APIs of every service it needs to notify. Adding a new consumer requires modifying the publisher.
- **Problem 2 — Cascading failures:** If the Notification Service is slow or down when a lecture starts, the Lecture Scheduling Service's REST call will block or fail — potentially delaying the lecture start or causing an error.
- **Problem 3 — Burst handling:** When a lecture starts, 10,000 students need simultaneous notifications. Synchronous REST calls to 10,000 push endpoints, chained through the Notification Service, cannot be issued instantaneously without overwhelming it.
- **Problem 4 — No replay:** If the Analytics Service is temporarily down during a lecture, all join/leave events during that window are permanently lost.

### Option B (Chosen): Kafka Message Queue (Asynchronous Event-Driven)
Kafka is a distributed, persistent message queue. When an event occurs, the publishing service writes a message to a Kafka topic. All interested consumer services independently read from that topic at their own pace. The publishing service has no knowledge of its consumers.

**Kafka vs. RabbitMQ:** Both were considered. RabbitMQ is a mature message broker well-suited to task queues and lower-volume event routing. Kafka is chosen over RabbitMQ for three specific reasons relevant to GlobalClass:
1. **Log retention and replay:** Kafka retains all messages for a configurable period. If the Analytics Service is down during a lecture, it can replay all missed stream events on recovery — critical for NFR2's no-data-loss guarantee. RabbitMQ deletes messages after acknowledgement and does not natively support replay.
2. **Throughput at scale:** At 10,000 concurrent viewers, stream.events alone could produce thousands of messages per second. Kafka's sequential disk write model handles this more efficiently than RabbitMQ's in-memory queue model.
3. **Consumer group semantics:** Kafka allows each service to maintain its own independent offset, so adding a new consumer (e.g., a future fraud detection service) requires zero changes to existing producers or other consumers.

Key Kafka topics defined for OpenLecture:

| Topic | Publisher | Consumers |
|-------|-----------|-----------|
| `lecture.lifecycle` | Lecture Scheduling Service | Notification Service, Streaming Engine |
| `stream.events` | Lecture Streaming Engine | Analytics Service |
| `enrollment.events` | Course Catalog Service | Notification Service, Analytics Service |
| `qa.events` | Q&A Service | Analytics Service, Notification Service |

---

## Decision

We will use **Apache Kafka** as the asynchronous message bus for all event-driven cross-service communication in OpenLecture.

- Services that generate events (Lecture Scheduling, Streaming Engine, Q&A, Course Catalog) publish to Kafka topics.
- Services that react to events (Notification, Analytics) consume from Kafka topics independently.
- Synchronous REST via the API Gateway is retained only for direct user-facing request-response interactions (e.g., student fetching course list, instructor creating a lecture).
- Kafka consumer groups ensure that each service processes each event exactly once, even when scaled to multiple instances.

---

## Consequences

### Positive
- **Decoupling:** Publishers have no knowledge of consumers. New services can be added as Kafka consumers without modifying any existing service — high extensibility.
- **NFR2 question delivery reliability:** Kafka durably persists Q&A events between the Q&A Service and its consumers. If the database or Analytics Service is temporarily unavailable, no question submission events are lost — they wait in Kafka until the consumer recovers. This directly enables the 99.9% question delivery target (NFR2).
- **Resilience:** If the Notification Service goes down temporarily, Kafka retains all unprocessed messages. When the service recovers, it processes the backlog — no events are lost. This directly supports the 99.5% availability target (NFR4).
- **Burst absorption:** The "lecture starting" notification burst (10,000 alerts at once) is absorbed by Kafka as a queue. The Notification Service processes it at its own throughput rate rather than being hit with 10,000 simultaneous calls.
- **Audit trail:** Kafka retains a configurable history of all events, providing a durable log useful for debugging, replaying analytics, and auditing.
- **Analytics reliability:** Even under load, join/leave events from the Streaming Engine are durably recorded in Kafka and processed by Analytics asynchronously — no data loss during traffic spikes.

### Negative / Trade-offs
- **Eventual consistency:** Because communication is asynchronous, a student who enrolls may not receive their confirmation notification instantly — there will be a short delay while the event propagates through Kafka. This is acceptable for notifications but must be considered for any flows requiring immediate consistency.
- **Operational overhead:** Kafka requires its own cluster to operate reliably (typically 3+ broker nodes for fault tolerance). This adds infrastructure cost and complexity to the prototype and production setup.
- **Not suitable for all communication:** Kafka is inappropriate for request-response patterns (e.g., a student fetching their enrolled courses). Synchronous REST must be maintained alongside Kafka for these cases — two communication patterns must coexist.
- **Message schema management:** As the system evolves, Kafka message schemas must be versioned carefully to avoid breaking consumers when publishers add or change fields.
