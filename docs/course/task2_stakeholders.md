# Task 2: Architecture Framework

## Stakeholder Identification (IEEE 42010)

IEEE 42010 defines a system architecture as a set of **architecture descriptions** that address **stakeholder concerns** through **viewpoints** and **views**. This section identifies all relevant stakeholders for the GlobalClass platform, documents their concerns, and maps those concerns to architectural viewpoints and views.

---

## 1. Stakeholders and Their Concerns

A stakeholder is any individual, team, or organization that has an interest in, or is affected by, the system. The following stakeholders have been identified for the GlobalClass platform.

---

### 1.1 Students

**Description:** Learners from participating universities who attend live lectures and interact via Q&A. They may belong to the institution hosting the lecture or to a partner institution.

**Concerns:**
- The live stream must be low-latency (≤3 s) so that interaction with the instructor feels synchronous.
- Questions submitted during a lecture must be reliably delivered and surfaced to the instructor.
- The platform must be accessible from any institution without administrative friction.
- The enrollment and join flow must be fast (join ≤4 s) so that live sessions are not missed.
- Recorded lectures must be available for on-demand playback after the session.
- The interface must be intuitive and responsive across devices and network conditions.

---

### 1.2 Instructors / Professors

**Description:** Faculty members who host and deliver live lectures. They may be affiliated with any participating institution and attract students from across multiple universities.

**Concerns:**
- The streaming infrastructure must handle thousands of concurrent viewers without quality degradation.
- The Q&A panel must surface high-priority questions in real time to facilitate meaningful interaction.
- Participation analytics (viewer counts, question activity, attendance trends) must be available during and after the session.
- The platform must remain available throughout the scheduled lecture window without interruption.
- Lecture recordings must be automatically captured and made available to enrolled students without manual intervention.
- Scheduling and lecture management must be straightforward and integrated with course administration.

---

### 1.3 University Administrators

**Description:** Administrative staff and faculty governance bodies at participating institutions responsible for course offerings, enrollment policies, and institutional compliance.

**Concerns:**
- Enrollment must be controllable per institution and per course, ensuring only authorized students can access content.
- Role-based access control must distinguish institutional boundaries (students, instructors, admins) across organizations.
- Institution-level analytics and attendance records must be accessible for academic compliance reporting.
- Student data handled by the platform must comply with relevant privacy regulations (e.g., FERPA, GDPR).
- Cross-institution partnerships must be configurable without exposing one institution's data to another.

---

### 1.4 Platform Operators / DevOps Engineers

**Description:** The team responsible for deploying, operating, monitoring, and maintaining the GlobalClass infrastructure.

**Concerns:**
- Individual service failures must not cascade into full-system outages (fault isolation).
- The system must support horizontal scaling of the streaming, API, and Q&A services independently.
- Health monitoring and automated failover must keep MTTR under 10 minutes.
- Deployment must be containerized and reproducible across environments.
- Service dependencies (database, message queue, object storage) must be observable through centralized monitoring.
- Load balancing must distribute traffic evenly across service instances during peak demand.

---

### 1.5 Software Architects / Developers

**Description:** The engineering team responsible for designing, implementing, and evolving the GlobalClass system.

**Concerns:**
- The system must be decomposed into independently deployable microservices with clearly defined interfaces.
- Key architectural decisions (streaming protocol, caching strategy, database topology) must be documented and traceable.
- Design patterns (Factory, Repository, Strategy, Observer) must be consistently applied to address recurring structural problems.
- The codebase must be maintainable and extensible to accommodate future requirements (e.g., additional institution integrations).
- Non-functional requirements (latency, scalability, availability) must be verifiable through measurable targets.

---

### 1.6 IT / Infrastructure Teams at Participating Institutions

**Description:** Technical teams at partner universities responsible for network configuration, identity management, and local infrastructure.

**Concerns:**
- The platform must integrate with existing institutional identity providers (SSO/OAuth2) without requiring local infrastructure changes.
- Network policies must not block WebRTC or WebSocket traffic needed for streaming and Q&A.
- Data residency and cross-border data transfer implications must be clearly defined and acceptable per institutional policy.

---

### 1.7 Regulatory and Compliance Bodies

**Description:** External standards bodies and legal frameworks governing the handling of student data, accessibility, and privacy (e.g., FERPA in the US, GDPR in the EU).

**Concerns:**
- Personally identifiable information (PII) of students must be protected in storage and in transit.
- Data retention and deletion policies must be configurable and enforced.
- Audit logs of access and actions must be available for compliance review.
- Accessibility standards (e.g., WCAG 2.1) must be considered in the student-facing interface.

---

## 2. Stakeholder Concerns Summary

| Stakeholder | Primary Concerns |
|---|---|
| Students | Low-latency stream, reliable Q&A delivery, cross-institution access, fast join, on-demand playback |
| Instructors | Scalable viewer support, real-time Q&A ranking, analytics, session reliability, automatic recording |
| University Administrators | Enrollment control, RBAC, compliance reporting, data privacy, institutional isolation |
| Platform Operators | Fault isolation, independent scaling, automated failover, observability, load balancing |
| Architects / Developers | Microservices decomposition, documented decisions, design patterns, maintainability, measurable NFRs |
| Institutional IT Teams | SSO/OAuth2 integration, network compatibility, data residency |
| Regulatory Bodies | PII protection, data retention, audit logs, accessibility compliance |

---

## 3. Architectural Viewpoints

An **architectural viewpoint** defines the conventions for constructing, interpreting, and using an architectural view to address the concerns of specific stakeholders. The following viewpoints are defined for GlobalClass.

---

### Viewpoint 1: Functional Viewpoint

**Stakeholders Addressed:** Students, Instructors, University Administrators

**Concerns Addressed:**
- What core capabilities does the system provide?
- How do users interact with the platform (live streaming, enrollment, Q&A, analytics)?
- How are roles and permissions enforced across institutions?

**Modeling Conventions:** Use Case Diagrams, Component Interaction Diagrams (C4 Level 2), sequence diagrams for key flows (lecture join, question submission).

**Key View Content:**
- Core subsystems: Streaming Engine, Q&A Service, Course Catalog, Authentication Service, Analytics Service, Notification Service.
- Interactions between students and instructors via the live lecture flow.
- RBAC enforcement at the API Gateway for each user role.

---

### Viewpoint 2: Deployment and Infrastructure Viewpoint

**Stakeholders Addressed:** Platform Operators, Architects / Developers, Institutional IT Teams

**Concerns Addressed:**
- How are services deployed and scaled in production?
- How is load distributed across service instances?
- How does the system achieve horizontal scalability to support ≥10,000 concurrent viewers?

**Modeling Conventions:** Deployment Diagrams (C4 Level 4 / UML Deployment), infrastructure topology diagrams.

**Key View Content:**
- Containerized microservices deployed via Docker/Kubernetes.
- An API Gateway with load balancer fronting the Core API and Streaming Engine.
- LiveKit SFU cluster distributing WebRTC media streams, offloading the origin server.
- MinIO/S3-compatible object storage for HLS segment distribution and lecture recordings.
- PostgreSQL with streaming replication for the data tier; Redis for in-memory caching.

---

### Viewpoint 3: Security and Access Control Viewpoint

**Stakeholders Addressed:** University Administrators, Institutional IT Teams, Regulatory Bodies, Students, Instructors

**Concerns Addressed:**
- How are users from multiple institutions authenticated and authorized?
- How is access to lectures and data restricted to authorized parties?
- How is student data protected in transit and at rest?

**Modeling Conventions:** Security architecture diagrams, RBAC matrix, data flow diagrams annotated with trust boundaries.

**Key View Content:**
- JWT-based authentication issued by the Auth Service after login or SSO/OAuth2 federation.
- RBAC enforced at the API Gateway: Student, Instructor, and Administrator roles with scoped permissions.
- TLS encryption on all external and internal service communication.
- Enrollment checks performed before granting access to live or recorded lecture streams.
- Audit logging of authentication events, lecture access, and administrative actions.

---

### Viewpoint 4: Performance and Latency Viewpoint

**Stakeholders Addressed:** Students, Instructors, Architects / Developers, Platform Operators

**Concerns Addressed:**
- How does the system achieve sub-3-second stream latency?
- How is sub-second Q&A round-trip maintained at scale?
- How are API response time targets (p95 ≤200 ms normal, ≤500 ms peak) met?

**Modeling Conventions:** Sequence diagrams annotated with latency budgets, performance benchmarks, protocol comparison charts.

**Key View Content:**
- WebRTC selected over HLS as the primary streaming protocol to achieve ≤3 s end-to-end latency (HLS introduces 10–30 s).
- Persistent WebSocket connections in the Q&A Service for real-time, bidirectional message delivery.
- Redis caching layer for course catalogs, enrollment state, and viewer counts to eliminate redundant database queries.
- CDN edge caching for static assets and HLS segments to reduce latency for geographically distributed users.
- Database indexing on hot-path queries (course lookup, enrollment verification) to satisfy the 200 ms API target.

---

### Viewpoint 5: Reliability and Availability Viewpoint

**Stakeholders Addressed:** Students, Instructors, Platform Operators, University Administrators

**Concerns Addressed:**
- How does the system tolerate partial failures without affecting live lectures?
- How is 99.5% uptime during scheduled lecture hours achieved?
- How is MTTR kept below 10 minutes?
- How are submitted questions protected from loss during transient failures?

**Modeling Conventions:** Fault tree diagrams, failure mode and recovery sequence diagrams, redundancy topology diagrams.

**Key View Content:**
- Microservices fault isolation: a failure in the Analytics Service does not cascade into the Streaming or Q&A Services.
- Durable message queue (Kafka/RabbitMQ) between the Q&A Service and the database to guarantee 99.9% question delivery even during transient database unavailability.
- Client-side automatic reconnection logic (≤5 s) and server-side WebSocket session resumption in the Streaming Engine.
- Active-passive redundancy for the Streaming Gateway and Authentication Service.
- PostgreSQL streaming replication with automatic leader election to eliminate the database as a single point of failure.
- Circuit breakers between microservices to prevent cascading failures under partial degradation.
- Automated health checks and fast failover to keep MTTR under 10 minutes.

---

## 4. Viewpoints-to-Concerns Mapping

| Viewpoint | Primary Stakeholders | Concerns Addressed |
|---|---|---|
| Functional | Students, Instructors, Admins | Core capabilities, user interactions, enrollment, RBAC, Q&A, analytics |
| Deployment & Infrastructure | Operators, Architects, IT Teams | Horizontal scaling, load balancing, containerization, CDN, object storage |
| Security & Access Control | Admins, IT Teams, Regulators, Students | Authentication, RBAC, data protection, audit logging, SSO integration |
| Performance & Latency | Students, Instructors, Architects | Sub-3 s stream, sub-1 s Q&A, API p95 targets, caching, protocol selection |
| Reliability & Availability | Students, Instructors, Operators, Admins | Fault isolation, 99.5% uptime, MTTR ≤10 min, durable Q&A delivery, failover |
