import { Router, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { TransferBrandRequestSchema } from "../schemas.js";

const router = Router();

/**
 * Service api-key auth for the fleet transfer contract. brand-service calls
 * with `x-api-key: $APOLLO_SERVICE_API_KEY`. Fails closed: a missing key on
 * our side refuses every call rather than letting anyone move a brand.
 */
export function requireServiceApiKey(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.APOLLO_SERVICE_API_KEY;
  if (!expected) {
    console.error("[apollo-service] transfer-brand: APOLLO_SERVICE_API_KEY is not set, refusing");
    return res.status(500).json({ type: "internal", error: "Service api key not configured" });
  }
  const given = String(req.headers["x-api-key"] ?? "");
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(401).json({ type: "auth", error: "Invalid or missing x-api-key" });
  }
  next();
}

interface TransferIds {
  sourceBrandId: string;
  sourceOrgId: string;
  targetOrgId: string;
  targetBrandId?: string;
}

type Exec = (query: SQL) => Promise<{ count: number }>;

/**
 * One table's move. `where` selects the brand's rows STILL under the source
 * org; it runs before any later table moves, so it may look at parent rows
 * (enrichments, findings, cursors) that have not moved yet.
 *
 * `brandColumn` names how the row carries the brand, when it does:
 *   - "brand_ids": text[]; only a SOLO-brand row ([sourceBrandId]) is rewritten
 *   - "brand_id":  text
 *   - null: the row carries no brand (tied through a parent / campaign / run)
 */
interface TableMove {
  tableName: string;
  brandColumn: "brand_ids" | "brand_id" | null;
  where: (ids: TransferIds) => SQL;
}

const soloBrand = (col: string, brandId: string) =>
  sql`${sql.identifier(col)} = ARRAY[${brandId}]::text[]`;

/**
 * Campaigns of the brand, read from the rows that carry the brand directly and
 * have not moved yet. Rows written without a brand (phone reveals, email
 * findings, QuickEnrich searches) are tied to the brand through these.
 */
const brandCampaigns = ({ sourceBrandId, sourceOrgId }: TransferIds) => sql`(
  SELECT campaign_id FROM apollo_people_searches
    WHERE org_id = ${sourceOrgId} AND brand_ids = ARRAY[${sourceBrandId}]::text[]
  UNION SELECT campaign_id FROM apollo_people_enrichments
    WHERE org_id = ${sourceOrgId} AND brand_ids = ARRAY[${sourceBrandId}]::text[]
  UNION SELECT campaign_id FROM apollo_search_cursors
    WHERE org_id = ${sourceOrgId} AND brand_ids = ARRAY[${sourceBrandId}]::text[]
)`;

/** Solo-brand row, or a brandless row belonging to one of the brand's campaigns. */
const brandOrCampaign = (ids: TransferIds) => sql`(
  brand_ids = ARRAY[${ids.sourceBrandId}]::text[]
  OR ((brand_ids IS NULL OR cardinality(brand_ids) = 0)
      AND campaign_id IN ${brandCampaigns(ids)})
)`;

/**
 * ORDER MATTERS: tables tied through a parent come BEFORE that parent, because
 * the tie is read from the parent while it still sits under the source org.
 * Everything runs in one transaction, so a failure moves nothing.
 */
export const TABLE_MOVES: TableMove[] = [
  {
    // Verdicts for emails revealed for the brand: same org, same caller run,
    // same address as the enrichment / finding that asked for them.
    tableName: "email_verifications",
    brandColumn: null,
    where: (ids) => sql`org_id = ${ids.sourceOrgId} AND (
      EXISTS (SELECT 1 FROM apollo_people_enrichments e
        WHERE e.org_id = ${ids.sourceOrgId} AND e.run_id = email_verifications.run_id
          AND lower(e.email) = email_verifications.email
          AND e.brand_ids = ARRAY[${ids.sourceBrandId}]::text[])
      OR EXISTS (SELECT 1 FROM email_findings f
        WHERE f.org_id = ${ids.sourceOrgId} AND f.run_id = email_verifications.run_id
          AND lower(f.email) = email_verifications.email
          AND ${brandOrCampaign(ids)})
    )`,
  },
  {
    // Bronze vendor calls of the brand's findings.
    tableName: "email_finder_calls",
    brandColumn: null,
    where: (ids) => sql`org_id = ${ids.sourceOrgId} AND finding_id IN (
      SELECT id FROM email_findings WHERE org_id = ${ids.sourceOrgId} AND ${brandOrCampaign(ids)}
    )`,
  },
  {
    // QuickEnrich search calls: through the brand's cursor, audience or campaign.
    tableName: "quickenrich_searches",
    brandColumn: null,
    where: (ids) => sql`org_id = ${ids.sourceOrgId} AND (
      cursor_id IN (SELECT id FROM apollo_search_cursors
        WHERE org_id = ${ids.sourceOrgId} AND brand_ids = ARRAY[${ids.sourceBrandId}]::text[])
      OR apollo_audience_id IN (SELECT id FROM apollo_audiences
        WHERE org_id = ${ids.sourceOrgId} AND brand_id = ${ids.sourceBrandId})
      OR campaign_id IN ${brandCampaigns(ids)}
    )`,
  },
  {
    tableName: "apollo_phone_reveals",
    brandColumn: "brand_ids",
    where: (ids) => sql`org_id = ${ids.sourceOrgId} AND ${brandOrCampaign(ids)}`,
  },
  {
    tableName: "email_findings",
    brandColumn: "brand_ids",
    where: (ids) => sql`org_id = ${ids.sourceOrgId} AND ${brandOrCampaign(ids)}`,
  },
  {
    // Reveals the domain gate did not buy: solo-brand, or brandless on a brand campaign.
    tableName: "reveal_skips",
    brandColumn: "brand_ids",
    where: (ids) => sql`org_id = ${ids.sourceOrgId} AND ${brandOrCampaign(ids)}`,
  },
  {
    tableName: "apollo_people_searches",
    brandColumn: "brand_ids",
    where: (ids) => sql`org_id = ${ids.sourceOrgId} AND ${soloBrand("brand_ids", ids.sourceBrandId)}`,
  },
  {
    tableName: "apollo_people_enrichments",
    brandColumn: "brand_ids",
    where: (ids) => sql`org_id = ${ids.sourceOrgId} AND ${soloBrand("brand_ids", ids.sourceBrandId)}`,
  },
  {
    tableName: "apollo_search_cursors",
    brandColumn: "brand_ids",
    where: (ids) => sql`org_id = ${ids.sourceOrgId} AND ${soloBrand("brand_ids", ids.sourceBrandId)}`,
  },
  {
    tableName: "apollo_audiences",
    brandColumn: "brand_id",
    where: (ids) => sql`org_id = ${ids.sourceOrgId} AND brand_id = ${ids.sourceBrandId}`,
  },
];

/**
 * Moves every table in order. Per table: (1) move the brand's rows from the
 * source org to the target org, rewriting a solo brand reference to
 * targetBrandId in the same UPDATE; (2) when targetBrandId is given, rewrite
 * rows already under the target org that still carry the source brand (a prior
 * run made without targetBrandId). Both steps select nothing on a re-run, so a
 * second call reports 0 everywhere.
 */
export async function transferBrand(exec: Exec, ids: TransferIds) {
  const updatedTables: { tableName: string; count: number }[] = [];
  for (const move of TABLE_MOVES) {
    const t = sql.identifier(move.tableName);
    let setBrand = sql``;
    if (ids.targetBrandId && move.brandColumn === "brand_ids") {
      setBrand = sql`, brand_ids = CASE WHEN brand_ids = ARRAY[${ids.sourceBrandId}]::text[]
        THEN ARRAY[${ids.targetBrandId}]::text[] ELSE brand_ids END`;
    } else if (ids.targetBrandId && move.brandColumn === "brand_id") {
      setBrand = sql`, brand_id = CASE WHEN brand_id = ${ids.sourceBrandId}
        THEN ${ids.targetBrandId} ELSE brand_id END`;
    }
    const moved = await exec(sql`UPDATE ${t} SET org_id = ${ids.targetOrgId}${setBrand} WHERE ${move.where(ids)}`);
    let count = moved.count;

    if (ids.targetBrandId && move.brandColumn) {
      const rebrand =
        move.brandColumn === "brand_ids"
          ? sql`UPDATE ${t} SET brand_ids = ARRAY[${ids.targetBrandId}]::text[]
              WHERE org_id = ${ids.targetOrgId} AND brand_ids = ARRAY[${ids.sourceBrandId}]::text[]`
          : sql`UPDATE ${t} SET brand_id = ${ids.targetBrandId}
              WHERE org_id = ${ids.targetOrgId} AND brand_id = ${ids.sourceBrandId}`;
      count += (await exec(rebrand)).count;
    }
    updatedTables.push({ tableName: move.tableName, count });
  }
  return updatedTables;
}

/**
 * POST /internal/transfer-brand
 *
 * Moves everything this service holds for a brand from sourceOrgId to
 * targetOrgId: rows carrying the brand alone, and rows tied to it through one
 * of its campaigns, runs, cursors, audiences or findings. Co-branded rows
 * (several brand ids) stay: they belong to the other brand too. Moves history
 * only; no cost is declared or reversed. One transaction, idempotent.
 */
router.post("/internal/transfer-brand", requireServiceApiKey, async (req, res) => {
  try {
    const parsed = TransferBrandRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ type: "validation", error: parsed.error.message });
    }
    const ids = parsed.data;
    if (ids.sourceOrgId === ids.targetOrgId && !ids.targetBrandId) {
      return res.json({ updatedTables: TABLE_MOVES.map((m) => ({ tableName: m.tableName, count: 0 })) });
    }

    const updatedTables = await db.transaction(async (tx) =>
      transferBrand((q) => tx.execute(q) as unknown as Promise<{ count: number }>, ids)
    );

    console.log(
      `[apollo-service] transfer-brand: sourceBrandId=${ids.sourceBrandId} targetBrandId=${ids.targetBrandId ?? "none"} from=${ids.sourceOrgId} to=${ids.targetOrgId} results=${JSON.stringify(updatedTables)}`
    );
    return res.json({ updatedTables });
  } catch (error) {
    console.error("[apollo-service] transfer-brand error:", error);
    return res.status(500).json({ type: "internal", error: "Internal server error" });
  }
});

export default router;
