import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  searchPeople,
  enrichPerson,
  matchPersonByName,
  APOLLO_PLACEHOLDER_EMAIL,
} from "../../src/lib/apollo-client.js";
import {
  reportApolloCreditsExhausted,
  toCreditAlertIdentity,
  PROVIDER_CREDITS_EXHAUSTED_EVENT,
} from "../../src/lib/credit-alert.js";

/**
 * Running out of Apollo credits used to be silent: the placeholder email was
 * nulled at enrichment and a 402/429 surfaced as a generic 500. These tests pin
 * that both signals now raise a staff alert through transactional-email-service,
 * and that raising it never changes what the Apollo call itself returns/throws.
 */

const IDENTITY = {
  orgId: "org-1",
  userId: "user-1",
  runId: "run-1",
  brandIds: ["brand-1"],
  campaignId: "campaign-1",
};

/** Flush the detached alert send so its fetch call is observable. */
async function flushAlert(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function alertCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes("/platform-send"));
}

describe("Apollo credit-exhaustion staff alert", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.TRANSACTIONAL_EMAIL_SERVICE_URL = "http://transactional-email-service:8080";
    process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY = "test-key";
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Apollo rejects the call, alert path answers 200. */
  function apolloRejects(status: number, body = "out of credits") {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/platform-send")) {
        return { ok: true, status: 200, json: async () => ({ results: [] }) };
      }
      return { ok: false, status, text: async () => body };
    });
  }

  /** Apollo answers 200 with the given person payload. */
  function apolloReturnsPerson(person: Record<string, unknown>) {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/platform-send")) {
        return { ok: true, status: 200, json: async () => ({ results: [] }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ person }) };
    });
  }

  it("alerts and still throws when Apollo answers 402", async () => {
    apolloRejects(402);

    await expect(enrichPerson("key", "person-1", undefined, IDENTITY)).rejects.toThrow(
      /Apollo enrich failed: 402/,
    );
    await flushAlert();

    const calls = alertCalls(fetchMock);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0][1].body as string);
    expect(body.eventType).toBe(PROVIDER_CREDITS_EXHAUSTED_EVENT);
    expect(body.metadata.provider).toBe("apollo");
    expect(body.metadata.apolloStatus).toBe("402");
    expect(body.metadata.apolloBody).toContain("out of credits");
  });

  it("alerts and still throws when Apollo answers 429", async () => {
    apolloRejects(429, "quota exceeded");

    await expect(searchPeople("key", { person_titles: ["CEO"] }, IDENTITY)).rejects.toThrow(
      /Apollo search failed: 429/,
    );
    await flushAlert();

    expect(alertCalls(fetchMock)).toHaveLength(1);
  });

  it("alerts when Apollo answers 200 with the email_not_unlocked sentinel", async () => {
    apolloReturnsPerson({ id: "p1", email: APOLLO_PLACEHOLDER_EMAIL, email_status: "verified" });

    const result = await enrichPerson("key", "person-1", undefined, IDENTITY);
    await flushAlert();

    // The Apollo response is returned untouched — the alert is a side effect.
    expect(result.person.email).toBe(APOLLO_PLACEHOLDER_EMAIL);

    const calls = alertCalls(fetchMock);
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0][1].body as string);
    expect(body.metadata.reason).toContain(APOLLO_PLACEHOLDER_EMAIL);
    expect(body.metadata.apolloStatus).toBeUndefined();
  });

  it("alerts on the sentinel via people/match too", async () => {
    apolloReturnsPerson({ id: "p1", email: APOLLO_PLACEHOLDER_EMAIL, email_status: "verified" });

    await matchPersonByName("key", "Ada", "Lovelace", "example.com", undefined, IDENTITY);
    await flushAlert();

    expect(alertCalls(fetchMock)).toHaveLength(1);
  });

  it("does NOT alert on a non-credit Apollo error (422)", async () => {
    apolloRejects(422, "no implicit conversion of String into Integer");

    await expect(searchPeople("key", { person_titles: ["CEO"] }, IDENTITY)).rejects.toThrow(
      /Apollo search failed: 422/,
    );
    await flushAlert();

    expect(alertCalls(fetchMock)).toHaveLength(0);
  });

  it("does NOT alert on a normal verified-email response", async () => {
    apolloReturnsPerson({ id: "p1", email: "ada@example.com", email_status: "verified" });

    const result = await enrichPerson("key", "person-1", undefined, IDENTITY);
    await flushAlert();

    expect(result.person.email).toBe("ada@example.com");
    expect(alertCalls(fetchMock)).toHaveLength(0);
  });

  it("does not break the Apollo call when the alert transport fails", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/platform-send")) throw new Error("transactional-email down");
      return { ok: false, status: 402, text: async () => "out of credits" };
    });

    // The Apollo error still surfaces; the alert failure is logged, not thrown.
    await expect(enrichPerson("key", "person-1", undefined, IDENTITY)).rejects.toThrow(
      /Apollo enrich failed: 402/,
    );
    await flushAlert();

    expect(errorSpy).toHaveBeenCalled();
  });

  it("skips the alert (with a warning) when the caller carries no org", async () => {
    apolloRejects(402);

    await expect(enrichPerson("key", "person-1")).rejects.toThrow(/Apollo enrich failed: 402/);
    await flushAlert();

    expect(alertCalls(fetchMock)).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("no org"));
  });

  it("forwards the caller's identity headers so the org is attributed", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ results: [] }) });

    reportApolloCreditsExhausted(IDENTITY, { operation: "people/match", reason: "test" });
    await flushAlert();

    const [url, init] = alertCalls(fetchMock)[0];
    expect(url).toBe("http://transactional-email-service:8080/platform-send");
    expect(init.headers["x-api-key"]).toBe("test-key");
    expect(init.headers["x-org-id"]).toBe("org-1");
    expect(init.headers["x-user-id"]).toBe("user-1");
    expect(init.headers["x-run-id"]).toBe("run-1");
    expect(init.headers["x-brand-id"]).toBe("brand-1");
    expect(init.headers["x-campaign-id"]).toBe("campaign-1");
  });

  it("toCreditAlertIdentity returns undefined without an org", () => {
    expect(toCreditAlertIdentity({ userId: "user-1" })).toBeUndefined();
    expect(toCreditAlertIdentity({ orgId: "org-1" })?.orgId).toBe("org-1");
  });
});
