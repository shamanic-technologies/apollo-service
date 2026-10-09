import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  revealPerson,
  revealCostItems,
  resetRevealRoute,
  ownKeyExhausted,
  OWN_KEY_EXHAUSTED_RECHECK_MS,
  TREG_APOLLO_MATCH_URL,
} from "../../src/lib/apollo-reveal-route.js";
import { ApolloCreditsExhaustedError } from "../../src/lib/provider-error.js";

/**
 * 2026-10-09: the platform Apollo team ran out of lead credits three days
 * before the next cycle; every reveal 422'd. Platform reveals now fall back to
 * Apollo through treg (`apollo.people.enrich`), billed at treg's own charge.
 */
const EXHAUSTED = () =>
  new ApolloCreditsExhaustedError(
    'Apollo enrich failed: 422 - {"error":"You have insufficient credits!","error_details":{"code":"BILLING.LIMIT.CREDITS_EXHAUSTED"}}',
    422
  );
const PERSON = { id: "p1", email: "a@b.com", email_status: "verified" };

function tregFetch(costMicro: string | null = "26000", status = 200) {
  return vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ ...(costMicro !== null && { "x-treg-cost-micro": costMicro }), "x-treg-call-id": "call-1" }),
    text: async () => (status === 200 ? JSON.stringify({ person: PERSON, request_id: 123456789012345678 }) : '{"error":"insufficient_balance"}'),
  })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

const creds = async () => ({ token: "t", org: "distribute-you" });

beforeEach(() => resetRevealRoute());

describe("revealPerson", () => {
  it("serves from our own key when it answers", async () => {
    const fetchImpl = tregFetch();
    const r = await revealPerson("platform", { own: async () => ({ person: PERSON as never }), tregQuery: { id: "p1" }, callerPath: "/enrich", credentials: creds, fetchImpl });
    expect(r.via).toBe("apollo");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("platform key out of credits: answered by treg with Apollo's query, then treg directly for the recheck window", async () => {
    let t = 1_000;
    const fetchImpl = tregFetch();
    const own = vi.fn(async () => {
      throw EXHAUSTED();
    });
    const deps = { own, tregQuery: { id: "p1", reveal_personal_emails: "false" }, callerPath: "/enrich", credentials: creds, fetchImpl, now: () => t };

    const r = await revealPerson("platform", deps);
    expect(r).toMatchObject({ via: "treg", tregCostMicro: 26000, tregCallId: "call-1" });
    expect(r.response.person).toMatchObject({ id: "p1" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${TREG_APOLLO_MATCH_URL}?id=p1&reveal_personal_emails=false`);
    expect(init).toMatchObject({ method: "POST", headers: { "X-Treg-Token": "t", "X-Treg-Org": "distribute-you" } });

    await revealPerson("platform", deps);
    expect(own).toHaveBeenCalledTimes(1);

    t += OWN_KEY_EXHAUSTED_RECHECK_MS;
    expect(ownKeyExhausted(t)).toBe(false);
    await revealPerson("platform", deps);
    expect(own).toHaveBeenCalledTimes(2);
  });

  it("an org's own key (BYOK) is never rerouted", async () => {
    const fetchImpl = tregFetch();
    await expect(
      revealPerson("org", { own: async () => { throw EXHAUSTED(); }, tregQuery: { id: "p1" }, callerPath: "/enrich", credentials: creds, fetchImpl })
    ).rejects.toBeInstanceOf(ApolloCreditsExhaustedError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("any other Apollo error is not rerouted", async () => {
    const fetchImpl = tregFetch();
    await expect(
      revealPerson("platform", { own: async () => { throw new Error("Apollo enrich failed: 500 - boom"); }, tregQuery: { id: "p1" }, callerPath: "/enrich", credentials: creds, fetchImpl })
    ).rejects.toThrow(/500 - boom/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("treg failing (402 balance) or answering without a charge header fails loud", async () => {
    const deps = (fetchImpl: typeof fetch) => ({ own: async () => { throw EXHAUSTED(); }, tregQuery: { id: "p1" }, callerPath: "/enrich", credentials: creds, fetchImpl });
    await expect(revealPerson("platform", deps(tregFetch("26000", 402)))).rejects.toThrow(/treg apollo.people.enrich failed: 402/);
    await expect(revealPerson("platform", deps(tregFetch(null)))).rejects.toThrow(/X-Treg-Cost-Micro/);
  });
});

describe("revealCostItems", () => {
  const apollo = { response: {}, via: "apollo" as const, tregCostMicro: null, tregCallId: null };
  const treg = (c: number) => ({ response: {}, via: "treg" as const, tregCostMicro: c, tregCallId: "x" });

  it("our key: 1 apollo-credit when Apollo billed a person", () => {
    expect(revealCostItems(apollo, true, "platform")).toEqual([{ costName: "apollo-credit", costSource: "platform", quantity: 1 }]);
    expect(revealCostItems(apollo, false, "platform")).toEqual([]);
  });

  it("treg: treg's own charge as treg-micro-usd, never an apollo-credit", () => {
    expect(revealCostItems(treg(26000), true, "platform")).toEqual([{ costName: "treg-micro-usd", costSource: "platform", quantity: 26000 }]);
    expect(revealCostItems(treg(0), true, "platform")).toEqual([]);
  });
});
