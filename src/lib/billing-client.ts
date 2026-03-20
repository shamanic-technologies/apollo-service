const BILLING_SERVICE_URL = process.env.BILLING_SERVICE_URL || "http://localhost:3006";
const BILLING_SERVICE_API_KEY = process.env.BILLING_SERVICE_API_KEY || "";

export interface CreditItem {
  costName: string;
  quantity: number;
}

export interface AuthorizeCreditParams {
  items: CreditItem[];
  description: string;
  orgId: string;
  userId: string;
  runId?: string;
  brandId?: string;
  campaignId?: string;
  workflowName?: string;
}

export interface AuthorizeCreditResult {
  sufficient: boolean;
  balance_cents: number;
  required_cents: number;
}

export async function authorizeCredit(
  params: AuthorizeCreditParams
): Promise<AuthorizeCreditResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": BILLING_SERVICE_API_KEY,
    "x-org-id": params.orgId,
    "x-user-id": params.userId,
  };

  if (params.runId) headers["x-run-id"] = params.runId;
  if (params.brandId) headers["x-brand-id"] = params.brandId;
  if (params.campaignId) headers["x-campaign-id"] = params.campaignId;
  if (params.workflowName) headers["x-workflow-name"] = params.workflowName;

  const response = await fetch(`${BILLING_SERVICE_URL}/v1/credits/authorize`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      items: params.items,
      description: params.description,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`billing-service POST /v1/credits/authorize failed: ${response.status} - ${errorText}`);
  }

  return response.json() as Promise<AuthorizeCreditResult>;
}
