import type { AuthorizeCreditResult } from "./billing-client.js";

const FUNNEL_CAP_ERRORS: Record<string, string> = {
  sales_funnel_max_budget_reached: "Sales funnel max budget reached",
  sales_funnel_max_budget_unreadable: "Sales funnel max budget could not be measured",
};

/**
 * The 402 body for a refused authorize. A balance shortfall keeps the exact
 * body every caller already parses. A funnel-cap refusal keeps `type`
 * (callers stop on it, no retry) but names the real cause in `error` and
 * passes billing's `reason` + `sales_funnel_cap` through verbatim.
 */
export function creditRefusalBody(auth: AuthorizeCreditResult): Record<string, unknown> {
  const base = {
    type: "credit_insufficient",
    error: "Insufficient credits",
    balance_cents: auth.balance_cents,
    required_cents: auth.required_cents,
  };
  if (!auth.reason) return base;
  return {
    ...base,
    error: FUNNEL_CAP_ERRORS[auth.reason] ?? `Refused by billing: ${auth.reason}`,
    reason: auth.reason,
    ...(auth.sales_funnel_cap ? { sales_funnel_cap: auth.sales_funnel_cap } : {}),
  };
}

/** One-line description of a refusal, for thrown errors and logs. */
export function describeCreditRefusal(auth: AuthorizeCreditResult): string {
  const body = creditRefusalBody(auth);
  return `${body.error} (balance=${auth.balance_cents}¢, required=${auth.required_cents}¢${auth.reason ? `, reason=${auth.reason}` : ""})`;
}
