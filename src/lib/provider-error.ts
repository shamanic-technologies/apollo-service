/**
 * Provider-unable-to-serve signal — the machine-readable half of an Apollo
 * failure.
 *
 * This service already knows, at the single Apollo chokepoint, when a rejected
 * response means "Apollo has no credits left" (`looksLikeApolloCreditExhaustion`).
 * Until now that knowledge only produced a staff email: the HTTP caller got the
 * same opaque failure it gets for a transient blip, so nothing downstream could
 * tell "the provider is dry, stop trying" from "that one call failed, retry".
 * Two credit-exhaustion episodes (2026-07-28, 2026-08-22) each produced
 * thousands of identical retries and a customer who was told nothing.
 *
 * THE CONTRACT (additive, non-breaking):
 *   - HTTP status and the existing `type` / `error` body fields are UNCHANGED.
 *     A caller that ignores this signal sees byte-identical behaviour.
 *   - When — and only when — the failure is the provider being unable to serve
 *     us, the error body carries an extra `providerError` object:
 *
 *       "providerError": {
 *         "provider": "apollo",
 *         "code": "provider_credits_exhausted",
 *         "retryable": false,
 *         "message": "..."
 *       }
 *
 *   - `providerError` is ABSENT on every ordinary/transient failure, so the two
 *     are never conflated and no consumer has to count repeated failures (or
 *     regex a provider's prose) to infer the state.
 *
 * `code` reuses the vocabulary already established with
 * transactional-email-service's staff alert (`eventType:
 * "provider_credits_exhausted"`, shipped in #211) — one word for one state
 * across the fleet.
 *
 * Deciding what to DO about it (stop the campaign, back off, tell the customer)
 * belongs to the callers. This module only states the truth.
 */

/** Stable code: the provider cannot serve us because its credits are exhausted. */
export const PROVIDER_CREDITS_EXHAUSTED = "provider_credits_exhausted" as const;

export interface ProviderErrorDetail {
  /** Which upstream provider could not serve the request. */
  provider: "apollo";
  /** Stable machine-readable state. Switch on this, never on `message`. */
  code: typeof PROVIDER_CREDITS_EXHAUSTED;
  /**
   * false — the same call will keep failing until the provider recovers
   * (credits topped up). Retrying is not worth it.
   */
  retryable: false;
  /** Human-readable explanation. Never parse this; it may change. */
  message: string;
}

const CREDITS_EXHAUSTED_MESSAGE =
  "Apollo cannot serve requests: its lead credits are exhausted. Retrying will keep failing until the Apollo plan is topped up.";

/**
 * Thrown by the Apollo client when a rejected Apollo response means the account
 * is out of credits. Carries the ready-to-serve `providerError` body fragment so
 * route handlers stay one-liners.
 *
 * `message` is byte-identical to the generic Error this replaces, so anything
 * logging or surfacing `err.message` is unaffected.
 */
export class ApolloCreditsExhaustedError extends Error {
  readonly providerError: ProviderErrorDetail;
  /** Raw upstream status, for logs/alerts. Not part of the caller contract. */
  readonly apolloStatus: number;

  constructor(message: string, apolloStatus: number) {
    super(message);
    this.name = "ApolloCreditsExhaustedError";
    this.apolloStatus = apolloStatus;
    this.providerError = {
      provider: "apollo",
      code: PROVIDER_CREDITS_EXHAUSTED,
      retryable: false,
      message: CREDITS_EXHAUSTED_MESSAGE,
    };
  }
}

/**
 * Body fragment to spread into an error response. Returns `{ providerError }`
 * for a provider-cannot-serve failure and an EMPTY object for everything else —
 * so the field is present exactly when the state is true, and the response for
 * an ordinary failure is unchanged.
 */
export function providerErrorFields(
  error: unknown,
): { providerError?: ProviderErrorDetail } {
  if (error instanceof ApolloCreditsExhaustedError) {
    return { providerError: error.providerError };
  }
  return {};
}
