# ADR-001: Hybrid Streaming Architecture — WebRTC SFU + LL-HLS over Pure WebRTC

**Date:** 2026-04-13
**Status:** Accepted

---

## Context

The core requirement of OpenLecture is to deliver live lecture streams to up to **10,000 concurrent students** with an end-to-end latency of **≤3 seconds** (NFR3) and Q&A interactions with a round-trip of **≤1 second** (NFR3). Additionally, NFR2 requires stream interruptions to trigger automatic client reconnection within **≤5 seconds**. The choice of streaming technology is the most consequential architectural decision in the system.

Four candidate approaches were evaluated:

### Option A: Pure Peer-to-Peer WebRTC (Mesh)
In a mesh topology, each viewer maintains a direct connection to the instructor and to other peers. This delivers sub-second latency natively.

- **Problem:** Each additional viewer adds upload bandwidth load on the instructor's connection. With 10,000 viewers, the instructor would need to upload 10,000 simultaneous streams — completely infeasible.
- **Max practical scale:** ~5–10 viewers.

### Option B: Pure WebRTC with SFU (Selective Forwarding Unit)
A SFU (e.g., mediasoup, Janus) receives one stream from the instructor and forwards it to all viewers. The instructor uploads once; the SFU replicates.

- **Latency:** Sub-second (0.3–0.8s) — comfortably meets the ≤3s requirement.
- **Problem:** A single SFU node can handle approximately 300–500 concurrent viewers before CPU and memory are saturated. Scaling to 10,000 requires a very large, expensive SFU cluster. The issue here is **scale**, not latency — the latency target is met, but infrastructure cost becomes prohibitive at this audience size.

### Option C: Standard HLS / DASH via CDN
HLS and DASH are the industry standard for large-scale video delivery and scale trivially to millions of viewers via CDN.

- **Scale:** Millions of concurrent viewers — far exceeds the requirement.
- **Problem:** Standard HLS has a latency of **6–30 seconds** due to segment buffering. DASH is similar. Neither meets the ≤3s stream latency requirement (NFR3). WebRTC is selected over standard HLS precisely because it achieves sub-3-second latency, whereas adaptive HLS typically introduces 10–30 seconds of delay.

### Option D (Chosen): Hybrid WebRTC SFU + Low-Latency HLS (LL-HLS) via CDN
LL-HLS (Low-Latency HLS, RFC 8216bis) reduces segment sizes and uses HTTP/2 push to bring latency down to **2–3 seconds**, which is within the ≤3s target. Combined with WebRTC SFU for ingestion and priority viewers, a hybrid architecture achieves both scale and the latency target:

- The instructor publishes via **WebRTC** into an **SFU cluster**.
- The SFU serves up to ~500 priority viewers (e.g., active Q&A participants) at sub-second latency via WebRTC.
- Simultaneously, a **transcoder** converts the SFU output to LL-HLS segments.
- LL-HLS segments are distributed via a **CDN** to the bulk audience at ~2–3s latency — within the ≤3s NFR3 target.
- The **client adapts** — it uses WebRTC when placed in the priority tier, and LL-HLS otherwise.
- Client-side reconnection logic handles NFR2's ≤5s auto-reconnect requirement for stream interruptions.

---

## Decision

We will adopt a **Hybrid WebRTC SFU + LL-HLS via CDN** streaming architecture for the Lecture Streaming Engine.

- **Instructor ingestion:** WebRTC → SFU cluster (mediasoup)
- **Priority viewers (≤500):** WebRTC forwarded directly from SFU — sub-second latency
- **Bulk audience (up to 10,000):** SFU output transcoded → LL-HLS → CDN edge nodes — ~2–3s latency
- **Client:** Adaptive player switches between WebRTC and LL-HLS based on session tier assignment
- **Recording:** The transcoder pipeline also writes HLS segments to object storage (S3-compatible) for on-demand playback

---

## Consequences

### Positive
- **Scales to 10,000 concurrent viewers** without overloading the instructor's connection or a single server.
- **Both tiers meet the latency target** — priority users get sub-second latency; the bulk audience gets ~2–3s. Both are within the NFR3 ≤3s requirement. Standard HLS (6–30s) is ruled out entirely.
- **CDN absorbs traffic spikes** — sudden surges in viewers are handled by CDN edge nodes, not the origin server.
- **Recording is a natural byproduct** — the LL-HLS transcoder pipeline already produces stored segments usable for playback.
- **Fault tolerance** — if the SFU cluster degrades, bulk viewers on LL-HLS are unaffected; the CDN continues serving segments.

### Negative / Trade-offs
- **Increased architectural complexity** — two streaming paths (WebRTC and LL-HLS) must be maintained, monitored, and kept in sync.
- **Latency is not uniform** — priority-tier viewers get <1s, while the bulk audience gets ~2–3s. Both satisfy NFR3's ≤3s target, but the difference must be communicated to users clearly so bulk viewers do not expect sub-second responsiveness.
- **Auto-reconnect complexity** — NFR2 requires stream interruptions to recover within ≤5 seconds. Both the WebRTC and LL-HLS paths require independent client-side reconnection logic, increasing client implementation complexity.
- **Transcoding cost** — running a real-time transcoder (e.g., FFmpeg pipeline) between the SFU and LL-HLS output adds CPU cost and a small latency overhead (~0.5s).
- **Client complexity** — the adaptive player must handle both WebRTC and LL-HLS protocols and switch cleanly between them.
- **SFU cluster management** — horizontal scaling of SFU nodes requires a session routing layer to direct viewers to the correct SFU instance.
