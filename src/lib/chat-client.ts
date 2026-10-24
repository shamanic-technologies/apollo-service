/**
 * HTTP client for chat-service LLM completion.
 *
 * Two endpoints, picked by `billing`:
 *   - "org": POST /complete, org/run-scoped. chat-service meters the LLM cost
 *     against the caller's org + run.
 *   - "platform": POST /internal/platform-complete, platform key, no org
 *     balance gate.
 *
 * Every call carries THIS service's own run in `x-run-id`, on both endpoints
 * (PLATFORM-CALLER-RUN-1024): on the platform tier the run chat-service opens
 * becomes a child of ours, so the spend rides the work that run does. A
 * platform call stating neither a caller run nor a support function is refused
 * by chat-service, and nothing here declares support: every LLM call this
 * service makes is done for a run of its own.
 *
 * chat-service owns the LLM cost in both cases. apollo-service declares no LLM
 * cost locally; it just calls chat-service and passes the relevant headers.
 */

import { fetchWithRetry } from "./fetch-retry.js";

export type ChatProvider = "google" | "anthropic" | "deepseek" | "zai" | "openai";
export type ChatModel =
  | "flash"
  | "flash-lite"
  | "flash-pro"
  | "pro"
  | "sonnet"
  | "haiku"
  | "opus"
  // OpenAI-compatible vendors. DeepSeek serves `json_object` only (no
  // `json_schema`), which suits this loop: it runs schemaless JSON validated by
  // Zod guards, exactly like Gemini JSON mode.
  | "deepseek-pro"
  | "glm-pro"
  // OpenAI GPT-6 Astra. It REJECTS `temperature` != 1 and `top_p` outright
  // (400 `unsupported_value`), so no sampling parameter may be sent with it.
  | "gpt-pro";

export interface ChatCompleteParams {
  message: string;
  systemPrompt: string;
  provider: ChatProvider;
  model: ChatModel;
  responseFormat?: "json";
  /** JSON Schema the provider enforces server-side. REQUIRED for Anthropic JSON
   * mode (chat-service 400s without it) and it must be STRICT: every property
   * listed in `required`, `additionalProperties: false`. */
  responseSchema?: Record<string, unknown>;
  temperature?: number;
  maxTokens?: number;
  /** Minimize the model's internal reasoning. Provider-floored: Gemini 3 (incl.
   * flash-pro) drops to its lowest level (`minimal`), not full-off; Claude
   * Sonnet 5.5 drops to `output_config.effort: "low"`. */
  disableThinking?: boolean;
  /** Abort the outbound call. Used by callers that own a wall-clock bound (the
   * audience refine loop): a completion still in flight when the caller's
   * deadline passes is worthless, and the caller must answer regardless. */
  signal?: AbortSignal;
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
  /** Outbound x-run-id: this service's OWN run doing the work, never an
   * inbound run forwarded as is. Required on both endpoints. */
  runId: string;
  /** Who pays: "org" = /complete on the org's balance, "platform" =
   * /internal/platform-complete on the platform key. */
  billing: "org" | "platform";
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
  headers["x-run-id"] = tracking.runId;
  if (tracking.brandIds?.length) headers["x-brand-id"] = tracking.brandIds.join(",");
  if (tracking.campaignId) headers["x-campaign-id"] = tracking.campaignId;
  if (tracking.audienceId) headers["x-audience-id"] = tracking.audienceId;
  if (tracking.featureSlug) headers["x-feature-slug"] = tracking.featureSlug;
  if (tracking.workflowSlug) headers["x-workflow-slug"] = tracking.workflowSlug;
  return headers;
}

/**
 * Headers for chat-service's platform routes. They take no org/user identity
 * from this caller, only the caller's run: `callerRunId` is the run of THIS
 * service doing the work, and the platform run becomes its child.
 */
function buildPlatformHeaders(callerRunId: string): Record<string, string> {
  const apiKey = process.env.CHAT_SERVICE_API_KEY;
  if (!apiKey) throw new Error("[apollo-service] CHAT_SERVICE_API_KEY is required");
  if (!callerRunId) throw new Error("[apollo-service] a platform call to chat-service needs this service's run id");
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-run-id": callerRunId,
  };
}

export async function chatComplete(
  params: ChatCompleteParams,
  tracking: ChatTrackingHeaders,
): Promise<ChatCompleteResult> {
  if (!tracking.runId) throw new Error("[apollo-service] chatComplete needs this service's run id");
  const isPlatform = tracking.billing === "platform";
  const path = isPlatform ? "/internal/platform-complete" : "/complete";

  const body = {
    message: params.message,
    systemPrompt: params.systemPrompt,
    provider: params.provider,
    model: params.model,
    ...(params.responseFormat && { responseFormat: params.responseFormat }),
    ...(params.responseSchema && { responseSchema: params.responseSchema }),
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
    headers: isPlatform ? buildPlatformHeaders(tracking.runId) : buildHeaders(tracking),
    body: JSON.stringify(body),
    ...(params.signal && { signal: params.signal }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[apollo-service][chat-client] POST ${path} returned ${res.status}: ${text}`);
  }

  return (await res.json()) as ChatCompleteResult;
}

// ─── Judgments (Jev) ────────────────────────────────────────────────────────

export interface ChoiceJudgment {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

/**
 * One `choice` classification on the PLATFORM tier (`POST
 * /internal/platform-judgments`): org-less. chat-service declares the spend on
 * its own platform run, a child of `callerRunId` (this service's run doing the
 * work), so nothing is declared here.
 */
export async function platformChoiceJudgment(params: {
  callerRunId: string;
  state: string | Record<string, unknown>;
  instructions: string;
  criteria: Record<string, string>;
}): Promise<ChoiceJudgment> {
  const res = await fetchWithRetry(`${baseUrl()}/internal/platform-judgments`, {
    method: "POST",
    headers: buildPlatformHeaders(params.callerRunId),
    body: JSON.stringify({
      state: params.state,
      questions: { answer: { type: "choice", instructions: params.instructions, criteria: params.criteria } },
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[apollo-service][chat-client] POST /internal/platform-judgments returned ${res.status}: ${text}`);
  }
  const body = (await res.json()) as { answers?: Record<string, ChoiceJudgment> };
  const answer = body.answers?.answer;
  if (!answer || answer.type !== "choice" || typeof answer.choice !== "string") {
    throw new Error(`[apollo-service][chat-client] platform-judgments answered without a choice: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return answer;
}
