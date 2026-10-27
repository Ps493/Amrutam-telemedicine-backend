'use strict';
// Optional OpenTelemetry tracing (OTEL_ENABLED=true). Install: npm i @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-trace-otlp-http
// Auto-instruments http, express, pg, ioredis. Spans exported via OTLP to the collector (OTEL_EXPORTER_OTLP_ENDPOINT).
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const sdk = new NodeSDK({ serviceName: process.env.OTEL_SERVICE_NAME || 'amrutam-api', traceExporter: new OTLPTraceExporter(), instrumentations: [getNodeAutoInstrumentations({ '@opentelemetry/instrumentation-fs': { enabled: false } })] });
sdk.start();
process.on('SIGTERM', () => sdk.shutdown());
