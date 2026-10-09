/**
 * Who answers a paid Apollo call: our own Apollo subscription, or Apollo
 * THROUGH treg when ours is out of credits. Covers people/match (/enrich,
 * /match, phone reveal, person role/identity), organizations/enrich
 * (firmographics), organizations/{id} (audience companies, via
 * organizations/enrich by domain) and job postings.
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

export const TREG_CALL_BASE = "https://treg.to/call/";
export const TREG_APOLLO_MATCH_ENDPOINT = "apollo.people.enrich";
export const TREG_APOLLO_MATCH_URL = `${TREG_CALL_BASE}${TREG_APOLLO_MATCH_ENDPOINT}`;
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

/** The treg cost line for a call it answered (none when it charged 0). */
export function tregCostItems(costMicro: number | null): Array<{ costName: string; costSource: "platform"; quantity: number }> {
  return costMicro && costMicro > 0 ? [{ costName: TREG_COST_NAME, costSource: "platform", quantity: costMicro }] : [];
}

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

/** One Apollo call through treg: treg's catalog id, its HTTP method, Apollo's own parameters (path ones included). */
export interface TregApolloCall {
  endpoint: string;
  method: "GET" | "POST";
  query: Record<string, string>;
}

/**
 * Apollo through treg. Any non-2xx is thrown with treg's status and body (a
 * 402 = treg balance). The charge header is required: it IS the cost we declare.
 */
export async function callApolloViaTreg<T>(
  call: TregApolloCall,
  creds: TregCredentials,
  fetchImpl: typeof fetch = fetch
): Promise<{ response: T; costMicro: number; callId: string | null }> {
  const url = `${TREG_CALL_BASE}${call.endpoint}?${new URLSearchParams(call.query).toString()}`;
  const res = await fetchImpl(url, {
    method: call.method,
    headers: { "X-Treg-Token": creds.token, "X-Treg-Org": creds.org },
    signal: AbortSignal.timeout(TREG_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`treg ${call.endpoint} failed: ${res.status} - ${text.slice(0, 500)}`);
  const rawCost = res.headers.get("x-treg-cost-micro");
  const costMicro = rawCost === null ? NaN : Number(rawCost);
  if (!Number.isFinite(costMicro) || costMicro < 0) throw new Error(`treg ${call.endpoint} answered without a readable X-Treg-Cost-Micro (${rawCost})`);
  const safe = text.replace(/"request_id"\s*:\s*(-?\d+)/, '"request_id":"$1"');
  return { response: JSON.parse(safe) as T, costMicro, callId: res.headers.get("x-treg-call-id") };
}

export interface FallbackDeps<T> {
  /** The call on our own Apollo key. */
  own: () => Promise<T>;
  /** The same call through treg, answering the same shape. */
  treg: TregApolloCall;
  callerPath: string;
  credentials?: () => Promise<TregCredentials>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Our Apollo key first; on its "out of credits" answer (platform key only)
 * the same call through treg, and treg directly for the recheck window.
 */
export async function withTregFallback<T>(keySource: "org" | "platform", deps: FallbackDeps<T>): Promise<RevealResult<T>> {
  const now = deps.now ?? Date.now;
  if (keySource !== "platform" || !ownKeyExhausted(now())) {
    try {
      return { response: await deps.own(), via: "apollo", tregCostMicro: null, tregCallId: null };
    } catch (error) {
      if (keySource !== "platform" || !(error instanceof ApolloCreditsExhaustedError)) throw error;
      ownKeyExhaustedUntil = now() + OWN_KEY_EXHAUSTED_RECHECK_MS;
      console.warn(`[Apollo Service][reveal-route] own Apollo key out of credits, calling Apollo through treg for ${OWN_KEY_EXHAUSTED_RECHECK_MS / 60000} min`);
    }
  }
  const creds = await (deps.credentials ?? (() => platformTregCredentials(deps.callerPath)))();
  const r = await callApolloViaTreg<T>(deps.treg, creds, deps.fetchImpl);
  return { response: r.response, via: "treg", tregCostMicro: r.costMicro, tregCallId: r.callId };
}

export interface RevealDeps<T> extends Omit<FallbackDeps<T>, "treg"> {
  /** Apollo's query-string parameters for the same `people/match`. */
  tregQuery: Record<string, string>;
}

/** A `people/match` (/enrich, /match, phone reveal): treg's `apollo.people.enrich`. */
export async function revealPerson<T extends { person?: ApolloPerson | null }>(
  keySource: "org" | "platform",
  deps: RevealDeps<T>
): Promise<RevealResult<T>> {
  return withTregFallback(keySource, { ...deps, treg: { endpoint: TREG_APOLLO_MATCH_ENDPOINT, method: "POST", query: deps.tregQuery } });
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
  if (reveal.via === "treg") return tregCostItems(reveal.tregCostMicro);
  return billedByApollo ? [{ costName: "apollo-credit", costSource: keySource, quantity: 1 }] : [];
}
