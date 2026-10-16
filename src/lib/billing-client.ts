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
  brandIds?: string[];
  campaignId?: string;
  audienceId?: string;
  featureSlug?: string;
  workflowSlug?: string;
}

/**
 * billing-service refuses a spend for one of TWO causes, and they call for
 * opposite actions: a real balance shortfall ("add credit") or a SALES FUNNEL
 * MAX BUDGET the customer set ("raise the campaign's max budget"). billing says
 * which: `reason` + `sales_funnel_cap` are present ONLY on a funnel-cap refusal.
 * Never flatten one into the other (FUNNEL-CAP-REACHED-AT-2PCT-1015).
 */
export type FunnelCapRefusalReason =
  | "sales_funnel_max_budget_reached"
  | "sales_funnel_max_budget_unreadable";

export interface SalesFunnelCap {
  salesFunnelId: string;
  salesFunnelCampaignId: string | null;
  amountCents: string;
  period: string;
  consumedCents: string | null;
  reservedCents: string;
}

export interface AuthorizeCreditResult {
  sufficient: boolean;
  balance_cents: number;
  required_cents: number;
  reason?: FunnelCapRefusalReason | string;
  sales_funnel_cap?: SalesFunnelCap;
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
  if (params.brandIds?.length) headers["x-brand-id"] = params.brandIds.join(",");
  if (params.campaignId) headers["x-campaign-id"] = params.campaignId;
  if (params.audienceId) headers["x-audience-id"] = params.audienceId;
  if (params.featureSlug) headers["x-feature-slug"] = params.featureSlug;
  if (params.workflowSlug) headers["x-workflow-slug"] = params.workflowSlug;

  const response = await fetch(`${BILLING_SERVICE_URL}/v1/customer_balance/authorize`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      items: params.items,
      description: params.description,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`billing-service POST /v1/customer_balance/authorize failed: ${response.status} - ${errorText}`);
  }

  return response.json() as Promise<AuthorizeCreditResult>;
}
