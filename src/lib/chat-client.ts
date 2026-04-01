/**
 * HTTP client for chat-service POST /complete.
 * Replaces direct Anthropic SDK usage — all LLM calls go through chat-service.
 */

const CHAT_SERVICE_URL = process.env.CHAT_SERVICE_URL || "http://localhost:3012";
const CHAT_SERVICE_API_KEY = process.env.CHAT_SERVICE_API_KEY || "";

export interface ChatCompleteRequest {
  message: string;
  systemPrompt: string;
  provider: "anthropic" | "google";
  model: "haiku" | "sonnet" | "opus" | "flash-lite" | "flash" | "pro";
  responseFormat?: "json";
  temperature?: number;
  maxTokens?: number;
}

export interface ChatCompleteResponse {
  content: string;
  json?: Record<string, unknown> | null;
  tokensInput: number;
  tokensOutput: number;
  model: string;
}

export interface ChatIdentityHeaders {
  orgId: string;
  userId?: string;
  runId?: string;
  brandId?: string;
  campaignId?: string;
  featureSlug?: string;
  workflowSlug?: string;
}

export async function chatComplete(
  request: ChatCompleteRequest,
  identity: ChatIdentityHeaders
): Promise<ChatCompleteResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": CHAT_SERVICE_API_KEY,
    "x-org-id": identity.orgId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  if (identity.brandId) headers["x-brand-id"] = identity.brandId;
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.featureSlug) headers["x-feature-slug"] = identity.featureSlug;
  if (identity.workflowSlug) headers["x-workflow-slug"] = identity.workflowSlug;

  const response = await fetch(`${CHAT_SERVICE_URL}/complete`, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`[Apollo Service] chat-service /complete failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as ChatCompleteResponse;
  return data;
}
