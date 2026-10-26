// Server-side view of one load-test window, from Prometheus.
//
//   node scripts/prom-report.js <from ISO> <to ISO>
// e.g. with the STEADY_WINDOW printed by k6/qa_ws_test.js.
// Needs the stack started with --profile observability (Prometheus on :9090).
const PROM = process.env.PROM || 'http://localhost:9090';
const [fromArg, toArg] = process.argv.slice(2);
if (!fromArg || !toArg) { console.error('usage: node scripts/prom-report.js <from ISO> <to ISO>'); process.exit(1); }
const from = new Date(fromArg), to = new Date(toArg);
const win = `${Math.round((to - from) / 1000)}s`;
const at = to.getTime() / 1000;

async function q(expr) {
  const r = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(expr)}&time=${at}`);
  const j = await r.json();
  if (j.status !== 'success') throw new Error(`${expr}: ${j.error}`);
  return j.data.result;
}
const one = async (expr) => Number((await q(expr))[0]?.value[1] ?? NaN);
const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : 'n/a');

const rows = [
  ['Q&A mutations/s (all instances)',          `sum(rate(qa_mutations_total[${win}]))`, 1],
  ['Q&A broadcasts published/s',               `sum(rate(qa_broadcasts_total[${win}]))`, 2],
  ['Fan-out messages/s to sockets',            `sum(rate(qa_fanout_messages_total[${win}]))`, 0],
  ['Sockets (end of window)',                  `sum(qa_ws_connections)`, 0],
  ['Broadcast payload p50 (bytes)',            `histogram_quantile(0.5, sum by (le) (increase(qa_broadcast_payload_bytes_bucket[${win}])))`, 0],
  ['Broadcast payload mean (bytes)',           `sum(increase(qa_broadcast_payload_bytes_sum[${win}])) / sum(increase(qa_broadcast_payload_bytes_count[${win}]))`, 0],
  ['Flushes with changes in window',           `sum(increase(qa_flush_duration_seconds_count[${win}]))`, 0],
  ['Flush duration mean (ms)',                 `1000 * sum(increase(qa_flush_duration_seconds_sum[${win}])) / sum(increase(qa_flush_duration_seconds_count[${win}]))`, 1],
  ['Flush duration p95 (ms, bucketed)',        `1000 * histogram_quantile(0.95, sum by (le) (increase(qa_flush_duration_seconds_bucket[${win}])))`, 0],
  ['Rows flushed/s: votes',                    `sum(rate(qa_flush_rows_total{table="votes"}[${win}]))`, 1],
  ['Rows flushed/s: questions',                `sum(rate(qa_flush_rows_total{table="questions"}[${win}]))`, 2],
  ['Tickets issued in window',                 `sum(increase(qa_tickets_total{result="issued"}[${win}]))`, 0],
];

console.log(`window ${from.toISOString()} .. ${to.toISOString()} (${win})\n`);
for (const [label, expr, d] of rows) console.log(`${label.padEnd(40)} ${fmt(await one(expr), d)}`);

const fanout = await one(`sum(rate(qa_fanout_messages_total[${win}]))`);
const sockets = await one('sum(qa_ws_connections)');
console.log(`${'Messages per socket per second'.padEnd(40)} ${fmt(fanout / sockets)}`);

console.log('\nPer instance:');
const cpu = await q(`rate(process_cpu_seconds_total[${win}])`);
const lag = await q(`max_over_time(nodejs_eventloop_lag_p99_seconds[${win}])`);
const conns = await q('qa_ws_connections');
for (const c of cpu.sort((a, b) => (a.metric.job + a.metric.instance_id).localeCompare(b.metric.job + b.metric.instance_id))) {
  const id = c.metric.instance_id;
  const l = lag.find((x) => x.metric.instance_id === id);
  const n = conns.find((x) => x.metric.instance_id === id);
  console.log(`  ${c.metric.job.padEnd(17)} ${id.padEnd(22)} cpu ${fmt(Number(c.value[1]) * 100, 1).padStart(5)} %   ` +
    `event-loop lag p99 (max) ${fmt(Number(l?.value[1]) * 1000, 1).padStart(6)} ms` + (n ? `   sockets ${n.value[1]}` : ''));
}
