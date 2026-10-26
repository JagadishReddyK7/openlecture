// Prometheus metrics for streaming-engine (GET /metrics on port 4001).
// Served per instance on its own port; nginx does not route /metrics.
import os from 'os';
import client from 'prom-client';

export const register = new client.Registry();
register.setDefaultLabels({ instance_id: os.hostname() });
client.collectDefaultMetrics({ register });   // CPU, memory, event-loop lag, GC

export const joinDuration = new client.Histogram({
  name: 'stream_join_duration_seconds',
  help: 'POST /api/stream/join, by outcome',
  labelNames: ['outcome'],   // webrtc | hls | not_live | not_enrolled | error
  buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

export const tierAssignments = new client.Counter({
  name: 'stream_tier_assignments_total',
  help: 'Viewers given each delivery tier (ADR-001)',
  labelNames: ['tier'],      // webrtc | hls
  registers: [register],
});

export async function metricsHandler(req, res) {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}
