const KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || "http://localhost:3001";
const KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY || "";

interface CallerContext {
  callerMethod: string;
  callerPath: string;
}

function callerHeaders(ctx: CallerContext): Record<string, string> {
  return {
    "X-API-Key": KEY_SERVICE_API_KEY,
    "X-Caller-Service": "apollo",
    "X-Caller-Method": ctx.callerMethod,
    "X-Caller-Path": ctx.callerPath,
  };
}

export interface DecryptKeyResult {
  key: string;
  keySource: "org" | "platform";
}

/**
 * Decrypt an API key via key-service.
 * Auto-resolves whether to use org or platform key based on the org's preference.
 * orgId/userId sent as x-org-id/x-user-id headers per key-service spec.
 */
export interface TrackingContext {
  brandId?: string;
  campaignId?: string;
  workflowName?: string;
}

export async function decryptKey(
  orgId: string,
  userId: string,
  provider: string,
  caller: CallerContext,
  tracking?: TrackingContext
): Promise<DecryptKeyResult> {
  const trackingHeaders: Record<string, string> = {};
  if (tracking?.brandId) trackingHeaders["x-brand-id"] = tracking.brandId;
  if (tracking?.campaignId) trackingHeaders["x-campaign-id"] = tracking.campaignId;
  if (tracking?.workflowName) trackingHeaders["x-workflow-name"] = tracking.workflowName;

  const response = await fetch(
    `${KEY_SERVICE_URL}/keys/${provider}/decrypt`,
    {
      headers: {
        ...callerHeaders(caller),
        "x-org-id": orgId,
        "x-user-id": userId,
        ...trackingHeaders,
      },
    }
  );

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`${provider} key not configured for this organization`);
    }
    const error = await response.text();
    throw new Error(`Failed to fetch ${provider} key: ${error}`);
  }

  const data = await response.json();
  return { key: data.key, keySource: data.keySource };
}
