import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Pre-serve verification: every revealed address gets a BounceVerify verdict,
 * held verdicts are reused, only `valid` is deliverable, and a failure is loud.
 */

const mockCreateRun = vi.fn();
const mockUpdateRun = vi.fn();
const mockAddCosts = vi.fn();
const mockUpdateCostStatus = vi.fn();
vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...a: unknown[]) => mockCreateRun(...a),
  updateRun: (...a: unknown[]) => mockUpdateRun(...a),
  addCosts: (...a: unknown[]) => mockAddCosts(...a),
  updateCostStatus: (...a: unknown[]) => mockUpdateCostStatus(...a),
}));
const mockAuthorizeCredit = vi.fn();
vi.mock("../../src/lib/billing-client.js", () => ({ authorizeCredit: (...a: unknown[]) => mockAuthorizeCredit(...a) }));
const mockDecryptKey = vi.fn();
vi.mock("../../src/lib/keys-client.js", () => ({ decryptKey: (...a: unknown[]) => mockDecryptKey(...a) }));

let heldRows: any[] = [];
const inserted: any[] = [];
vi.mock("../../src/db/index.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => heldRows }) }) }) }),
    insert: () => ({
      values: (v: any) => ({
        returning: async () => {
          const row = { id: `ver-${inserted.length + 1}`, verifiedAt: new Date("2026-09-25T10:00:00Z"), ...v };
          inserted.push(row);
          return [row];
        },
      }),
    }),
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

function actor(rows: unknown, status = 200) {
  return new Response(JSON.stringify(rows), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  heldRows = [];
  inserted.length = 0;
  mockCreateRun.mockResolvedValue({ id: "verify-run-1" });
  mockUpdateRun.mockResolvedValue({});
  mockAddCosts.mockImplementation(async (_r: string, items: any[]) => ({ costs: [{ id: items[0].status === "provisioned" ? "hold-1" : "actual-1" }] }));
  mockUpdateCostStatus.mockResolvedValue({});
  mockAuthorizeCredit.mockResolvedValue({ sufficient: true, balance_cents: 100, required_cents: 1 });
  mockDecryptKey.mockResolvedValue({ key: "apify-token", keySource: "platform" });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("verifyRevealedEmail", () => {
  it("valid → deliverable, billed exactly 1, hold released, raw row stored", async () => {
    fetchMock.mockResolvedValue(actor([{ email: "Ada@Example.com", status: "valid", is_catch_all: false }]));
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail(" Ada@Example.com ", CTX);

    expect(r).toMatchObject({ email: "ada@example.com", verdict: "valid", deliverable: true, verifier: "bounceverify", reused: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("bounceverify~bounceverify-email-verifier/run-sync-get-dataset-items");
    expect(init.headers.Authorization).toBe("Bearer apify-token");
    expect(JSON.parse(init.body)).toEqual({ emails: ["ada@example.com"] });

    expect(mockAuthorizeCredit).toHaveBeenCalledWith(expect.objectContaining({ items: [{ costName: "apify-bounceverify-email", quantity: 1 }] }));
    expect(mockAddCosts).toHaveBeenNthCalledWith(1, "verify-run-1", [{ costName: "apify-bounceverify-email", costSource: "platform", quantity: 1, status: "provisioned" }], expect.anything());
    expect(mockAddCosts).toHaveBeenNthCalledWith(2, "verify-run-1", [{ costName: "apify-bounceverify-email", costSource: "platform", quantity: 1, status: "actual" }], expect.anything());
    expect(mockUpdateCostStatus).toHaveBeenCalledWith("verify-run-1", "hold-1", "cancelled", expect.anything());
    expect(mockUpdateRun).toHaveBeenCalledWith("verify-run-1", "completed", expect.anything());
    expect(inserted[0]).toMatchObject({ email: "ada@example.com", verdict: "valid", billed: true, source: "enrich", rawResult: { email: "Ada@Example.com", status: "valid", is_catch_all: false } });
  });

  it("catch_all → NOT deliverable (still billed: decisive)", async () => {
    fetchMock.mockResolvedValue(actor([{ email: "ada@example.com", status: "valid", is_catch_all: true }]));
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail("ada@example.com", CTX);
    expect(r).toMatchObject({ verdict: "catch_all", deliverable: false });
    expect(mockAddCosts).toHaveBeenCalledTimes(2);
  });

  it("unknown → NOT deliverable and free (no actual cost)", async () => {
    fetchMock.mockResolvedValue(actor([{ email: "ada@example.com", status: "unknown" }]));
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail("ada@example.com", CTX);
    expect(r).toMatchObject({ verdict: "unknown", deliverable: false });
    expect(mockAddCosts).toHaveBeenCalledTimes(1);
    expect(inserted[0].billed).toBe(false);
  });

  it("reuses a held decisive verdict: no key, no authorize, no call, no cost", async () => {
    heldRows = [{ id: "ver-old", email: "ada@example.com", verdict: "invalid", verifiedAt: new Date("2026-09-20T00:00:00Z") }];
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail("ada@example.com", CTX);
    expect(r).toMatchObject({ verdict: "invalid", deliverable: false, reused: true, verificationId: "ver-old" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockDecryptKey).not.toHaveBeenCalled();
    expect(mockAddCosts).not.toHaveBeenCalled();
  });

  it("an actor failure throws, releases the hold, fails the run, and stores the error", async () => {
    fetchMock.mockResolvedValue(actor({ error: "boom" }, 500));
    const { verifyRevealedEmail, EmailVerificationError } = await import("../../src/lib/email-verification.js");
    await expect(verifyRevealedEmail("ada@example.com", CTX)).rejects.toBeInstanceOf(EmailVerificationError);
    expect(mockUpdateCostStatus).toHaveBeenCalledWith("verify-run-1", "hold-1", "cancelled", expect.anything());
    expect(mockUpdateRun).toHaveBeenCalledWith("verify-run-1", "failed", expect.anything());
    expect(inserted[0]).toMatchObject({ verdict: null, httpStatus: 500 });
    expect(inserted[0].error).toContain("500");
  });

  it("insufficient balance throws before any call or hold", async () => {
    mockAuthorizeCredit.mockResolvedValue({ sufficient: false, balance_cents: 0, required_cents: 1 });
    const { verifyRevealedEmail, EmailVerificationError } = await import("../../src/lib/email-verification.js");
    await expect(verifyRevealedEmail("ada@example.com", CTX)).rejects.toBeInstanceOf(EmailVerificationError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockAddCosts).not.toHaveBeenCalled();
  });

  it("a missing apify key throws a legible error", async () => {
    mockDecryptKey.mockRejectedValue(new Error("apify key not configured for this organization"));
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    await expect(verifyRevealedEmail("ada@example.com", CTX)).rejects.toThrow(/"apify" key/);
  });

  it("no address → no verification (null), nothing called", async () => {
    const { verificationFor } = await import("../../src/lib/email-verification.js");
    expect(await verificationFor(null, CTX)).toBeNull();
    expect(await verificationFor("  ", CTX)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("mapVerdict", () => {
  it("invalid is terminal; catch-all cannot confirm; a spam trap is risky", async () => {
    const { mapVerdict } = await import("../../src/lib/email-verification.js");
    expect(mapVerdict({ status: "invalid", is_catch_all: true })).toBe("invalid");
    expect(mapVerdict({ status: "valid", is_catch_all: true })).toBe("catch_all");
    expect(mapVerdict({ status: "valid", is_spamtrap: true })).toBe("risky");
    expect(mapVerdict({ status: "valid" })).toBe("valid");
    expect(mapVerdict(undefined)).toBe("unknown");
  });
});
