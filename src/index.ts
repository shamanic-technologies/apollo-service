import * as Sentry from "@sentry/node";
import express from "express";
import cors from "cors";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getSql } from "./db/index.js";
import healthRoutes from "./routes/health.js";
import searchRoutes from "./routes/search.js";
import searchParamsRoutes from "./routes/search-params.js";
import referenceRoutes from "./routes/reference.js";
import validateRoutes from "./routes/validate.js";
import matchRoutes from "./routes/match.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const openapiPath = join(__dirname, "..", "openapi.json");

const app = express();
const PORT = process.env.PORT || 3004;

// Middleware
app.use(cors());
app.use(express.json());

// OpenAPI spec endpoint
app.get("/openapi.json", (_req, res) => {
  if (existsSync(openapiPath)) {
    res.json(JSON.parse(readFileSync(openapiPath, "utf-8")));
  } else {
    res.status(404).json({
      error: "OpenAPI spec not generated. Run: pnpm generate:openapi",
    });
  }
});

// Routes
app.use(healthRoutes);
app.use(searchRoutes);
app.use(searchParamsRoutes);
app.use(referenceRoutes);
app.use(validateRoutes);
app.use(matchRoutes);

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
