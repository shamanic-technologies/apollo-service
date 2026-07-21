import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchPeople, VERIFIED_EMAIL_STATUS } from "../../src/lib/apollo-client.js";

/**
 * Verified-email-only is the STANDARD for every Apollo people-search this
 * service performs (count/dry-run, serve pagination, refine sizing). All of
 * those route through `searchPeople`, which FORCES
 * contact_email_status:["verified"] on the request body — overriding whatever
 * the caller passed. These tests pin that enforcement at the single chokepoint.
 */
describe("searchPeople forces verified-email-only", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ people: [], total_entries: 0 }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sentBody(): Record<string, unknown> {
    const [, init] = fetchMock.mock.calls[0];
    return JSON.parse((init as RequestInit).body as string);
  }

  it("injects contact_email_status:['verified'] when the caller omits it", async () => {
    await searchPeople("key", { person_titles: ["Chiropractor"], page: 1, per_page: 1 });
    expect(sentBody().contact_email_status).toEqual(["verified"]);
  });

  it("OVERRIDES a caller-supplied contact_email_status (e.g. ['unverified'])", async () => {
    await searchPeople("key", {
      person_titles: ["Chiropractor"],
      contact_email_status: ["unverified", "likely to engage"],
      page: 2,
      per_page: 100,
    });
    // The caller's value is dropped — verified-only is non-negotiable.
    expect(sentBody().contact_email_status).toEqual(["verified"]);
    // Other params still pass through untouched.
    expect(sentBody().person_titles).toEqual(["Chiropractor"]);
    expect(sentBody().page).toBe(2);
    expect(sentBody().per_page).toBe(100);
  });

  it("the forced value matches the exported VERIFIED_EMAIL_STATUS constant", async () => {
    await searchPeople("key", { person_titles: ["CEO"] });
    expect(sentBody().contact_email_status).toEqual([...VERIFIED_EMAIL_STATUS]);
    expect(VERIFIED_EMAIL_STATUS).toEqual(["verified"]);
  });
});
