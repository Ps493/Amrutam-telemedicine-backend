'use strict';
const client = require('prom-client');
const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds', help: 'HTTP latency', registers: [registry],
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.35, 0.5, 1, 2, 5], // aligned to the 200ms / 500ms SLOs
});
const bookings = new client.Counter({ name: 'bookings_total', help: 'Booking attempts by outcome', labelNames: ['outcome'], registers: [registry] });
const payments = new client.Counter({ name: 'payments_total', help: 'Payment results', labelNames: ['outcome'], registers: [registry] });
const outboxLag = new client.Gauge({ name: 'outbox_pending', help: 'Pending outbox events', registers: [registry] });
const idempotentReplays = new client.Counter({ name: 'idempotent_replays_total', help: 'Replayed idempotent responses', registers: [registry] });
const dbPool = new client.Gauge({ name: 'db_pool_waiting', help: 'Clients waiting on DB pool', registers: [registry] });

module.exports = { registry, httpDuration, bookings, payments, outboxLag, idempotentReplays, dbPool };
