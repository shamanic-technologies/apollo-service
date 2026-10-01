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
vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn(async () => ({ id: "verify-run-1" })),
  updateRun: vi.fn(async () => ({})),
  addCosts: vi.fn(async (_r: string, items: any[]) => ({ costs: [{ id: items[0].status === "provisioned" ? "hold-1" : "actual-1" }] })),
  updateCostStatus: vi.fn(async () => ({})),
}));
vi.mock("../../src/lib/billing-client.js", () => ({ authorizeCredit: vi.fn(async () => ({ sufficient: true, balance_cents: 100, required_cents: 1 })) }));
vi.mock("../../src/lib/keys-client.js", () => ({ decryptKey: vi.fn(async () => ({ key: "apify-token", keySource: "platform" })) }));
vi.mock("../../src/db/index.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [] }) }) }) }),
    insert: () => ({ values: (v: any) => ({ returning: async () => [{ id: "ver-1", verifiedAt: new Date(), ...v }] }) }),
  },
}));
vi.mock("../../src/db/schema.js", () => ({
  emailVerifications: { email: "email", verdict: "verdict", verifiedAt: "verified_at" },
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("looksLikeApifyCreditExhaustion", () => {
  it("recognises Apify's usage limits and nothing else", async () => {
    const { looksLikeApifyCreditExhaustion } = await import("../../src/lib/email-verification.js");
    expect(looksLikeApifyCreditExhaustion(403, HARD_LIMIT)).toBe(true);
    expect(looksLikeApifyCreditExhaustion(402, '{"error":{"type":"not-enough-usage-to-run-paid-actor"}}')).toBe(true);
    expect(looksLikeApifyCreditExhaustion(502, "<html>502 Bad Gateway</html>")).toBe(false);
    expect(looksLikeApifyCreditExhaustion(403, '{"error":{"type":"insufficient-permissions"}}')).toBe(false);
    expect(looksLikeApifyCreditExhaustion(null, "apify unreachable: timeout")).toBe(false);
  });
});

describe("verifyRevealedEmail when Apify is out of usage", () => {
  it("emails staff (provider apify) and fails with a providerError the caller can switch on", async () => {
    fetchMock.mockResolvedValue(new Response(HARD_LIMIT, { status: 403 }));
    const { verifyRevealedEmail, EmailVerificationError } = await import("../../src/lib/email-verification.js");
    const { providerErrorFields } = await import("../../src/lib/provider-error.js");

    const err = await verifyRevealedEmail("ada@example.com", CTX).catch((e) => e);
    expect(err).toBeInstanceOf(EmailVerificationError);
    expect(providerErrorFields(err)).toEqual({
      providerError: expect.objectContaining({ provider: "apify", code: "provider_credits_exhausted", retryable: false }),
    });
    expect(mockReport).toHaveBeenCalledTimes(1);
    const [provider, identity, detail] = mockReport.mock.calls[0];
    expect(provider).toBe("apify");
    expect(identity).toMatchObject({ orgId: "org-1", userId: "user-1", runId: "run-1" });
    expect(detail).toMatchObject({ upstreamStatus: 403 });
    expect(detail.upstreamBody).toContain("Monthly usage hard limit exceeded");
  });

  it("an ordinary Apify outage raises no alert and no providerError", async () => {
    fetchMock.mockResolvedValue(new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const { providerErrorFields } = await import("../../src/lib/provider-error.js");
    const err = await verifyRevealedEmail("ada@example.com", CTX).catch((e) => e);
    expect(providerErrorFields(err)).toEqual({});
    expect(mockReport).not.toHaveBeenCalled();
  });

  it("a batch keeps the signal when one of its addresses hit the wall", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify([{ email: "a@x.com", status: "valid" }]), { status: 200 }))
      .mockResolvedValue(new Response(HARD_LIMIT, { status: 403 }));
    const { verifyEmailBatch } = await import("../../src/lib/email-verification.js");
    const { providerErrorFields } = await import("../../src/lib/provider-error.js");
    const err = await verifyEmailBatch(["a@x.com", "b@x.com"], CTX).catch((e) => e);
    expect(providerErrorFields(err).providerError?.provider).toBe("apify");
  });
});
