import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

/**
 * OpenTelemetry SDK bootstrap. MUST be imported as the very first
 * statement in `main.ts` (and any other entrypoint) — auto-
 * instrumentation patches modules at load time, so anything imported
 * before this file will not be instrumented.
 *
 * Env contract:
 *   OTEL_EXPORTER_OTLP_ENDPOINT   base URL of the OTLP/HTTP collector;
 *                                 omit to disable exporters (SDK runs
 *                                 as a no-op in that case so dev does
 *                                 not need a local collector)
 *   OTEL_SERVICE_NAME             service identifier in Tempo / Loki
 *   SERVICE_VERSION               commit SHA or semver from CI
 *
 * The values are read via process.env directly because this module
 * runs before NestFactory.create, before ConfigModule exists. The
 * env.schema.ts still validates them for the rest of the app.
 */
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const serviceName = process.env.OTEL_SERVICE_NAME ?? 'isp-cms-be';
const serviceVersion = process.env.SERVICE_VERSION ?? '0.0.0';

export const otelSdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_VERSION]: serviceVersion,
  }),
  traceExporter: otlpEndpoint
    ? new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` })
    : undefined,
  metricReader: otlpEndpoint
    ? new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${otlpEndpoint}/v1/metrics` }),
        exportIntervalMillis: 15_000,
      })
    : undefined,
  instrumentations: [
    getNodeAutoInstrumentations({
      // The fs instrumentation generates a span for every file system
      // call — extremely noisy and rarely useful. Disable by default.
      '@opentelemetry/instrumentation-fs': { enabled: false },
      // Pino integration injects trace_id / span_id into every log
      // line so Loki and Tempo can be cross-linked.
      '@opentelemetry/instrumentation-pino': { enabled: true },
    }),
  ],
});

otelSdk.start();

// Flush exporters on shutdown so spans buffered in memory reach the
// collector. Deliberately does NOT call process.exit(): main.ts and
// worker.ts call app.enableShutdownHooks(), which registers its OWN SIGTERM
// handler to drain in-flight HTTP, close DB/Redis, and run OnModuleDestroy.
// Node invokes every SIGTERM listener, so both fire — forcing an exit here
// would race and truncate Nest's graceful drain (R8-OBS-5), especially when
// OTEL is disabled and shutdown() resolves almost instantly. Let Nest own
// the shutdown; the process exits naturally once both finish and nothing is
// left keeping the event loop alive.
process.on('SIGTERM', () => {
  void otelSdk.shutdown().catch(() => {
    /* swallow — shutting down anyway */
  });
});
