/**
 * HTTP client for chat-service LLM completion.
 *
 * Two endpoints, picked by whether the caller carries an inbound run id:
 *   - WITH runId: POST /complete, org/run-scoped. chat-service meters the LLM
 *     cost against the caller's org + run.
 *   - WITHOUT runId: POST /internal/platform-complete, for run-less internal
 *     callers (migrations/backfills/sweeps). chat-service uses the platform key
 *     and declares the spend on a platform run, with no org balance gate.
 *
 * chat-service owns the LLM cost in both cases. apollo-service declares no LLM
 * cost locally; it just calls chat-service and passes the relevant headers.
 */

import { fetchWithRetry } from "./fetch-retry.js";

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
  /** Minimize the model's internal reasoning. Provider-floored: Gemini 3 (incl.
   * flash-pro) drops to its lowest level (`minimal`), not full-off. */
  disableThinking?: boolean;
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
  /** Outbound x-run-id: this service's own runId, not the inbound parent. */
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

/**
 * Headers for POST /internal/platform-complete. The platform endpoint takes no
 * org/user/run identity from this caller.
 */
function buildPlatformHeaders(): Record<string, string> {
  const apiKey = process.env.CHAT_SERVICE_API_KEY;
  if (!apiKey) throw new Error("[apollo-service] CHAT_SERVICE_API_KEY is required");
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };
}

export async function chatComplete(
  params: ChatCompleteParams,
  tracking: ChatTrackingHeaders,
): Promise<ChatCompleteResult> {
  // Run-less callers (no inbound run id: migrations / backfills / internal
  // sweeps) route to the platform completion endpoint; run-scoped callers keep
  // the org-scoped /complete path. chat-service owns the cost in both cases.
  const isPlatform = !tracking.runId;
  const path = isPlatform ? "/internal/platform-complete" : "/complete";

  const body = {
    message: params.message,
    systemPrompt: params.systemPrompt,
    provider: params.provider,
    model: params.model,
    ...(params.responseFormat && { responseFormat: params.responseFormat }),
    ...(params.temperature !== undefined && { temperature: params.temperature }),
    ...(params.disableThinking !== undefined && { disableThinking: params.disableThinking }),
    // platform-complete has no maxTokens field in chat-service's request schema.
    ...(!isPlatform && params.maxTokens !== undefined && { maxTokens: params.maxTokens }),
  };

  // Transient connect/socket drops to chat-service (UND_ERR_SOCKET /
  // "other side closed" / ECONNRESET on a reused-then-closed keep-alive socket
  // or a Neon cold-start sibling) are retried with bounded backoff. A completed
  // HTTP response — including a 5xx — is NOT retried; it is a real answer and is
  // handled below. A chat completion is idempotent, so retrying a thrown connect
  // error is write-safe.
  const res = await fetchWithRetry(`${baseUrl()}${path}`, {
    method: "POST",
    headers: isPlatform ? buildPlatformHeaders() : buildHeaders(tracking),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[apollo-service][chat-client] POST ${path} returned ${res.status}: ${text}`);
  }

  return (await res.json()) as ChatCompleteResult;
}
