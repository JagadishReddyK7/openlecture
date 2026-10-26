# GlobalClass: Prototype Implementation Roadmap

This plan focuses on implementing a horizontally scalable, ultra-low latency video streaming architecture capable of supporting **10,000 concurrent users** with **0.5–2s latency** and **98% availability**.

---

## 🛠 Project Overview
* **Primary Focus:** WebRTC SFU Cascading, Load Balancing, and Fault Tolerance.
* **Team Division:** * **Me:** Video Engine, Scaling, Load Balancing, and Rate Limiting.
    * **Friend:** Student Interaction Service (Q&A).

---

## 📅 Phase 1: Foundation & The "Origin" (Week 1)
**Goal:** Establish sub-second video ingest from the Lecturer to the server.

- [ ] **1.1 Lecture Session Management**
    - Build a Node.js `Lecture Scheduling Service` to generate unique `lecture_id`s in PostgreSQL.
    - Create an internal API that assigns a specific **Origin Media Node** to a session upon creation.
- [ ] **1.2 WebRTC Ingest (WHIP)**
    - Deploy a Selective Forwarding Unit (SFU) like **LiveKit** or **Janus** as the **Origin Node**.
    - Implement **WHIP (WebRTC-HTTP Ingestion Protocol)** to ensure ingest latency <500ms.
- [ ] **1.3 Lecturer Dashboard**
    - Build a React UI using `navigator.mediaDevices.getUserMedia` for the lecturer to start/stop the stream.

---

## 🚀 Phase 2: Distribution & "Edge" Scaling (Week 2)
**Goal:** Move from a single server to a fleet of nodes to handle 10,000 students via Horizontal Scaling.

- [ ] **2.1 SFU Cascading (Tree Topology)**
    - Dockerize **Edge Media Nodes** and deploy as a cluster.
    - Configure **Cascading**: Edge nodes pull the stream from the Origin Node rather than the Lecturer directly to save origin bandwidth.
- [ ] **2.2 Service Discovery**
    - Implement a **Service Registry** (Consul or Redis-based) where each media node registers its IP, health, and current user count.
    - API Gateway must query this registry to find the least-loaded node for each new student joining.
- [ ] **2.3 API Gateway & Load Balancing**
    - Set up **Nginx** or an **Express Gateway** to distribute student authentication and "Join" requests across microservice replicas.

---

## 🛡️ Phase 3: Resilience & Availability Tactics (Week 3)
**Goal:** Implement protective layers to prevent "Thundering Herds" and ensure 98% uptime.

- [ ] **3.1 Global Rate Limiting**
    - Implement **Redis-backed Fixed Window Rate Limiting** at the API Gateway.
    - Cap "Join Lecture" and "Login" requests to protect the database from 10k-user spikes.
- [ ] **3.2 Simulcast (Adaptive Bitrate)**
    - Configure the Lecturer client to send three quality layers (1080p, 720p, 360p).
    - Ensure Edge Nodes serve the 360p layer to users with weak networks to prevent buffering/drops.
- [ ] **3.3 Health Checks & Failover**
    - Implement a heartbeat mechanism; if an Edge Node crashes, the Gateway must automatically redirect students to a healthy peer.

---

## 🧪 Phase 4: Validation & Task 4 Analysis (Week 4)
**Goal:** Prove the architecture meets NFRs and complete the comparative report.

- [ ] **4.1 Stress Testing (10k Simulation)**
    - Use **Locust** or **JMeter** to simulate 10,000 students hitting the "Join" endpoint.
    - Verify horizontal scaling triggers (e.g., spinning up new containers when CPU > 70%).
- [ ] **4.2 Latency Benchmarking**
    - Measure "Glass-to-Glass" latency (Professor camera to Student screen).
    - Verify target of **0.5s – 2.0s** is maintained under load.
- [ ] **4.3 Comparative Analysis (Task 4 Report)**
    - Compare **Distributed WebRTC SFU** (Your Choice) vs. **Traditional HLS** (Alternative).
    - Quantify trade-offs in **Response Time**, **Throughput**, and **Availability**.

---

## 🔗 Team Integration (Video + Q&A)
- **Shared State:** Use a central **Redis** instance for both Video Session data and Q&A synchronization.
- **Service Isolation:** Ensure the `Lecture Streaming Engine` and `Student Interaction Service` have separate Docker resource limits (Bulkhead Pattern) so a Q&A surge doesn't lag the video.