import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { TransferBrandRequestSchema } from "../schemas.js";

const router = Router();

/**
 * POST /internal/transfer-brand
 *
 * Re-assigns solo-brand rows from sourceOrgId to targetOrgId.
 * Solo-brand = brand_ids array has exactly one element matching sourceBrandId.
 * When targetBrandId is present, also rewrites the brand reference.
 * Skips co-branding rows (multiple brand IDs).
 * Idempotent: rows already under targetOrgId are not touched.
 */
router.post("/internal/transfer-brand", async (req, res) => {
  try {
    const parsed = TransferBrandRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }

    const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = parsed.data;

    const tables = [
      "apollo_people_searches",
      "apollo_people_enrichments",
      "apollo_search_cursors",
      "apollo_search_params_cache",
    ] as const;

    const updatedTables: { tableName: string; count: number }[] = [];

    for (const tableName of tables) {
      const result = targetBrandId
        ? await db.execute(sql`
            UPDATE ${sql.identifier(tableName)}
            SET org_id = ${targetOrgId}, brand_ids = ARRAY[${targetBrandId}]
            WHERE org_id = ${sourceOrgId}
              AND array_length(brand_ids, 1) = 1
              AND brand_ids[1] = ${sourceBrandId}
          `)
        : await db.execute(sql`
            UPDATE ${sql.identifier(tableName)}
            SET org_id = ${targetOrgId}
            WHERE org_id = ${sourceOrgId}
              AND array_length(brand_ids, 1) = 1
              AND brand_ids[1] = ${sourceBrandId}
          `);

      const count = result.count;
      updatedTables.push({ tableName, count });
    }

    console.log(
      `[apollo-service] transfer-brand: sourceBrandId=${sourceBrandId} targetBrandId=${targetBrandId ?? "none"} from=${sourceOrgId} to=${targetOrgId} results=${JSON.stringify(updatedTables)}`
    );

    return res.json({ updatedTables });
  } catch (error) {
    console.error("[apollo-service] transfer-brand error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
