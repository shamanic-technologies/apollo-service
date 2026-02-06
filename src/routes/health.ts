import { Router } from "express";
import { sql } from "drizzle-orm";

const router = Router();

router.get("/health", (req, res) => {
  res.json({ status: "ok", service: "apollo-service" });
});

router.get("/health/debug", async (req, res) => {
  const keyServiceUrl = process.env.KEY_SERVICE_URL || "not set";
  const dbUrl = process.env.APOLLO_SERVICE_DATABASE_URL;

  let dbStatus = "unknown";
  if (dbUrl) {
    try {
      const { db } = await import("../db/index.js");
      await db.execute(sql`SELECT 1`);
      dbStatus = "connected";
    } catch (e: any) {
      dbStatus = `error: ${e.message}`;
    }
  } else {
    dbStatus = "not configured";
  }

  let keyServiceStatus = "unknown";
  try {
    const resp = await fetch(`${keyServiceUrl}/health`);
    keyServiceStatus = resp.ok ? "connected" : `status: ${resp.status}`;
  } catch (e: any) {
    keyServiceStatus = `error: ${e.message}`;
  }

  res.json({
    keyServiceUrl,
    dbConfigured: !!dbUrl,
    dbStatus,
    keyServiceStatus,
  });
});

export default router;
