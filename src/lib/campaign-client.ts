/**
 * HTTP client for campaign-service.
 * Fetches campaign data and caches featureInputs by campaignId
 * (featureInputs never change during a campaign's lifetime).
 */

const CAMPAIGN_SERVICE_URL = process.env.CAMPAIGN_SERVICE_URL || "http://localhost:3009";
const CAMPAIGN_SERVICE_API_KEY = process.env.CAMPAIGN_SERVICE_API_KEY || "";

// In-memory cache: campaignId → featureInputs (never changes per campaign)
const featureInputsCache = new Map<string, Record<string, unknown> | null>();

export interface CampaignIdentity {
  orgId: string;
  userId?: string;
  runId?: string;
  brandId?: string;
  campaignId?: string;
  featureSlug?: string;
  workflowSlug?: string;
}

export async function getFeatureInputs(
  campaignId: string,
  identity: CampaignIdentity
): Promise<Record<string, unknown> | null> {
  const cached = featureInputsCache.get(campaignId);
  if (cached !== undefined) return cached;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": CAMPAIGN_SERVICE_API_KEY,
    "x-org-id": identity.orgId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  if (identity.brandId) headers["x-brand-id"] = identity.brandId;
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.featureSlug) headers["x-feature-slug"] = identity.featureSlug;
  if (identity.workflowSlug) headers["x-workflow-slug"] = identity.workflowSlug;

  const response = await fetch(`${CAMPAIGN_SERVICE_URL}/campaigns/${campaignId}`, { headers });

  if (!response.ok) {
    console.warn(`[Apollo Service] Failed to fetch campaign ${campaignId}: ${response.status}`);
    featureInputsCache.set(campaignId, null);
    return null;
  }

  const data = await response.json() as { campaign: { featureInputs?: Record<string, unknown> | null } };
  const featureInputs = data.campaign?.featureInputs ?? null;

  featureInputsCache.set(campaignId, featureInputs);
  return featureInputs;
}

/** Clear cache — useful for tests */
export function clearFeatureInputsCache(): void {
  featureInputsCache.clear();
}
