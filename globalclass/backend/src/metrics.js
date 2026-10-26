// Prometheus metrics for core-api (GET /metrics on port 4000).
//
// /metrics is served by each instance on its own port and is NOT routed by
// nginx, so it is reachable inside the Docker network (Prometheus finds every
// replica through Docker DNS) but not from outside.
//
// The Q&A metrics are the ones that explain the load-test results:
//   qa_mutations_total vs qa_broadcasts_total  -> coalescing (P2a): mutations
//     grow with voting, broadcasts stay at <= 4/s per lecture
//   qa_broadcast_payload_bytes                 -> bounding (P2b)
//   qa_fanout_messages_total                   -> per-socket sends on this instance
//   qa_flush_duration_seconds / qa_flush_rows_total -> incremental flush (P4)
import client from 'prom-client';
import { instanceId } from './config/instance.js';

export const register = new client.Registry();
register.setDefaultLabels({ instance_id: instanceId });
client.collectDefaultMetrics({ register });   // CPU, memory, event-loop lag, GC

export const wsConnections = new client.Gauge({
  name: 'qa_ws_connections',
  help: 'Q&A WebSocket connections admitted on this instance',
  registers: [register],
});

export const mutations = new client.Counter({
  name: 'qa_mutations_total',
  help: 'Q&A state changes accepted (questions, votes, answers, strategy changes)',
  labelNames: ['type'],
  registers: [register],
});

export const mutationErrors = new client.Counter({
  name: 'qa_mutation_errors_total',
  help: 'Q&A messages refused (e.g. already voted, unknown question, not the instructor)',
  labelNames: ['type'],
  registers: [register],
});

export const broadcasts = new client.Counter({
  name: 'qa_broadcasts_total',
  help: 'QUESTIONS_UPDATE payloads this instance published to Redis (as the lecture broadcaster)',
  registers: [register],
});

export const broadcastBytes = new client.Histogram({
  name: 'qa_broadcast_payload_bytes',
  help: 'Size of each published QUESTIONS_UPDATE',
  buckets: [1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6],
  registers: [register],
});

export const fanoutMessages = new client.Counter({
  name: 'qa_fanout_messages_total',
  help: 'Updates written to local sockets (one per socket per broadcast received)',
  registers: [register],
});

export const tickets = new client.Counter({
  name: 'qa_tickets_total',
  help: 'POST /api/qa/ticket outcomes',
  labelNames: ['result'],   // issued | forbidden | not_found
  registers: [register],
});

export const flushDuration = new client.Histogram({
  name: 'qa_flush_duration_seconds',
  help: 'Write-behind flush of one lecture to PostgreSQL (only flushes with changes)',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [register],
});

export const flushRows = new client.Counter({
  name: 'qa_flush_rows_total',
  help: 'Rows written by flushes',
  labelNames: ['table'],
  registers: [register],
});

export const deadInstancesPruned = new client.Counter({
  name: 'qa_dead_instance_presence_pruned_total',
  help: "Lecture presence entries dropped because their instance's heartbeat expired",
  registers: [register],
});

export async function metricsHandler(req, res) {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}
