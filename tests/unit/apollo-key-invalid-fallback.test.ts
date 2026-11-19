import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  revealPerson,
  resetRevealRoute,
  ownKeyExhausted,
  searchPeopleViaTregIfOwnKeyDown,
  isPlatformApolloKey,
  TREG_APOLLO_SEARCH_ENDPOINT,
  TREG_CALL_BASE,
} from "../../src/lib/apollo-reveal-route.js";
import { ApolloKeyInvalidError } from "../../src/lib/provider-error.js";
import { searchPeople } from "../../src/lib/apollo-client.js";

/**
 * APOLLO-KEY-401-1113: from 2026-11-12 ~08:05 UTC Apollo refused our platform
 * key (401 AUTH.AUTHENTICATION.API_KEY_INVALID). Only "out of credits" sent a
 * call through treg, and the free People Search had no treg route at all, so
 * every serve, dry-run and reveal failed for ~33 h.
 */
const APOLLO_401_BODY =
  '{"error":"Invalid API key.","error_details":{"code":"AUTH.AUTHENTICATION.API_KEY_INVALID","message":"This API key is not valid."}}';
const KEY_INVALID = () => new ApolloKeyInvalidError(`Apollo search failed: 401 - ${APOLLO_401_BODY}`, 401);
const creds = async () => ({ token: "t", org: "distribute-you" });
const SEARCH_BODY = { person_titles: ["Chiropractor"], contact_email_status: ["verified"], page: 1, per_page: 25 };

function tregSearchFetch(cost: string | null = "0", status = 200) {
  return vi.fn(async (_url: string, _init?: RequestInit) => ({
    ok: status === 200,
    status,
    headers: new Headers(cost !== null ? { "x-treg-cost-micro": cost } : {}),
    text: async () => (status === 200 ? JSON.stringify({ total_entries: 4150, people: [{ id: "x1" }] }) : '{"error":"down"}'),
  })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

beforeEach(() => resetRevealRoute());
afterEach(() => vi.unstubAllGlobals());

describe("Apollo 401 on our platform key", () => {
  it("searchPeople: Apollo's 401 on an org's own key surfaces as ApolloKeyInvalidError, nothing sent to treg", async () => {
    const f = vi.fn(async (url: string) =>
      String(url).includes("/keys/platform/apollo/decrypt")
        ? new Response(JSON.stringify({ key: "ours" }), { status: 200 })
        : new Response(APOLLO_401_BODY, { status: 401 })
    );
    vi.stubGlobal("fetch", f);
    const err = await searchPeople("org-key", { person_titles: ["CEO"] } as never).catch((e) => e);
    expect(err).toBeInstanceOf(ApolloKeyInvalidError);
    expect(err.message).toBe(`Apollo search failed: 401 - ${APOLLO_401_BODY}`);
    expect(f.mock.calls.some(([u]) => String(u).includes("treg.to"))).toBe(false);
  });

  it("a reveal on the platform key falls back to treg on a 401", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "x-treg-cost-micro": "26000" }),
      text: async () => JSON.stringify({ person: { id: "p1" } }),
    })) as unknown as typeof fetch;
    const r = await revealPerson("platform", {
      own: async () => {
        throw KEY_INVALID();
      },
      tregQuery: { id: "p1" },
      callerPath: "/enrich",
      credentials: creds,
      fetchImpl,
    });
    expect(r.via).toBe("treg");
    expect(ownKeyExhausted()).toBe(true);
  });

  it("a BYOK reveal is never rerouted on a 401", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      revealPerson("org", {
        own: async () => {
          throw KEY_INVALID();
        },
        tregQuery: { id: "p1" },
        callerPath: "/enrich",
        credentials: creds,
        fetchImpl,
      })
    ).rejects.toBeInstanceOf(ApolloKeyInvalidError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("a platform search 401 is answered by treg apollo.people.search with Apollo's own body, then treg directly", async () => {
    let t = 1_000;
    const fetchImpl = tregSearchFetch();
    const own = vi.fn(async () => {
      throw KEY_INVALID();
    });
    const deps = { isPlatformKey: async () => true, credentials: creds, fetchImpl, now: () => t };

    const r = await searchPeopleViaTregIfOwnKeyDown<{ total_entries: number }>("platform-key", SEARCH_BODY, own, deps);
    expect(r.total_entries).toBe(4150);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${TREG_CALL_BASE}${TREG_APOLLO_SEARCH_ENDPOINT}`);
    expect(JSON.parse(String(init!.body))).toEqual(SEARCH_BODY);

    t += 60_000;
    await searchPeopleViaTregIfOwnKeyDown("platform-key", SEARCH_BODY, own, deps);
    expect(own).toHaveBeenCalledTimes(1); // inside the recheck window our key is skipped
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("a BYOK search 401 is thrown, never rerouted", async () => {
    const fetchImpl = tregSearchFetch();
    await expect(
      searchPeopleViaTregIfOwnKeyDown("org-key", SEARCH_BODY, async () => {
        throw KEY_INVALID();
      }, { isPlatformKey: async () => false, credentials: creds, fetchImpl })
    ).rejects.toBeInstanceOf(ApolloKeyInvalidError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("an ordinary search failure (422 bad filter) is thrown, never rerouted", async () => {
    const fetchImpl = tregSearchFetch();
    const isPlatformKey = vi.fn(async () => true);
    await expect(
      searchPeopleViaTregIfOwnKeyDown("platform-key", SEARCH_BODY, async () => {
        throw new Error("Apollo search failed: 422 - bad range");
      }, { isPlatformKey, credentials: creds, fetchImpl })
    ).rejects.toThrow("422");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(ownKeyExhausted()).toBe(false);
  });

  it("a treg search that charges money fails loud (no cost name for a search)", async () => {
    const fetchImpl = tregSearchFetch("26000");
    await expect(
      searchPeopleViaTregIfOwnKeyDown("platform-key", SEARCH_BODY, async () => {
        throw KEY_INVALID();
      }, { isPlatformKey: async () => true, credentials: creds, fetchImpl })
    ).rejects.toThrow(/charged 26000/);
  });

  it("the happy path never asks key-service which key is ours", async () => {
    const isPlatformKey = vi.fn(async () => true);
    const r = await searchPeopleViaTregIfOwnKeyDown("platform-key", SEARCH_BODY, async () => ({ total_entries: 1 }), { isPlatformKey });
    expect(r).toEqual({ total_entries: 1 });
    expect(isPlatformKey).not.toHaveBeenCalled();
  });

  it("isPlatformApolloKey compares against key-service's platform key, cached", async () => {
    const load = vi.fn(async () => "ours");
    expect(await isPlatformApolloKey("ours", load, 0)).toBe(true);
    expect(await isPlatformApolloKey("theirs", load, 1_000)).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
