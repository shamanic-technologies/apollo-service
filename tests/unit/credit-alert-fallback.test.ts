import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { enrichPerson, getOrganizationById } from "../../src/lib/apollo-client.js";
import { revealPerson, withTregFallback, resetRevealRoute } from "../../src/lib/apollo-reveal-route.js";

/**
 * MON-APOLLO-CREDITS-1111: « A paid data provider is out of credits » was raised
 * 25 times in 30 days while every one of those calls was answered by Apollo
 * through treg (the platform fallback). The alert fired at the Apollo
 * chokepoint BEFORE the fallback ran. It must fire only when the client path
 * really lost data: BYOK out of credits, or our key out AND treg failing.
 */

const APOLLO_INSUFFICIENT_CREDITS_BODY =
  '{"error":"You have insufficient credits! Upgrade your plan to increase your number of lead credits.","error_details":{"code":"BILLING.LIMIT.CREDITS_EXHAUSTED"}}';

const IDENTITY = { orgId: "org-1", userId: "user-1", runId: "run-1" };
const creds = async () => ({ token: "t", org: "distribute-you" });

function tregFetch(status = 200, body = '{"person":{"id":"p1"},"organization":{"id":"o1"}}') {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "x-treg-cost-micro": "26000", "x-treg-call-id": "call-1" }),
    text: async () => body,
  })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("credit alert behind the treg fallback", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const alerts = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/platform-send"));

  beforeEach(() => {
    resetRevealRoute();
    process.env.TRANSACTIONAL_EMAIL_SERVICE_URL = "http://transactional-email-service:8080";
    process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "test-key";
    fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/platform-send")) return new Response("{}", { status: 200 });
      // Every Apollo call: our key is out of credits.
      return new Response(APOLLO_INSUFFICIENT_CREDITS_BODY, { status: 422 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("platform reveal served by treg: no staff alert", async () => {
    const r = await revealPerson("platform", {
      own: () => enrichPerson("k", "p1", undefined, IDENTITY),
      tregQuery: { id: "p1" },
      callerPath: "/enrich",
      credentials: creds,
      fetchImpl: tregFetch(),
      alertIdentity: IDENTITY,
    });
    await settle();
    expect(r.via).toBe("treg");
    expect(alerts()).toHaveLength(0);
  });

  it("organizations/{id} (the 2026-11-11 alert) served by treg: no staff alert", async () => {
    const r = await withTregFallback("platform", {
      own: () => getOrganizationById("k", "o1", IDENTITY),
      treg: { endpoint: "apollo.companies.enrich", method: "GET", query: { domain: "acme.com" } },
      callerPath: "/audiences/:apolloAudienceId/companies",
      credentials: creds,
      fetchImpl: tregFetch(),
      alertIdentity: IDENTITY,
    });
    await settle();
    expect(r.via).toBe("treg");
    expect(alerts()).toHaveLength(0);
  });

  it("our key out AND treg failing: one staff alert naming both walls", async () => {
    await expect(
      revealPerson("platform", {
        own: () => enrichPerson("k", "p1", undefined, IDENTITY),
        tregQuery: { id: "p1" },
        callerPath: "/enrich",
        credentials: creds,
        fetchImpl: tregFetch(402, '{"error":"insufficient_balance"}'),
        alertIdentity: IDENTITY,
      }),
    ).rejects.toThrow(/treg apollo.people.enrich failed: 402/);
    await settle();
    expect(alerts()).toHaveLength(1);
    const body = JSON.parse(String(alerts()[0][1].body));
    expect(body.metadata.reason).toMatch(/out-of-credits message; the treg fallback failed too: treg apollo.people.enrich failed: 402/);
    expect(alerts()[0][1].headers["x-org-id"]).toBe("org-1");
  });

  it("recheck window (our key skipped) AND treg failing: alerts on the caller's identity", async () => {
    const deps = {
      own: () => enrichPerson("k", "p1", undefined, IDENTITY),
      tregQuery: { id: "p1" },
      callerPath: "/enrich",
      credentials: creds,
      fetchImpl: tregFetch(),
      alertIdentity: IDENTITY,
    };
    await revealPerson("platform", deps); // opens the window, served
    await settle();
    expect(alerts()).toHaveLength(0);
    await expect(revealPerson("platform", { ...deps, fetchImpl: tregFetch(500, "boom") })).rejects.toThrow(/500/);
    await settle();
    expect(alerts()).toHaveLength(1);
    const body = JSON.parse(String(alerts()[0][1].body));
    expect(body.metadata.reason).toMatch(/treg fallback failed too/);
  });

  it("BYOK out of credits: no fallback, the alert still fires", async () => {
    await expect(
      revealPerson("org", {
        own: () => enrichPerson("k", "p1", undefined, IDENTITY),
        tregQuery: { id: "p1" },
        callerPath: "/enrich",
        credentials: creds,
        fetchImpl: tregFetch(),
        alertIdentity: IDENTITY,
      }),
    ).rejects.toThrow(/422/);
    await settle();
    expect(alerts()).toHaveLength(1);
  });
});
