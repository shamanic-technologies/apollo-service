/**
 * HTTP client for chat-service POST /complete.
 *
 * chat-service OWNS the LLM cost (provision→authorize→execute→actualize happens
 * inside chat-service, metered against the caller's org). apollo-service declares
 * NO LLM cost — it just calls this endpoint and passes the identity headers.
 */

export type ChatProvider = "google" | "anthropic";
export type ChatModel = "flash" | "flash-lite" | "flash-pro" | "pro" | "sonnet" | "haiku" | "opus";

export interface ChatCompleteParams {
  message: string;
  systemPrompt: string;
  provider: ChatProvider;
  model: ChatModel;
  responseFormat?: "json";
  temperature?: number;
  maxTokens?: number;
}

export interface ChatCompleteResult {
  content: string;
  json?: Record<string, unknown>;
  tokensInput: number;
  tokensOutput: number;
  model: string;
}

/** Identity/tracking headers forwarded to chat-service for cost attribution. */
export interface ChatTrackingHeaders {
  orgId: string;
  userId?: string;
  /** Outbound x-run-id — this service's own runId (NOT the inbound parent). */
  runId?: string;
  brandIds?: string[];
  campaignId?: string;
  audienceId?: string;
  featureSlug?: string;
  workflowSlug?: string;
}

function baseUrl(): string {
  const url = process.env.CHAT_SERVICE_URL;
  if (!url) throw new Error("[apollo-service] CHAT_SERVICE_URL is required");
  return url;
}

function buildHeaders(tracking: ChatTrackingHeaders): Record<string, string> {
  const apiKey = process.env.CHAT_SERVICE_API_KEY;
  if (!apiKey) throw new Error("[apollo-service] CHAT_SERVICE_API_KEY is required");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": tracking.orgId,
  };
  if (tracking.userId) headers["x-user-id"] = tracking.userId;
  if (tracking.runId) headers["x-run-id"] = tracking.runId;
  if (tracking.brandIds?.length) headers["x-brand-id"] = tracking.brandIds.join(",");
  if (tracking.campaignId) headers["x-campaign-id"] = tracking.campaignId;
  if (tracking.audienceId) headers["x-audience-id"] = tracking.audienceId;
  if (tracking.featureSlug) headers["x-feature-slug"] = tracking.featureSlug;
  if (tracking.workflowSlug) headers["x-workflow-slug"] = tracking.workflowSlug;
  return headers;
}

export async function chatComplete(
  params: ChatCompleteParams,
  tracking: ChatTrackingHeaders,
): Promise<ChatCompleteResult> {
  const body = {
    message: params.message,
    systemPrompt: params.systemPrompt,
    provider: params.provider,
    model: params.model,
    ...(params.responseFormat && { responseFormat: params.responseFormat }),
    ...(params.temperature !== undefined && { temperature: params.temperature }),
    ...(params.maxTokens !== undefined && { maxTokens: params.maxTokens }),
  };

  const res = await fetch(`${baseUrl()}/complete`, {
    method: "POST",
    headers: buildHeaders(tracking),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[apollo-service][chat-client] POST /complete returned ${res.status}: ${text}`);
  }

  return (await res.json()) as ChatCompleteResult;
}
