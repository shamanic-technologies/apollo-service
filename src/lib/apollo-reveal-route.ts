/**
 * Who answers a paid Apollo `people/match` (the /enrich and /match reveals):
 * our own Apollo subscription, or Apollo THROUGH treg when ours is out of credits.
 *
 * 2026-10-09: the platform Apollo team used every lead credit of its billing
 * cycle (422 `BILLING.LIMIT.CREDITS_EXHAUSTED`) three days before the next
 * cycle, so every reveal failed and serves produced nothing. treg relays
 * Apollo's own `POST /people/match` (`apollo.people.enrich`, every parameter in
 * the query string) on treg's Apollo key and answers Apollo's response verbatim
 * (verified live: same `person` shape, verified email, $0.026 charged).
 *
 * Rule:
 *   - an org's OWN Apollo key (BYOK) is never rerouted: their key, their plan.
 *   - a platform reveal tries our key first; on `ApolloCreditsExhaustedError`
 *     it is answered by treg, and every platform reveal goes straight to treg
 *     for OWN_KEY_EXHAUSTED_RECHECK_MS before our key is tried again. So the
 *     fallback ends by itself when the subscription renews; nothing to revert.
 *   - the cost declared is treg's own charge (`X-Treg-Cost-Micro` header) as
 *     `treg-micro-usd`, never an `apollo-credit` we did not spend.
 */

import { decryptPlatformKey } from "./keys-client.js";
import { ApolloCreditsExhaustedError } from "./provider-error.js";
import type { ApolloPerson } from "./apollo-client.js";

export const TREG_APOLLO_MATCH_URL = "https://treg.to/call/apollo.people.enrich";
export const TREG_COST_NAME = "treg-micro-usd";
/** After our key says "out of credits", go to treg directly for this long before trying it again. */
export const OWN_KEY_EXHAUSTED_RECHECK_MS = 60 * 60 * 1000;
const TREG_TIMEOUT_MS = 30_000;

export type RevealRoute = "apollo" | "treg";

export interface RevealResult<T> {
  response: T;
  via: RevealRoute;
  /** treg's charge for this call, micro-USD (null on the apollo route). */
  tregCostMicro: number | null;
  tregCallId: string | null;
}

let ownKeyExhaustedUntil = 0;

/** Test hook. */
export function resetRevealRoute(): void {
  ownKeyExhaustedUntil = 0;
}

export function ownKeyExhausted(now: number = Date.now()): boolean {
  return now < ownKeyExhaustedUntil;
}

export interface TregCredentials {
  token: string;
  org: string;
}

async function platformTregCredentials(callerPath: string): Promise<TregCredentials> {
  const caller = { callerMethod: "POST", callerPath };
  const [token, org] = await Promise.all([decryptPlatformKey("treg", caller), decryptPlatformKey("treg-org", caller)]);
  return { token, org };
}

/**
 * Apollo `POST /people/match` through treg. `query` = Apollo's own parameters.
 * Any non-2xx is thrown with treg's status and body (a 402 = treg balance).
 */
export async function apolloMatchViaTreg<T>(
  query: Record<string, string>,
  creds: TregCredentials,
  fetchImpl: typeof fetch = fetch
): Promise<{ response: T; costMicro: number; callId: string | null }> {
  const url = `${TREG_APOLLO_MATCH_URL}?${new URLSearchParams(query).toString()}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "X-Treg-Token": creds.token, "X-Treg-Org": creds.org },
    signal: AbortSignal.timeout(TREG_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`treg apollo.people.enrich failed: ${res.status} - ${text.slice(0, 500)}`);
  const rawCost = res.headers.get("x-treg-cost-micro");
  const costMicro = rawCost === null ? NaN : Number(rawCost);
  // The charge IS the cost we declare: never guess it.
  if (!Number.isFinite(costMicro) || costMicro < 0) throw new Error(`treg apollo.people.enrich answered without a readable X-Treg-Cost-Micro (${rawCost})`);
  const safe = text.replace(/"request_id"\s*:\s*(-?\d+)/, '"request_id":"$1"');
  return { response: JSON.parse(safe) as T, costMicro, callId: res.headers.get("x-treg-call-id") };
}

export interface RevealDeps<T> {
  /** The call on our own Apollo key. */
  own: () => Promise<T>;
  /** Apollo's query-string parameters for the same match. */
  tregQuery: Record<string, string>;
  callerPath: string;
  credentials?: () => Promise<TregCredentials>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export async function revealPerson<T extends { person?: ApolloPerson | null }>(
  keySource: "org" | "platform",
  deps: RevealDeps<T>
): Promise<RevealResult<T>> {
  const now = deps.now ?? Date.now;
  if (keySource !== "platform" || !ownKeyExhausted(now())) {
    try {
      return { response: await deps.own(), via: "apollo", tregCostMicro: null, tregCallId: null };
    } catch (error) {
      if (keySource !== "platform" || !(error instanceof ApolloCreditsExhaustedError)) throw error;
      ownKeyExhaustedUntil = now() + OWN_KEY_EXHAUSTED_RECHECK_MS;
      console.warn(`[Apollo Service][reveal-route] own Apollo key out of credits, revealing through treg for ${OWN_KEY_EXHAUSTED_RECHECK_MS / 60000} min`);
    }
  }
  const creds = await (deps.credentials ?? (() => platformTregCredentials(deps.callerPath)))();
  const r = await apolloMatchViaTreg<T>(deps.tregQuery, creds, deps.fetchImpl);
  return { response: r.response, via: "treg", tregCostMicro: r.costMicro, tregCallId: r.callId };
}

/**
 * The cost line of one reveal: Apollo's 1 credit when our key billed a person,
 * treg's own charge when treg answered (none when it charged 0).
 */
export function revealCostItems(
  reveal: RevealResult<unknown>,
  billedByApollo: boolean,
  keySource: "org" | "platform"
): Array<{ costName: string; costSource: "org" | "platform"; quantity: number }> {
  if (reveal.via === "treg") {
    return reveal.tregCostMicro && reveal.tregCostMicro > 0 ? [{ costName: TREG_COST_NAME, costSource: "platform", quantity: reveal.tregCostMicro }] : [];
  }
  return billedByApollo ? [{ costName: "apollo-credit", costSource: keySource, quantity: 1 }] : [];
}
