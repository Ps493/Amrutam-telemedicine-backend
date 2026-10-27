'use strict';
if (process.env.OTEL_ENABLED === 'true') { try { require('./tracing'); } catch (e) { console.error('tracing disabled:', e.message); } }
const config = require('./config');
const logger = require('./lib/logger');
const { buildContainer } = require('./container');
const { createApp } = require('./app');

const container = buildContainer();
const app = createApp(container);
const server = app.listen(config.port, () => logger.info({ port: config.port }, 'api listening'));
server.keepAliveTimeout = 65_000; // > typical LB idle timeout to avoid 502s

// Graceful shutdown: stop accepting, drain in-flight, close pools (zero-downtime deploys).
let closing = false;
async function shutdown(sig) {
  if (closing) return; closing = true; logger.info({ sig }, 'shutting down');
  server.close(async () => { await container.db.close(); await container.cache.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 25_000).unref();
}
['SIGTERM', 'SIGINT'].forEach((s) => process.on(s, () => shutdown(s)));
process.on('unhandledRejection', (e) => logger.error({ err: e }, 'unhandledRejection'));
