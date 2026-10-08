import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: {} }));

import {
  OrgLookupBudget,
  BACKGROUND_HOURLY_SHARE,
  HOURLY_LIMIT_COOLDOWN_MS,
  MINUTE_LIMIT_COOLDOWN_MS,
} from "../../src/lib/org-lookup-budget.js";
import { ApolloRateLimitedError, lookupOrganizationsByName } from "../../src/lib/apollo-client.js";
import { decideReveal, LookupMemo, type GateDeps } from "../../src/lib/reveal-domain-gate.js";
import { resolveEmployerDomains, type EmployerDomainDeps } from "../../src/lib/teaser-employer-domains.js";

/**
 * 2026-10-08 17:46-17:52 UTC (Shockwave): the teaser employer-domain fill and
 * the paid reveal gate share Apollo's 400/hour organizations/search quota. A
 * resumed campaign's backlog burst ~45 background lookups a minute, the hour
 * ran out, and two POST /enrich serves 500'd on the 429.
 */
const HOURLY_BODY =
  '{"message":"The maximum number of api calls allowed for api/v1/organizations/search is 400 times per hour. Please upgrade your plan from https://app.apollo.io/#/settings/plans/upgrade?source=api_rate_limit.","error_details":{"code":"USAGE.RATE_LIMIT.API_RATE_LIMIT_EXCEEDED"}}';
const MINUTE_BODY = HOURLY_BODY.replace("400 times per hour", "200 times per minute");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OrgLookupBudget", () => {
  it("lets the background fill spend only its share of the hour, then frees it as the window slides", () => {
    let t = 0;
    const b = new OrgLookupBudget(() => t);
    for (let i = 0; i < BACKGROUND_HOURLY_SHARE - 1; i++) b.recordCall();
    expect(b.backgroundRefusal()).toBeNull();
    b.recordCall();
    expect(b.backgroundRefusal()).toMatch(/background share/);
    t = 60 * 60 * 1000 + 1;
    expect(b.usedLastHour()).toBe(0);
    expect(b.backgroundRefusal()).toBeNull();
  });

  it("pauses the background fill after a 429: 10 min on the hourly window, 1 min on the minute window", () => {
    let t = 0;
    const b = new OrgLookupBudget(() => t);
    b.recordRateLimited(MINUTE_BODY);
    expect(b.backgroundRefusal()).toMatch(/paused/);
    t = MINUTE_LIMIT_COOLDOWN_MS;
    expect(b.backgroundRefusal()).toBeNull();
    b.recordRateLimited(HOURLY_BODY);
    t += HOURLY_LIMIT_COOLDOWN_MS - 1;
    expect(b.backgroundRefusal()).toMatch(/paused/);
    t += 1;
    expect(b.backgroundRefusal()).toBeNull();
  });
});

describe("lookupOrganizationsByName — priorities", () => {
  it("background: refused BEFORE any request once its share is spent (the serves' reserve stays whole)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const b = new OrgLookupBudget();
    for (let i = 0; i < BACKGROUND_HOURLY_SHARE; i++) b.recordCall();
    await expect(lookupOrganizationsByName("k", "Acme", 10, undefined, "background", b)).rejects.toBeInstanceOf(ApolloRateLimitedError);
    expect(fetchMock).not.toHaveBeenCalled();
    // A serve still goes out.
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ organizations: [{ id: "o1", name: "Acme" }] }) });
    await expect(lookupOrganizationsByName("k", "Acme", 10, undefined, "serve", b)).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(b.usedLastHour()).toBe(BACKGROUND_HOURLY_SHARE + 1);
  });

  it("background: a 429 is not retried, throws ApolloRateLimitedError, and pauses the fill", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => HOURLY_BODY });
    vi.stubGlobal("fetch", fetchMock);
    const b = new OrgLookupBudget();
    const err = await lookupOrganizationsByName("k", "Acme", 10, undefined, "background", b).catch((e) => e);
    expect(err).toBeInstanceOf(ApolloRateLimitedError);
    expect(err.message).toMatch(/^Apollo organization lookup failed: 429 - /);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(b.backgroundRefusal()).toMatch(/paused/);
  });

  it("serve: an HOURLY 429 is not retried (the window does not clear in seconds)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => HOURLY_BODY });
    vi.stubGlobal("fetch", fetchMock);
    const b = new OrgLookupBudget();
    await expect(lookupOrganizationsByName("k", "Acme", 10, undefined, "serve", b)).rejects.toBeInstanceOf(ApolloRateLimitedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serve: a per-minute 429 is retried (and each retry counted)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => (++n === 1 ? { ok: false, status: 429, text: async () => MINUTE_BODY } : { ok: true, status: 200, json: async () => ({ organizations: [] }) }))
    );
    const b = new OrgLookupBudget();
    const p = lookupOrganizationsByName("k", "Acme", 10, undefined, "serve", b);
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual([]);
    expect(b.usedLastHour()).toBe(2);
    vi.useRealTimers();
  });
});

describe("reveal gate — never fails a paid serve on the org lookup quota", () => {
  const deps = (lookupOrganizations: GateDeps["lookupOrganizations"]): GateDeps => ({
    employerOf: async () => "Dugas Dental",
    lookupOrganizations,
    revealedEmailDomains: async () => [],
    domainVerdicts: async () => [],
    probe: async () => {
      throw new Error("no probe expected");
    },
  });

  it("a rate-limited lookup reveals with basis org_lookup_rate_limited", async () => {
    const d = deps(async () => {
      throw new ApolloRateLimitedError("Apollo organization lookup failed: 429 - " + HOURLY_BODY);
    });
    expect(await decideReveal("p1", d)).toEqual({ action: "reveal", basis: "org_lookup_rate_limited", organizationName: "Dugas Dental" });
  });

  it("any other lookup failure still throws (fail loud)", async () => {
    const d = deps(async () => {
      throw new Error("Apollo organization lookup failed: 500 - boom");
    });
    await expect(decideReveal("p1", d)).rejects.toThrow(/500 - boom/);
  });
});

describe("LookupMemo", () => {
  it("reuses a name's candidates within the TTL (normalized name), re-asks after it, never stores a failure", async () => {
    let t = 0;
    const memo = new LookupMemo(1000, 10, () => t);
    const lookup = vi.fn(async () => [{ id: "o1", name: "Jump Trading" }]);
    await memo.get("Jump Trading", lookup);
    await memo.get("  jump   trading ", lookup);
    expect(lookup).toHaveBeenCalledTimes(1);
    t = 1000;
    await memo.get("Jump Trading", lookup);
    expect(lookup).toHaveBeenCalledTimes(2);
    const failing = vi.fn(async () => {
      throw new Error("x");
    });
    await expect(memo.get("Other", failing)).rejects.toThrow();
    await expect(memo.get("Other", failing)).rejects.toThrow();
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("evicts the oldest past max", async () => {
    const memo = new LookupMemo(60_000, 2);
    const lookup = vi.fn(async (n: string) => [{ id: n }]);
    await memo.get("a", lookup);
    await memo.get("b", lookup);
    await memo.get("c", lookup);
    await memo.get("a", lookup);
    expect(lookup).toHaveBeenCalledTimes(4);
  });
});

describe("teaser employer-domain fill stops at the first quota refusal", () => {
  it("one refusal stops the page's remaining lookups", async () => {
    const lookup = vi.fn(async () => {
      throw new ApolloRateLimitedError("Apollo organization lookup skipped (background): paused");
    });
    const d: EmployerDomainDeps = { readCache: async () => [], writeCache: async () => {}, lookup, concurrency: 1 };
    const people = ["A", "B", "C", "D"].map((name) => ({ organization: { name } }));
    const out = await resolveEmployerDomains(people, d);
    expect(out.size).toBe(0);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
