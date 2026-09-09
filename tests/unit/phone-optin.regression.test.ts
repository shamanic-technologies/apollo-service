import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The reveal must stay OPT-IN: an ordinary enrichment sends the exact body it
 * always sent, so no existing caller starts paying phone-reveal credits.
 */

const okResponse = () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ person: { id: "p-1", email: null, email_status: null } }),
  json: async () => ({ person: { id: "p-1" } }),
});

function bodyOf(mockFetch: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return JSON.parse(mockFetch.mock.calls[0][1].body as string);
}

describe("phone reveal is opt-in", () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.APOLLO_SERVICE_PUBLIC_URL;
    delete process.env.APOLLO_PHONE_REVEAL_WEBHOOK_SECRET;
  });

  it("enrichPerson omits reveal_phone_number entirely by default", async () => {
    const { enrichPerson } = await import("../../src/lib/apollo-client.js");
    await enrichPerson("key", "p-1");
    expect(bodyOf(mockFetch)).not.toHaveProperty("reveal_phone_number");
  });

  it("enrichPerson sends reveal_phone_number only when asked", async () => {
    const { enrichPerson } = await import("../../src/lib/apollo-client.js");
    await enrichPerson("key", "p-1", "https://apollo.test/webhook/phone-reveal?secret=s", undefined, {
      revealPhoneNumber: true,
    });
    const body = bodyOf(mockFetch);
    expect(body.reveal_phone_number).toBe(true);
    expect(body.webhook_url).toBe("https://apollo.test/webhook/phone-reveal?secret=s");
  });

  it("matchPersonByName never reveals a phone", async () => {
    const { matchPersonByName } = await import("../../src/lib/apollo-client.js");
    await matchPersonByName("key", "Ada", "Lovelace", "example.com");
    expect(bodyOf(mockFetch)).not.toHaveProperty("reveal_phone_number");
  });

  it("bulkEnrichPeople never reveals a phone", async () => {
    const { bulkEnrichPeople } = await import("../../src/lib/apollo-client.js");
    await bulkEnrichPeople("key", ["p-1"]);
    expect(bodyOf(mockFetch)).not.toHaveProperty("reveal_phone_number");
  });

  it("buildPhoneRevealWebhookUrl needs both env vars — no callback, no spend", async () => {
    const mod = await import("../../src/lib/apollo-client.js");
    expect(mod.buildPhoneRevealWebhookUrl()).toBeUndefined();

    process.env.APOLLO_SERVICE_PUBLIC_URL = "https://apollo.distribute.you";
    expect(mod.buildPhoneRevealWebhookUrl()).toBeUndefined();

    process.env.APOLLO_PHONE_REVEAL_WEBHOOK_SECRET = "s3cret";
    expect(mod.buildPhoneRevealWebhookUrl()).toBe("https://apollo.distribute.you/webhook/phone-reveal?secret=s3cret");
  });
});

describe("phone-reveal helpers", () => {
  it("prefers the mobile and treats an unknown DNC value as do-not-call", async () => {
    const { normalizePhoneNumbers, pickPrimaryPhone, primaryNumber } = await import("../../src/lib/phone-reveal.js");
    const phones = normalizePhoneNumbers([
      { raw_number: "+1 555-000-1111", sanitized_number: "+15550001111", type: "work_hq", dnc_status: null },
      { raw_number: "+1 555-222-3333", sanitized_number: "+15552223333", type: "mobile", dnc_status: "something_new" },
    ]);
    const primary = pickPrimaryPhone(phones);
    expect(primaryNumber(primary)).toBe("+15552223333");
    expect(primary?.doNotCall).toBe(true);
    expect(phones[0].doNotCall).toBe(false);
  });

  it("reports no number as an empty list — never a guess", async () => {
    const { normalizePhoneNumbers, pickPrimaryPhone, primaryNumber } = await import("../../src/lib/phone-reveal.js");
    expect(normalizePhoneNumbers(undefined)).toEqual([]);
    expect(normalizePhoneNumbers([{ type: "mobile" }])).toEqual([]);
    expect(primaryNumber(pickPrimaryPhone([]))).toBeNull();
  });
});
