// IMPORTANT: Import instrument first to initialize Sentry before anything else
import "./instrument.js";
import * as Sentry from "@sentry/node";
import express from "express";
import cors from "cors";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getSql } from "./db/index.js";
import healthRoutes from "./routes/health.js";
import searchRoutes from "./routes/search.js";
import referenceRoutes from "./routes/reference.js";
import validateRoutes from "./routes/validate.js";

const app = express();
const PORT = process.env.PORT || 3004;

// Middleware
app.use(cors());
app.use(express.json());

// Routes
app.use(healthRoutes);
app.use(searchRoutes);
app.use(referenceRoutes);
app.use(validateRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Sentry error handler must be before any other error middleware
Sentry.setupExpressErrorHandler(app);

// Fallback error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("[Apollo Service] Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// Only start server if not in test environment
if (process.env.NODE_ENV !== "test") {
  const dbUrl = process.env.APOLLO_SERVICE_DATABASE_URL;

  const startServer = () => {
    app.listen(Number(PORT), "::", () => {
      console.log(`[Apollo Service] running on port ${PORT}`);
    });
  };

  if (dbUrl) {
    const migrateDb = drizzle(getSql());
    migrate(migrateDb, { migrationsFolder: "./drizzle" })
      .then(() => {
        console.log("[Apollo Service] Migrations complete");
        startServer();
      })
      .catch((err) => {
        console.error("[Apollo Service] Migration failed:", err);
        process.exit(1);
      });
  } else {
    console.warn("[Apollo Service] APOLLO_SERVICE_DATABASE_URL not set, skipping migrations");
    startServer();
  }
}

export default app;
