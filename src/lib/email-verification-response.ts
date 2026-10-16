import type { AuthorizeCreditResult } from "./billing-client.js";
import { creditRefusalBody } from "./credit-refusal.js";
import { providerErrorFields, type ProviderErrorDetail } from "./provider-error.js";

/** The fields of an EmailVerificationError this answer reads (kept structural so route tests can mock email-verification). */
export interface VerificationFailure {
  message: string;
  providerError?: ProviderErrorDetail;
  creditRefusal?: AuthorizeCreditResult;
}

/**
 * The HTTP answer for a failed verification. A refusal by a SALES FUNNEL MAX
 * BUDGET is a 402 naming that cause (billing's `reason` + `sales_funnel_cap`
 * verbatim), never a verifier failure the caller would retry. Every other
 * failure keeps its 502.
 */
export function emailVerificationErrorResponse(error: VerificationFailure): { status: number; body: Record<string, unknown> } {
  if (error.creditRefusal?.reason) {
    return { status: 402, body: { ...creditRefusalBody(error.creditRefusal), source: "email-verification" } };
  }
  return { status: 502, body: { type: "email_verification", source: "email-verification", error: error.message, ...providerErrorFields(error) } };
}
