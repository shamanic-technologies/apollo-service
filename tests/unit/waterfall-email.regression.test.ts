import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Regression test: all Apollo enrichment/match calls MUST include
 * run_waterfall_email: true so that Apollo cascades through third-party
 * email providers when its own database has no email.
 *
 * Without this flag, ~70% of enrichments return no email.
 */

const fetchSpy = vi.fn();

beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ person: null, matches: [] }),
    text: () => Promise.resolve(""),
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function importClient() {
  // Fresh import each time to avoid module caching issues
  const mod = await import("../../src/lib/apollo-client.js");
  return mod;
}

function parsedBody(callIndex: number): Record<string, unknown> {
  const call = fetchSpy.mock.calls[callIndex];
  return JSON.parse(call[1].body);
}

describe("run_waterfall_email flag", () => {
  it("enrichPerson sends run_waterfall_email: true", async () => {
    const { enrichPerson } = await importClient();
    await enrichPerson("key", "person-123");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = parsedBody(0);
    expect(body.run_waterfall_email).toBe(true);
    expect(body.id).toBe("person-123");
  });

  it("matchPersonByName sends run_waterfall_email: true", async () => {
    const { matchPersonByName } = await importClient();
    await matchPersonByName("key", "John", "Doe", "acme.com");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = parsedBody(0);
    expect(body.run_waterfall_email).toBe(true);
    expect(body.first_name).toBe("John");
  });

  it("bulkMatchPeopleByName sends run_waterfall_email: true", async () => {
    const { bulkMatchPeopleByName } = await importClient();
    await bulkMatchPeopleByName("key", [
      { first_name: "John", last_name: "Doe", domain: "acme.com" },
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = parsedBody(0);
    expect(body.run_waterfall_email).toBe(true);
    expect(body.details).toHaveLength(1);
  });

  it("bulkEnrichPeople sends run_waterfall_email: true", async () => {
    const { bulkEnrichPeople } = await importClient();
    await bulkEnrichPeople("key", ["person-1", "person-2"]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = parsedBody(0);
    expect(body.run_waterfall_email).toBe(true);
    expect(body.details).toHaveLength(2);
  });
});

describe("webhook_url parameter", () => {
  it("sends webhook_url when provided", async () => {
    const { enrichPerson } = await importClient();
    await enrichPerson("key", "person-123", "https://example.com/webhook");

    const body = parsedBody(0);
    expect(body.webhook_url).toBe("https://example.com/webhook");
  });

  it("omits webhook_url when not provided", async () => {
    const { enrichPerson } = await importClient();
    await enrichPerson("key", "person-123");

    const body = parsedBody(0);
    expect(body.webhook_url).toBeUndefined();
  });

  it("buildWaterfallWebhookUrl returns undefined without env vars", async () => {
    const { buildWaterfallWebhookUrl } = await importClient();
    const url = buildWaterfallWebhookUrl();
    expect(url).toBeUndefined();
  });

  it("buildWaterfallWebhookUrl returns URL with env vars set", async () => {
    vi.stubEnv("APOLLO_SERVICE_PUBLIC_URL", "https://apollo.example.com");
    vi.stubEnv("APOLLO_WATERFALL_WEBHOOK_SECRET", "my-secret");

    // Need fresh import to pick up env vars
    const mod = await import("../../src/lib/apollo-client.js");
    const url = mod.buildWaterfallWebhookUrl();
    expect(url).toBe("https://apollo.example.com/webhook/waterfall?secret=my-secret");

    vi.unstubAllGlobals();
  });
});
