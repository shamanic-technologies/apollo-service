/**
 * Staff alert for "Apollo has run out of credits".
 *
 * Apollo signals credit exhaustion in two ways, both of which used to be silent
 * here: a 200 response whose `email` is the `email_not_unlocked@domain.com`
 * sentinel (an email exists but the plan/credits cannot reveal it), and an
 * outright 402/403/429 on the request. Without this alert the service keeps
 * running and simply produces nothing, which reads downstream like an exhausted
 * lead pool rather than a dry provider.
 *
 * transactional-email-service owns staff notifications: it holds the hardcoded
 * internal staff recipient list and the templates, and it owns the run/cost of
 * the send (apollo-service declares NONE for it — same relationship as with
 * chat-service for LLM spend). It also owns the send-rate bound: the alert event
 * is deduped per org per calendar day there, so a run that hits the wall on
 * thousands of consecutive people cannot mail-bomb. That is why there is no
 * throttle, counter or table on this side.
 *
 * Billing/attribution: the alert reuses the identity of the inbound request that
 * hit the wall (org-billed, per the fleet convention for auto-triggered
 * side-effects), so the staff email also tells us which org was affected.
 *
 * Env vars are read lazily inside the call, so their absence cannot break boot
 * or any existing endpoint — a missing var surfaces as a logged alert failure.
 */

import { fetchWithRetry } from "./fetch-retry.js";

/**
 * Event type accepted by transactional-email-service's staff-notification path
 * for "a paid third-party provider is out of credits".
 *
 * This string is the PRODUCER's contract, not ours: it must stay byte-equal to
 * the value documented in transactional-email-service's deployed OpenAPI, or the
 * send is rejected with 400. Do not rename it here to fit local vocabulary.
 */
export const PROVIDER_CREDITS_EXHAUSTED_EVENT = "provider_credits_exhausted";

/** Identity of the inbound request that hit the wall. Org-billed, staff-delivered. */
export interface CreditAlertIdentity {
  orgId: string;
  userId?: string;
  runId?: string;
  brandIds?: string[];
  campaignId?: string;
  audienceId?: string;
  featureSlug?: string;
  workflowSlug?: string;
}

/**
 * Lift the inbound request's identity so the alert is attributed to the org that
 * hit the wall. Accepts the auth middleware's decorated request without importing
 * it, so this module stays free of Express types.
 */
export function toCreditAlertIdentity(req: {
  orgId?: string;
  userId?: string;
  runId?: string;
  brandIds?: string[];
  campaignId?: string;
  audienceId?: string;
  featureSlug?: string;
  workflowSlug?: string;
}): CreditAlertIdentity | undefined {
  if (!req.orgId) return undefined;
  return {
    orgId: req.orgId,
    userId: req.userId,
    runId: req.runId,
    brandIds: req.brandIds,
    campaignId: req.campaignId,
    audienceId: req.audienceId,
    featureSlug: req.featureSlug,
    workflowSlug: req.workflowSlug,
  };
}

export interface CreditAlertDetail {
  /** Which Apollo call hit the wall, e.g. "people/match". */
  operation: string;
  /** Why we concluded Apollo is out of credits, in plain English. */
  reason: string;
  /** Apollo's HTTP status, when the signal was a rejected request. */
  apolloStatus?: number;
  /** Apollo's raw response body, truncated. Absent when the signal was the sentinel email. */
  apolloBody?: string;
}

/**
 * Fold the raw upstream evidence into the single free-form `detail` the staff
 * template renders. The template shows `provider`, `reason`, `orgId` and
 * `detail` — anything else we invent here would be stored but never displayed,
 * so the operation and the HTTP status belong inside these two strings.
 */
function buildDetail(detail: CreditAlertDetail): string {
  const parts = [`operation: ${detail.operation}`];
  if (detail.apolloStatus !== undefined) parts.push(`HTTP ${detail.apolloStatus}`);
  if (detail.apolloBody) parts.push(detail.apolloBody.slice(0, MAX_BODY_CHARS));
  return parts.join("\n");
}

/** Keep the staff email readable and the payload small. */
const MAX_BODY_CHARS = 500;

function buildHeaders(identity: CreditAlertIdentity): Record<string, string> {
  const apiKey = process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
  if (!apiKey) throw new Error("[apollo-service] TRANSACTIONAL_EMAIL_SERVICE_API_KEY is required");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": identity.orgId,
  };
  if (identity.userId) headers["x-user-id"] = identity.userId;
  if (identity.runId) headers["x-run-id"] = identity.runId;
  if (identity.brandIds?.length) headers["x-brand-id"] = identity.brandIds.join(",");
  if (identity.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity.audienceId) headers["x-audience-id"] = identity.audienceId;
  if (identity.featureSlug) headers["x-feature-slug"] = identity.featureSlug;
  if (identity.workflowSlug) headers["x-workflow-slug"] = identity.workflowSlug;
  return headers;
}

/** Send the staff alert. Throws on any failure — the caller decides what that costs. */
export async function sendApolloCreditsExhaustedAlert(
  identity: CreditAlertIdentity,
  detail: CreditAlertDetail,
): Promise<void> {
  const baseUrl = process.env.TRANSACTIONAL_EMAIL_SERVICE_URL;
  if (!baseUrl) throw new Error("[apollo-service] TRANSACTIONAL_EMAIL_SERVICE_URL is required");

  const res = await fetchWithRetry(`${baseUrl}/platform-send`, {
    method: "POST",
    headers: buildHeaders(identity),
    body: JSON.stringify({
      eventType: PROVIDER_CREDITS_EXHAUSTED_EVENT,
      ...(identity.brandIds?.length && { brandIds: identity.brandIds }),
      ...(identity.campaignId && { campaignId: identity.campaignId }),
      // `provider` and `reason` are REQUIRED non-empty by the producer (400
      // otherwise — a staff alert with blanks where the facts belong is not
      // actionable). `orgId` is filled in from x-org-id, so we do not send it.
      metadata: {
        provider: "apollo",
        reason: detail.reason,
        detail: buildDetail(detail),
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `[apollo-service][credit-alert] POST /platform-send returned ${res.status}: ${text}`,
    );
  }
}

/**
 * Fire the staff alert without making the caller's request depend on it.
 *
 * Deliberately detached: an alert that fails to send must not turn a customer's
 * enrichment into a 500. This is the auto-triggered-side-effect exception to the
 * fail-loud rule, not a swallowed error on the request path — the failure is
 * logged, and the Apollo error it accompanies is still thrown by the caller.
 *
 * Without an org there is nothing to send against (the staff path is org-scoped),
 * so an identity-less caller is logged and skipped rather than silently dropped.
 */
export function reportApolloCreditsExhausted(
  identity: CreditAlertIdentity | undefined,
  detail: CreditAlertDetail,
): void {
  if (!identity?.orgId) {
    console.warn(
      `[apollo-service][credit-alert] Apollo credits look exhausted (${detail.operation}: ${detail.reason}) but the caller carried no org — no staff alert sent`,
    );
    return;
  }

  console.warn(
    `[apollo-service][credit-alert] Apollo credits look exhausted (${detail.operation}: ${detail.reason}) orgId=${identity.orgId} — alerting staff`,
  );

  void sendApolloCreditsExhaustedAlert(identity, detail).catch((err) => {
    console.error("[apollo-service][credit-alert] Failed to send staff alert:", err);
  });
}
