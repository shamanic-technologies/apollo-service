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
