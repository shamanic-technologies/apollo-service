import * as Sentry from "@sentry/node";

if (process.env.SENTRY_DSN) {
  // Since @sentry/node v9 the ESM loader hook wraps ONLY modules that have an
  // OpenTelemetry instrumentation, so drizzle-orm is never wrapped and its
  // named exports stay intact without an explicit exclude list.
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 0.1,
    sendDefaultPii: true,
  });
  Sentry.setTag("service", "apollo-service");
}
