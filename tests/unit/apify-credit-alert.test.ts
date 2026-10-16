import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Apify running out of usage must not be silent: BounceVerify answers
 * 403 `platform-feature-disabled` "Monthly usage hard limit exceeded" (seen in
 * prod 2026-09-29: 4,801 failed verifications over 20 hours, nobody told).
 * Staff get the same email Apollo exhaustion sends, and callers get the same
 * `providerError` body field.
 */

const mockReport = vi.fn();
vi.mock("../../src/lib/credit-alert.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  reportProviderCreditsExhausted: (...a: unknown[]) => mockReport(...a),
}));
const mockAddCosts = vi.fn();
const mockCreateRun = vi.fn();
vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...a: unknown[]) => mockCreateRun(...a),
  updateRun: vi.fn(async () => ({})),
  addCosts: (...a: unknown[]) => mockAddCosts(...a),
  updateCostStatus: vi.fn(async () => ({})),
}));
const mockAuthorize = vi.fn();
vi.mock("../../src/lib/billing-client.js", () => ({ authorizeCredit: (...a: unknown[]) => mockAuthorize(...a) }));
vi.mock("../../src/lib/keys-client.js", () => ({ decryptKey: vi.fn(async (_o: string, _u: string, provider: string) => ({ key: `${provider}-key`, keySource: "platform" })) }));
const inserted: any[] = [];
vi.mock("../../src/db/index.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }),
    insert: () => ({
      values: (v: any) => ({
        returning: async () => {
          const row = { id: `ver-${inserted.length + 1}`, verifiedAt: new Date(), ...v };
          inserted.push(row);
          return [row];
        },
      }),
    }),
  },
}));
vi.mock("../../src/db/schema.js", () => ({
  emailVerifications: { email: "email", verdict: "verdict", verifiedAt: "verified_at", verifier: "verifier", rawResult: "raw_result" },
}));

const fetchMock = vi.fn();
const CTX = {
  identity: { orgId: "org-1", userId: "user-1", brandIds: ["b-1"], campaignId: "c-1" },
  tracking: { brandIds: ["b-1"], campaignId: "c-1" },
  runId: "run-1",
  source: "enrich",
};
// Apify's real body, verbatim from prod (email_verifications.error, 2026-09-29).
const HARD_LIMIT = JSON.stringify({ error: { type: "platform-feature-disabled", message: "Monthly usage hard limit exceeded" } }, null, 2);

beforeEach(async () => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  inserted.length = 0;
  mockCreateRun.mockResolvedValue({ id: "verify-run-1" });
  mockAddCosts.mockImplementation(async (_r: string, items: any[]) => ({ costs: [{ id: items[0].status === "provisioned" ? "hold-1" : "actual-1" }] }));
  mockAuthorize.mockResolvedValue({ sufficient: true, balance_cents: 100, required_cents: 1 });
  (await import("../../src/lib/email-verification.js")).resetApifyFallback();
  vi.stubGlobal("fetch", fetchMock);
});

const json = (body: unknown, status = 200, costMicro = "0") =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-treg-cost-micro": costMicro } });
/** Each vendor as it answered live (2026-10-16/17). */
const contactout = (status: string) => () => json({ status_code: 200, data: { status } });
const contactout429 = () => new Response("<html>Too Many Requests</html>", { status: 429, headers: { "x-treg-cost-micro": "0" } });
const trykitt = (validity: string) => () => json({ jobId: "01M5", email: "ada@example.com", validity, credits: { jobCredits: 0.0015 } }, 200, "1500");
const millionverifier = (result: string) => () => json({ email: "ada@example.com", result, quality: "good", error: "" }, 200, "1780");
const bounceban = (result: string) => () => json({ id: "bb-1", status: "success", result, is_accept_all: false }, 200, "4000");
const down = () => json({}, 503);

type Handlers = Partial<Record<"contactout" | "apify" | "trykitt" | "millionverifier" | "bounceban", () => Response>>;
function route(h: Handlers) {
  fetchMock.mockImplementation(async (url: string) => {
    const u = String(url);
    const v = u.includes("api.apify.com") ? "apify" : u.includes("contactout") ? "contactout" : u.includes("trykitt") ? "trykitt" : u.includes("millionverifier") ? "millionverifier" : u.includes("bounceban") ? "bounceban" : null;
    const fn = v ? h[v] : undefined;
    if (!fn) throw new Error(`unexpected fetch ${u}`);
    return fn();
  });
}
const calls = (part: string) => fetchMock.mock.calls.filter(([u]) => String(u).includes(part));
const holdsAndActuals = () => mockAddCosts.mock.calls.map((c) => [c[1][0].costName, c[1][0].quantity, c[1][0].status]);

describe("step 1 = ONE verdict from the cheapest verifier that ANSWERS (ContactOut → BounceVerify → TryKitt → MillionVerifier)", () => {
  it("ContactOut answers valid: kept, free, nobody else asked", async () => {
    route({ contactout: contactout("valid") });
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail("ada@example.com", CTX);
    expect(r).toMatchObject({ verdict: "valid", deliverable: true, verifier: "contactout" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls("contactout.people.email.verify")[0][0]).toBe("https://treg.to/call/contactout.people.email.verify?email=ada%40example.com");
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(inserted.map((r) => [r.verifier, r.verdict, r.costName, r.costQuantity])).toEqual([["contactout", "valid", "treg-micro-usd", 0]]);
  });

  it("an `unknown` does NOT move to the next step-1 verifier: BounceBan decides it", async () => {
    route({ contactout: contactout("unknown"), bounceban: bounceban("deliverable") });
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail("ada@example.com", CTX);
    expect(r).toMatchObject({ verdict: "valid", verifier: "bounceban" });
    expect(calls("api.apify.com")).toHaveLength(0);
    expect(inserted.map((r) => [r.verifier, r.verdict])).toEqual([["contactout", "unknown"], ["bounceban", "valid"]]);
  });

  it("a catch_all (ContactOut's accept_all) goes to BounceBan too; invalid and risky are kept", async () => {
    route({ contactout: contactout("accept_all"), bounceban: bounceban("undeliverable") });
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    expect(await verifyRevealedEmail("ada@example.com", CTX)).toMatchObject({ verdict: "invalid", verifier: "bounceban" });
    route({ contactout: contactout("invalid") });
    expect(await verifyRevealedEmail("bob@example.com", CTX)).toMatchObject({ verdict: "invalid", verifier: "contactout" });
  });

  it("Apify's exact 403 body: staff emailed once, the verification COMPLETES through TryKitt, vendor named, spend metered", async () => {
    route({ contactout: contactout429, apify: () => new Response(HARD_LIMIT, { status: 403 }), trykitt: trykitt("valid") });
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");

    const r = await verifyRevealedEmail("ada@example.com", CTX);
    expect(r).toMatchObject({ email: "ada@example.com", verdict: "valid", deliverable: true, verifier: "trykitt", reused: false });

    const [url, init] = calls("trykitt")[0];
    expect(url).toBe("https://treg.to/call/trykitt.people.email.verify");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ email: "ada@example.com", realtime: true });
    expect(init.headers).toMatchObject({ "X-Treg-Token": "treg-key", "X-Treg-Org": "treg-org-key" });

    expect(mockReport).toHaveBeenCalledTimes(1);
    const [provider, identity, detail] = mockReport.mock.calls[0];
    expect(provider).toBe("apify");
    expect(identity).toMatchObject({ orgId: "org-1", userId: "user-1", runId: "run-1" });
    expect(detail).toMatchObject({ upstreamStatus: 403 });
    expect(detail.upstreamBody).toContain("Monthly usage hard limit exceeded");

    // Apify: hold only (refused, nothing billed). TryKitt: hold 2000 → actual 1500 (treg's own figure).
    expect(holdsAndActuals()).toEqual([
      ["apify-bounceverify-email", 1, "provisioned"],
      ["treg-micro-usd", 2000, "provisioned"],
      ["treg-micro-usd", 1500, "actual"],
    ]);
    expect(mockCreateRun.mock.calls.map((c) => c[0].taskName)).toEqual(["verify-email-contactout", "verify-email", "verify-email-trykitt"]);
    expect(inserted.map((r) => [r.verifier, r.verdict, r.httpStatus, r.costName, r.costQuantity])).toEqual([
      ["contactout", null, 429, "treg-micro-usd", 0],
      ["bounceverify", null, 403, "apify-bounceverify-email", 0],
      ["trykitt", "valid", 200, "treg-micro-usd", 1500],
    ]);
    expect(inserted[2].rawResult).toMatchObject({ validity: "valid", jobId: "01M5" });
  });

  it("once Apify said it is out, the next verifications skip it (no round trip, no second alert)", async () => {
    route({ contactout: contactout429, apify: () => new Response(HARD_LIMIT, { status: 403 }), trykitt: trykitt("invalid") });
    const { verifyRevealedEmail, apifyOut } = await import("../../src/lib/email-verification.js");
    await verifyRevealedEmail("ada@example.com", CTX);
    await verifyRevealedEmail("bob@example.com", CTX);
    expect(apifyOut()).toBe(true);
    expect(calls("api.apify.com")).toHaveLength(1);
    expect(calls("trykitt")).toHaveLength(2);
    expect(mockReport).toHaveBeenCalledTimes(1);
  });

  it("TryKitt failing too → MillionVerifier answers", async () => {
    route({ contactout: contactout429, apify: () => new Response(HARD_LIMIT, { status: 403 }), trykitt: down, millionverifier: millionverifier("ok") });
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail("ada@example.com", CTX);
    expect(r).toMatchObject({ verdict: "valid", verifier: "millionverifier" });
    expect(calls("millionverifier")[0][0]).toBe("https://treg.to/call/millionverifier.people.email.verify?email=ada%40example.com&timeout=20");
    expect(holdsAndActuals().filter(([, , st]) => st === "actual")).toEqual([["treg-micro-usd", 1780, "actual"]]);
  });

  it("an ordinary Apify outage (502) also moves on, but raises no alert", async () => {
    route({ contactout: contactout429, apify: () => new Response("<html>502 Bad Gateway</html>", { status: 502 }), trykitt: trykitt("valid") });
    const { verifyRevealedEmail, apifyOut } = await import("../../src/lib/email-verification.js");
    expect(await verifyRevealedEmail("ada@example.com", CTX)).toMatchObject({ verifier: "trykitt" });
    expect(mockReport).not.toHaveBeenCalled();
    expect(apifyOut()).toBe(false);
  });

  it("EVERY step-1 verifier failing is loud, with the providerError a caller can switch on when Apify is out", async () => {
    route({ contactout: contactout429, apify: () => new Response(HARD_LIMIT, { status: 403 }), trykitt: down, millionverifier: down });
    const { verifyRevealedEmail, EmailVerificationError } = await import("../../src/lib/email-verification.js");
    const { providerErrorFields } = await import("../../src/lib/provider-error.js");
    const err = await verifyRevealedEmail("ada@example.com", CTX).catch((e) => e);
    expect(err).toBeInstanceOf(EmailVerificationError);
    expect(err.message).toMatch(/every step-1 verifier failed/);
    expect(err.message).toMatch(/contactout.*429.*bounceverify.*403.*trykitt.*503.*millionverifier.*503/s);
    expect(providerErrorFields(err)).toEqual({
      providerError: expect.objectContaining({ provider: "apify", code: "provider_credits_exhausted", retryable: false }),
    });
  });

  it("a MillionVerifier vendor error is a failure, not a verdict", async () => {
    route({ contactout: contactout429, apify: () => new Response(HARD_LIMIT, { status: 403 }), trykitt: down, millionverifier: () => json({ result: "", error: "Insufficient credits" }, 200, "0") });
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const err = await verifyRevealedEmail("ada@example.com", CTX).catch((e) => e);
    expect(err.message).toMatch(/millionverifier: Insufficient credits/);
  });
});

describe("vendor word mapping", () => {
  it("BounceBan: deliverable → valid (even accept-all), undeliverable → invalid, risky accept-all → catch_all", async () => {
    const { mapBounceBanResult } = await import("../../src/lib/email-verification.js");
    expect(mapBounceBanResult({ result: "deliverable", is_accept_all: true })).toBe("valid");
    expect(mapBounceBanResult({ result: "undeliverable" })).toBe("invalid");
    expect(mapBounceBanResult({ result: "risky", is_accept_all: true })).toBe("catch_all");
    expect(mapBounceBanResult({ result: "risky" })).toBe("risky");
    expect(mapBounceBanResult({ result: "unknown" })).toBe("unknown");
    expect(mapBounceBanResult({ result: "maybe" })).toBeNull();
  });

  it("step-1 verifier words", async () => {
    const { mapVerifierWord } = await import("../../src/lib/email-verification.js");
    expect(mapVerifierWord("valid")).toBe("valid");
    expect(mapVerifierWord("ok")).toBe("valid");
    expect(mapVerifierWord("invalid")).toBe("invalid");
    expect(mapVerifierWord("accept_all")).toBe("catch_all");
    expect(mapVerifierWord("catchall")).toBe("catch_all");
    expect(mapVerifierWord("catch_all")).toBe("catch_all");
    expect(mapVerifierWord("disposable")).toBe("risky");
    expect(mapVerifierWord("unknown")).toBe("unknown");
    expect(mapVerifierWord(undefined)).toBeNull();
  });

  it("needsSecondOpinion: a first-pass catch_all / unknown only", async () => {
    const { needsSecondOpinion } = await import("../../src/lib/email-verification.js");
    expect(needsSecondOpinion({ verifier: "bounceverify", verdict: "catch_all" })).toBe(true);
    expect(needsSecondOpinion({ verifier: "trykitt", verdict: "unknown" })).toBe(true);
    expect(needsSecondOpinion({ verifier: "bounceverify", verdict: "valid" })).toBe(false);
    expect(needsSecondOpinion({ verifier: "bounceban", verdict: "unknown" })).toBe(false);
  });
});

it("a batch keeps the signal when every step-1 verifier fails for one of its addresses", async () => {
  fetchMock.mockImplementation(async (url: string, init: any) => {
    const u = String(url);
    if (u.includes("contactout")) return contactout429();
    if (u.includes("api.apify.com")) {
      const email = JSON.parse(init.body).emails[0];
      return email === "a@x.com" ? new Response(JSON.stringify([{ email, status: "valid" }]), { status: 200 }) : new Response(HARD_LIMIT, { status: 403 });
    }
    return new Response("{}", { status: 502 });
  });
  const { verifyEmailBatch } = await import("../../src/lib/email-verification.js");
  const { providerErrorFields } = await import("../../src/lib/provider-error.js");
  const err = await verifyEmailBatch(["a@x.com", "b@x.com"], CTX).catch((e) => e);
  expect(providerErrorFields(err).providerError?.provider).toBe("apify");
});
