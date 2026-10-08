
// RUN LOAD TEST 
// docker run --rm -i --network globalclass_default -v $(pwd)/load_test.js:/load_test.js grafana/k6 run /load_test.js  2>&1



// =============================================================================
// GlobalClass — K6 Load Test Script
// =============================================================================
// Simulates concurrent students joining a live lecture via the Nginx API
// gateway, fetching HLS manifests, and downloading video segments.
//
// USAGE (run from project root):
//   docker run --rm -i \
//     --network globalclass_default \
//     -v $(pwd)/load_test.js:/load_test.js \
//     grafana/k6 run /load_test.js
//
// SMOKE TEST (5 users, 30 seconds):
//   docker run --rm -i \
//     --network globalclass_default \
//     -v $(pwd)/load_test.js:/load_test.js \
//     grafana/k6 run /load_test.js \
//     --env SMOKE=true
// =============================================================================

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { SharedArray } from 'k6/data';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
// Inside Docker network, use the service name from docker-compose.yml
// NOT "localhost" — that would point to the k6 container itself.
const BASE_URL = 'http://api-gateway';

const SMOKE = __ENV.SMOKE === 'true';
// Only need 50 unique student tokens — VUs reuse them via modulo (__VU % 50)
const NUM_STUDENTS = SMOKE ? 5 : 50;

// ---------------------------------------------------------------------------
// Custom Metrics
// ---------------------------------------------------------------------------
const joinLatency = new Trend('join_latency', true);
const segmentLatency = new Trend('segment_download_latency', true);
const manifestLatency = new Trend('manifest_fetch_latency', true);
const loginLatency = new Trend('login_latency', true);
const joinErrors = new Counter('join_errors');
const segmentErrors = new Counter('segment_errors');
const hlsViewers = new Counter('hls_tier_viewers');
const webrtcViewers = new Counter('webrtc_tier_viewers');
const earlyStopRate = new Rate('early_stop_rate');

// ---------------------------------------------------------------------------
// Test Stages — ramp-up → steady → peak → ramp-down
// ---------------------------------------------------------------------------
export const options = SMOKE
  ? { vus: 5, duration: '30s', setupTimeout: '60s' }
  : {
    setupTimeout: '120s',  // Student registration takes time
    stages: [
      { duration: '1m', target: 50 },   // Ramp-up
      { duration: '2m', target: 200 },  // Ramp to peak
      { duration: '2m', target: 200 },  // Sustain peak
      { duration: '1m', target: 0 },    // Ramp-down
    ],
    thresholds: {
      http_req_duration: ['p(95)<500'],   // 95th percentile < 500ms
      http_req_failed: ['rate<0.10'],   // < 10% errors overall
      join_latency: ['p(95)<1000'],  // Join should be < 1s
      segment_download_latency: ['p(95)<2000'],  // Segment download < 2s
    },
  };

// ---------------------------------------------------------------------------
// Setup — runs ONCE before all VUs start
// ---------------------------------------------------------------------------
// Creates an instructor, a lecture, starts the stream, and registers students.
// Returns shared data that all VUs can read.
// ---------------------------------------------------------------------------
export function setup() {
  console.log(`\n🚀 Setup: creating test users and lecture...\n`);
  const timestamp = Date.now();

  // 1. Register instructor ------------------------------------------------
  const instructorEmail = `loadtest_instructor_${timestamp}@test.com`;
  const instructorPass = 'TestPassword123!';

  let res = http.post(`${BASE_URL}/api/auth/register`, JSON.stringify({
    name: 'LoadTest Instructor',
    email: instructorEmail,
    password: instructorPass,
    role: 'instructor',
    institution: 'Load Test University',
  }), { headers: { 'Content-Type': 'application/json' } });

  check(res, { 'instructor registered': (r) => r.status === 201 || r.status === 400 });

  // 2. Login instructor ---------------------------------------------------
  res = http.post(`${BASE_URL}/api/auth/login`, JSON.stringify({
    email: instructorEmail,
    password: instructorPass,
  }), { headers: { 'Content-Type': 'application/json' } });

  check(res, { 'instructor logged in': (r) => r.status === 200 });

  let instructorData;
  try { instructorData = res.json(); } catch (e) {
    console.error(`❌ Instructor login failed: ${res.status} ${res.body}`);
    return { error: true };
  }
  const instructorToken = instructorData.token;

  // 3. Create a test lecture ----------------------------------------------
  const scheduledAt = new Date(Date.now() + 3600000).toISOString();
  res = http.post(`${BASE_URL}/api/lectures`, JSON.stringify({
    title: `Load Test Lecture ${timestamp}`,
    description: 'Automated load test lecture',
    scheduled_at: scheduledAt,
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${instructorToken}`,
    },
  });

  check(res, { 'lecture created': (r) => r.status === 201 });
  let lectureData;
  try { lectureData = res.json(); } catch (e) {
    console.error(`❌ Lecture creation failed: ${res.status} ${res.body}`);
    return { error: true };
  }
  const lectureId = lectureData.id;
  console.log(`📚 Lecture created: ${lectureId}`);

  // 4. Start stream (via streaming-engine) --------------------------------
  res = http.post(`${BASE_URL}/api/stream/start/${lectureId}`, null, {
    headers: { 'Authorization': `Bearer ${instructorToken}` },
  });

  check(res, { 'stream started': (r) => r.status === 200 });
  let streamData;
  try { streamData = res.json(); } catch (e) {
    console.warn(`⚠️  Stream start response: ${res.status} ${res.body}`);
  }
  console.log(`🎬 Stream started. HLS URL: ${streamData?.hlsUrl || 'N/A'}`);

  // 5. Register test students in batches -----------------------------------
  // Batch registration to avoid setup timeout.
  // 200 VUs share 50 tokens via modulo — no need to register one per VU.
  const students = [];
  const BATCH_SIZE = 10;
  const password = 'StudentPass123!';

  for (let batch = 0; batch < NUM_STUDENTS; batch += BATCH_SIZE) {
    const batchEnd = Math.min(batch + BATCH_SIZE, NUM_STUDENTS);

    // Register the batch
    const regRequests = [];
    for (let i = batch; i < batchEnd; i++) {
      regRequests.push([
        'POST',
        `${BASE_URL}/api/auth/register`,
        JSON.stringify({
          name: `Student ${i}`,
          email: `loadtest_student_${timestamp}_${i}@test.com`,
          password,
          role: 'student',
          institution: 'Load Test University',
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ]);
    }
    http.batch(regRequests);

    // Login the batch to collect tokens
    const loginRequests = [];
    for (let i = batch; i < batchEnd; i++) {
      loginRequests.push([
        'POST',
        `${BASE_URL}/api/auth/login`,
        JSON.stringify({
          email: `loadtest_student_${timestamp}_${i}@test.com`,
          password,
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ]);
    }
    const loginResponses = http.batch(loginRequests);

    for (const lr of loginResponses) {
      try {
        const token = lr.json().token;
        if (token) students.push({ token });
      } catch (e) { /* skip failed logins */ }
    }
  }
  console.log(`👥 Registered ${students.length} test students\n`);

  return {
    lectureId,
    instructorToken,
    hlsUrl: streamData?.hlsUrl || null,
    students,
  };
}

// ---------------------------------------------------------------------------
// Default VU Function — each virtual user runs this in a loop
// ---------------------------------------------------------------------------
export default function (data) {
  if (data.error) {
    console.error('Setup failed — skipping iteration');
    sleep(1);
    return;
  }

  // Pick a student identity based on VU number (wraps around)
  const studentIdx = (__VU - 1) % data.students.length;
  const student = data.students[studentIdx];
  if (!student) { sleep(1); return; }

  const headers = {
    'Authorization': `Bearer ${student.token}`,
    'Content-Type': 'application/json',
  };

  // ── Step 1: Health check (quick sanity) ─────────────────────────────
  group('Health Check', () => {
    const res = http.get(`${BASE_URL}/health/core`);
    check(res, { 'core-api healthy': (r) => r.status === 200 });
  });

  // ── Step 2: Join the live lecture ───────────────────────────────────
  let joinRes;
  group('Join Stream', () => {
    joinRes = http.post(
      `${BASE_URL}/api/stream/join/${data.lectureId}`,
      null,
      { headers, tags: { name: 'stream_join' } }
    );

    joinLatency.add(joinRes.timings.duration);

    const joinOk = check(joinRes, {
      'join status 200': (r) => r.status === 200,
      'has viewer tier': (r) => {
        try { return !!r.json().viewerTier; } catch { return false; }
      },
    });

    if (!joinOk) {
      joinErrors.add(1);
      console.warn(`VU${__VU}: Join failed — ${joinRes.status} ${joinRes.body}`);
    }
  });

  // Parse join response
  let joinData;
  try { joinData = joinRes.json(); } catch (e) {
    sleep(2);
    return; // Can't continue without join data
  }

  // Track tier distribution
  if (joinData.viewerTier === 'hls') {
    hlsViewers.add(1);
  } else {
    webrtcViewers.add(1);
  }

  // ── Step 3: Simulate viewing behavior ──────────────────────────────
  const behavior = Math.random();
  const isEarlyStopper = behavior < 0.2;   // 20% leave early
  const isSeeker = behavior >= 0.2 && behavior < 0.3;  // 10% seek

  earlyStopRate.add(isEarlyStopper ? 1 : 0);

  group('Stream Viewing', () => {
    if (joinData.viewerTier === 'hls' && joinData.hlsUrl) {
      // ── HLS Tier: Fetch manifest + segments ──────────────────────
      simulateHLSViewing(data, joinData, headers, isEarlyStopper, isSeeker);
    } else {
      // ── WebRTC Tier: Simulate token-based session ────────────────
      // k6 can't do real WebRTC, so we simulate the API calls a
      // WebRTC client would make (join, periodic status polls).
      simulateWebRTCSession(data, joinData, headers, isEarlyStopper);
    }
  });

  // ── Step 4: Simulate quality switch (10% of users) ─────────────────
  if (Math.random() < 0.1) {
    group('Quality Switch', () => {
      // Poll HLS status to simulate a quality change lookup
      const res = http.get(
        `${BASE_URL}/api/stream/hls-status/${data.lectureId}`,
        { headers, tags: { name: 'hls_status_poll' } }
      );
      check(res, { 'hls-status ok': (r) => r.status === 200 });
    });
  }

  // ── Step 5: Browse lecture catalog (realistic mixed traffic) ────────
  if (Math.random() < 0.3) {
    group('Browse Catalog', () => {
      const res = http.get(`${BASE_URL}/api/lectures`, {
        headers, tags: { name: 'lectures_list' },
      });
      check(res, { 'catalog loaded': (r) => r.status === 200 });
    });
  }

  // Small gap between iterations
  sleep(Math.random() * 2 + 1); // 1-3 seconds
}

// ---------------------------------------------------------------------------
// HLS Viewing Simulation
// ---------------------------------------------------------------------------
function simulateHLSViewing(data, joinData, headers, isEarlyStopper, isSeeker) {
  // Fetch the HLS manifest
  // The hlsUrl from the join response is the full URL to the m3u8 manifest.
  // We need to proxy it through Nginx at /hls/...
  const hlsPath = joinData.hlsUrl || `/hls/${data.lectureId}/index.m3u8`;

  // Determine if this is a full URL or relative path
  const manifestUrl = hlsPath.startsWith('http')
    ? hlsPath.replace(/http:\/\/[^/]+/, BASE_URL) // Rewrite to go through gateway
    : `${BASE_URL}${hlsPath}`;

  const manifestRes = http.get(manifestUrl, {
    headers,
    tags: { name: 'hls_manifest' },
  });

  manifestLatency.add(manifestRes.timings.duration);

  const manifestOk = check(manifestRes, {
    'manifest status 200': (r) => r.status === 200,
    'manifest has content': (r) => r.body && r.body.length > 0,
  });

  if (!manifestOk) {
    // HLS might not be available yet — that's useful data too
    sleep(2);
    return;
  }

  // Parse .m3u8 for segment files (.ts or .m4s)
  const body = manifestRes.body || '';
  const segmentLines = body.split('\n').filter(
    (line) => line.trim() && !line.startsWith('#')
  );

  if (segmentLines.length === 0) {
    // Might be a master playlist pointing to variant playlists
    const variantMatch = body.match(/^[^#\s].*\.m3u8$/m);
    if (variantMatch) {
      // Fetch the variant playlist
      const variantUrl = `${manifestUrl.replace(/[^/]+\.m3u8$/, '')}${variantMatch[0]}`;
      const variantRes = http.get(variantUrl, {
        headers,
        tags: { name: 'hls_variant' },
      });
      check(variantRes, { 'variant playlist loaded': (r) => r.status === 200 });
    }
    sleep(2);
    return;
  }

  // Determine how many segments to download
  let startSegment = 0;
  let segCount = segmentLines.length;

  if (isEarlyStopper) {
    segCount = Math.min(Math.floor(Math.random() * 3) + 1, segmentLines.length);
  }
  if (isSeeker) {
    startSegment = Math.floor(segmentLines.length / 2);
    segCount = Math.min(segCount, segmentLines.length - startSegment);
  }

  // Download segments sequentially (simulates real playback)
  const baseSegmentUrl = manifestUrl.replace(/[^/]+$/, '');
  for (let i = startSegment; i < startSegment + segCount && i < segmentLines.length; i++) {
    const segmentFile = segmentLines[i].trim();
    const segmentUrl = segmentFile.startsWith('http')
      ? segmentFile
      : `${baseSegmentUrl}${segmentFile}`;

    const segRes = http.get(segmentUrl, {
      headers,
      tags: { name: 'hls_segment' },
      responseType: 'binary', // Don't try to parse video as text
    });

    segmentLatency.add(segRes.timings.duration);

    const segOk = check(segRes, {
      'segment downloaded': (r) => r.status === 200,
    });

    if (!segOk) segmentErrors.add(1);

    // Simulate playback timing — HLS segments are typically 2-6 seconds
    sleep(Math.random() * 3 + 2); // 2-5 second playback delay
  }
}

// ---------------------------------------------------------------------------
// WebRTC Session Simulation
// ---------------------------------------------------------------------------
// k6 cannot establish real WebRTC connections, so we simulate the HTTP
// interactions a WebRTC client would make during a session.
function simulateWebRTCSession(data, joinData, headers, isEarlyStopper) {
  // WebRTC client would have received a LiveKit token from the join response.
  // It would then connect to the LiveKit server directly (not through Nginx).
  // Here we simulate the ancillary HTTP traffic:

  const sessionDuration = isEarlyStopper
    ? Math.floor(Math.random() * 10) + 5   // 5-15 seconds
    : Math.floor(Math.random() * 30) + 20; // 20-50 seconds

  const pollInterval = 5; // seconds between status polls
  const numPolls = Math.floor(sessionDuration / pollInterval);

  for (let i = 0; i < numPolls; i++) {
    // Poll HLS status (WebRTC clients poll this as a fallback check)
    const res = http.get(
      `${BASE_URL}/api/stream/hls-status/${data.lectureId}`,
      { headers, tags: { name: 'webrtc_status_poll' } }
    );

    check(res, { 'status poll ok': (r) => r.status === 200 });

    sleep(pollInterval);
  }
}

// ---------------------------------------------------------------------------
// Teardown — runs ONCE after all VUs finish
// ---------------------------------------------------------------------------
export function teardown(data) {
  if (data.error) return;

  console.log(`\n🧹 Teardown: ending stream for lecture ${data.lectureId}...\n`);

  // End the stream
  const res = http.post(
    `${BASE_URL}/api/stream/end/${data.lectureId}`,
    null,
    { headers: { 'Authorization': `Bearer ${data.instructorToken}` } }
  );

  check(res, { 'stream ended': (r) => r.status === 200 });

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  📊  Load Test Complete                                      ║
║                                                              ║
║  Lecture ID : ${data.lectureId}            ║
║  Students   : ${data.students.length}                                          ║
║                                                              ║
║  MONITORING TIPS:                                            ║
║  • docker stats           — live CPU/memory per container    ║
║  • docker logs -f <svc>   — watch for errors in real time    ║
║                                                              ║
║  BOTTLENECK IDENTIFICATION:                                  ║
║  • High join_latency p95  → streaming-engine or PostgreSQL   ║
║  • High segment_latency   → MinIO or Nginx                   ║
║  • Many join_errors       → Node.js connection pool exhaust  ║
║  • http_req_failed > 10%  → Nginx worker_connections limit   ║
╚══════════════════════════════════════════════════════════════╝
`);
}

// =============================================================================
// DOCKER COMMANDS REFERENCE
// =============================================================================
//
// FULL LOAD TEST:
//   docker run --rm -i \
//     --network globalclass_default \
//     -v $(pwd)/load_test.js:/load_test.js \
//     grafana/k6 run /load_test.js
//
// SMOKE TEST (5 VUs, 30s):
//   docker run --rm -i \
//     --network globalclass_default \
//     -v $(pwd)/load_test.js:/load_test.js \
//     grafana/k6 run /load_test.js --env SMOKE=true
//
// MONITOR DOCKER CONTAINERS DURING TEST:
//   docker stats --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}"
//
// WATCH LOGS:
//   docker compose logs -f core-api streaming-engine api-gateway
//
// =============================================================================