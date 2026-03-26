/**
 * HTTP client for brand-service extract-fields endpoint.
 * Results are cached 30 days server-side by brand-service,
 * so repeated calls are cheap (no LLM, no scraping).
 */

const BRAND_SERVICE_URL = process.env.BRAND_SERVICE_URL || "http://localhost:3010";
const BRAND_SERVICE_API_KEY = process.env.BRAND_SERVICE_API_KEY || "";

export interface FieldRequest {
  key: string;
  description: string;
}

export interface FieldResult {
  key: string;
  value: string | string[] | Record<string, unknown> | null;
  cached: boolean;
}

export interface BrandFieldsIdentity {
  orgId: string;
  userId?: string;
  runId?: string;
  brandId?: string;
  campaignId?: string;
  featureSlug?: string;
  workflowName?: string;
}

export async function extractBrandFields(
  brandId: string,
  fields: FieldRequest[],
  identity: BrandFieldsIdentity
): Promise<FieldResult[]> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": BRAND_SERVICE_API_KEY,
    "x-org-id": identity.orgId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  if (identity.brandId) headers["x-brand-id"] = identity.brandId;
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.featureSlug) headers["x-feature-slug"] = identity.featureSlug;
  if (identity.workflowName) headers["x-workflow-name"] = identity.workflowName;

  const response = await fetch(`${BRAND_SERVICE_URL}/brands/${brandId}/extract-fields`, {
    method: "POST",
    headers,
    body: JSON.stringify({ fields }),
  });

  if (!response.ok) {
    console.warn(`[Apollo Service] Failed to extract brand fields for ${brandId}: ${response.status}`);
    return [];
  }

  const data = await response.json() as { results: FieldResult[] };
  return data.results ?? [];
}
