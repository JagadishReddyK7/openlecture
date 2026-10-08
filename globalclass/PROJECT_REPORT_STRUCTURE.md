# Project 3 Final Report: GlobalClass
**Team Number:** [Team 43]  
**GitHub Repository:** [Link to your repo]

---

## 1. Introduction
*Briefly describe the problem (large-scale academic streaming) and the high-level solution (GlobalClass).*

## 2. Task 1: Requirements and Subsystems

### 2.1 Functional Requirements
*List the core features (Auth, Course Management, Q&A, Live Streaming).*
*   **FR1:** User Authentication & Role-Based Access Control.
*   **FR2:** Live Lecture Streaming (WebRTC/LL-HLS).

*   **FR3:** Real-time Ranked Q&A System.
*   **Architectural Significance:** Explain how these drive the microservices choice (e.g., streaming and Q&A have different scaling needs).

### 2.2 Non-Functional Requirements (NFRs)
*   **NFR1: Scalability:** Support for 1000+ concurrent students per lecture.
*   **NFR2: Latency:** Sub-second latency for priority students (WebRTC).
*   **NFR3: Fault Tolerance:** System remains functional if the streaming engine fails.

### 2.3 Subsystem Overview
*   **API Gateway (Nginx):** Single entry point, load balancing, and HLS proxying.
*   **Core API Service:** Handles business logic, auth, and Q&A state.
*   **Streaming Engine:** Stateless token generation and egress lifecycle management.
*   **Infrastructure:** PostgreSQL (persistence), Redis (real-time sync), MinIO (HLS origin).

---

## 3. Task 2: Architecture Framework

### 3.1 Stakeholder Identification (IEEE 42010)
*   **Stakeholders:** Students, Instructors, DevOps Engineers, University Admin.
*   **Concerns:** Low latency, system stability under load, ease of deployment.
*   **Viewpoints:** Operational View, Development View, Security View.

### 3.2 Major Design Decisions (ADRs)
*Follow the Nygard template for each:*
*   **ADR-001: Hybrid Streaming (WebRTC + HLS):** Why we chose to tier viewers to save costs/bandwidth.
*   **ADR-002: Microservices Architecture:** Decoupling Q&A from Video Streaming for fault isolation.
*   **ADR-003: Redis Pub/Sub for Q&A Sync:** Solving the distributed WebSocket problem.

---

## 4. Task 3: Architectural Tactics and Patterns

### 4.1 Architectural Tactics
*   **Tactic 1: Load Balancing (Scalability):** Using Nginx `least_conn` to distribute traffic.
*   **Tactic 2: Horizontal Scaling (Performance):** Stateless streaming engine allowed scaling to multiple instances.
*   **Tactic 3: State Externalization (Scalability):** Moving WebSocket state to Redis.
*   **Tactic 4: Fault Isolation (Availability):** Circuit breakers/independent services ensuring Q&A works if video fails.

### 4.2 Implementation Patterns
*   **Pattern 1: Strategy Pattern:** Used in `rankingStrategy.js` for pluggable question sorting.
*   **Pattern 2: Observer Pattern:** Used in `qaHandler.js` to broadcast updates to all students via WebSockets.
*   **Diagrams:** Include the C1/C2/C3 C4 Diagrams created.

---

## 5. Task 4: Prototype Implementation and Analysis

### 5.1 Prototype Development
*Describe the end-to-end flow of the Q&A and Streaming system.*
*   **Core Functionality:** "Real-time Ranked Q&A across a distributed cluster."

### 5.2 Architecture Analysis & Quantification
*   **Comparison:** Compare Microservices vs. Monolith for this use case.
*   **Performance Metrics:**
    *   **NFR 1 (Response Time):** Mention k6 test results (e.g., <50ms for Q&A updates).
    *   **NFR 2 (Concurrency):** Mention maximum stable concurrent users achieved in load tests.
*   **Trade-offs:** Discuss operational complexity vs. scalability/fault tolerance.

---

## 6. Reflections and Lessons Learned
*Add personal/team insights on using WebRTC, Docker scaling, and Nginx.*

## 7. Individual Contributions
| Member | Contribution |
|--------|-------------|
| Aayush | Q&A System, Redis Pub/Sub, Strategy Pattern |
| Karthik | WebRTC Streaming, HLS Tiers, LiveKit Integration |
| Jagadish | Load Balancing, Docker Orchestration, NFR Analysis |
| Suresh | Auth Subsystem, Database Schema, Catalog Service |

---

## Appendices
*   Full API Documentation.
*   Load Testing Scripts and raw results.
