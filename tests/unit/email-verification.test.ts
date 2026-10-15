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
  emailVerifications: { email: "email", verdict: "verdict", verifiedAt: "verified_at", rawResult: "raw_result" },
}));
const mockDomainHasMx = vi.fn();
vi.mock("../../src/lib/mail-domain.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/mail-domain.js")>()),
  domainHasMx: (...a: unknown[]) => mockDomainHasMx(...a),
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
  mockDomainHasMx.mockReset();
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

  describe("a TIMED-OUT actor run gets one longer second chance (VERIFY-TIMEOUT-1014)", () => {
    const timedOut = () =>
      actor({ error: { type: "run-failed", message: "Actor run did not succeed (run ID: XdYBX0KRc2FI3cqrP, status: TIMED-OUT)." } }, 400);

    it("times out once, then answers: the verdict comes back in the SAME call, billed once, one bronze row", async () => {
      fetchMock
        .mockResolvedValueOnce(timedOut())
        .mockResolvedValueOnce(actor([{ email: "tz-ny-1014@distribute.you", status: "valid", is_catch_all: true }]));
      const { verifyRevealedEmail, ACTOR_RETRY_TIMEOUT_S } = await import("../../src/lib/email-verification.js");
      const r = await verifyRevealedEmail("tz-ny-1014@distribute.you", CTX);

      expect(r).toMatchObject({ verdict: "catch_all", deliverable: false, reused: false });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toContain("timeout=60");
      expect(fetchMock.mock.calls[1][0]).toContain(`timeout=${ACTOR_RETRY_TIMEOUT_S}`);
      expect(ACTOR_RETRY_TIMEOUT_S).toBeGreaterThan(60);
      expect(mockAddCosts).toHaveBeenCalledTimes(2);
      expect(mockAddCosts).toHaveBeenNthCalledWith(2, "verify-run-1", [expect.objectContaining({ status: "actual", quantity: 1 })], expect.anything());
      expect(mockUpdateRun).toHaveBeenCalledWith("verify-run-1", "completed", expect.anything());
      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toMatchObject({ verdict: "catch_all", httpStatus: 200, error: null, billed: true });
    });

    it("keeps timing out: still NO verdict, fails loud with the reason, bills nothing, hold cancelled, no third call", async () => {
      fetchMock.mockImplementation(async () => timedOut());
      const { verifyRevealedEmail, EmailVerificationError } = await import("../../src/lib/email-verification.js");
      const err = await verifyRevealedEmail("gate-nobody-1014@distribute.you", CTX).catch((e) => e);

      expect(err).toBeInstanceOf(EmailVerificationError);
      expect(err.message).toMatch(/TIMED-OUT/);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mockAddCosts).toHaveBeenCalledTimes(1); // the hold only, never an actual
      expect(mockUpdateCostStatus).toHaveBeenCalledWith("verify-run-1", "hold-1", "cancelled", expect.anything());
      expect(mockUpdateRun).toHaveBeenCalledWith("verify-run-1", "failed", expect.anything());
      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toMatchObject({ verdict: null, httpStatus: 400, billed: false });
      expect(inserted[0].error).toContain("TIMED-OUT");
    });

    it("a run-failed that is NOT a timeout is not retried", async () => {
      fetchMock.mockResolvedValue(actor({ error: { type: "run-failed", message: "Actor run did not succeed (run ID: x, status: FAILED)." } }, 400));
      const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
      await expect(verifyRevealedEmail("ada@example.com", CTX)).rejects.toThrow(/FAILED/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("isActorTimeout: 400 TIMED-OUT and 408 only", async () => {
      const { isActorTimeout } = await import("../../src/lib/email-verification.js");
      expect(isActorTimeout({ httpStatus: 400, error: "apify bounceverify responded 400: ... status: TIMED-OUT)." })).toBe(true);
      expect(isActorTimeout({ httpStatus: 408, error: "apify bounceverify responded 408: timeout" })).toBe(true);
      expect(isActorTimeout({ httpStatus: 400, error: "apify bounceverify responded 400: invalid input" })).toBe(false);
      expect(isActorTimeout({ httpStatus: 200, error: null })).toBe(false);
      expect(isActorTimeout({ httpStatus: null, error: "apify unreachable: The operation was aborted due to timeout" })).toBe(false);
    });
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

describe("vendor 'Domain does not exist' is checked against our own DNS (DNE-FALSE-INVALID-1015)", () => {
  // The actor's real row for team@definitejobsgroup.co.uk (prod 2026-10-15): the domain has MX, no A record.
  const dneRow = (email: string) => ({
    email, status: "invalid", reason: "Domain does not exist", domain_exists: false, mx_found: false, mx_records: [],
    smtp_valid: null, is_catch_all: false, is_spamtrap: false, syntax_valid: true, score: 5,
  });

  it("domain HAS MX → verdict unknown (sendable, never valid), billed as the vendor charged, stored for reuse", async () => {
    fetchMock.mockResolvedValue(actor([dneRow("team@definitejobsgroup.co.uk")]));
    mockDomainHasMx.mockResolvedValue(true);
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail("team@definitejobsgroup.co.uk", CTX);

    expect(mockDomainHasMx).toHaveBeenCalledWith("definitejobsgroup.co.uk");
    expect(r).toMatchObject({ verdict: "unknown", deliverable: false, reused: false });
    expect(inserted[0]).toMatchObject({ verdict: "unknown", billed: true, rawResult: expect.objectContaining({ status: "invalid", reason: "Domain does not exist" }) });
    expect(mockAddCosts).toHaveBeenNthCalledWith(2, "verify-run-1", [expect.objectContaining({ status: "actual" })], expect.anything());
  });

  it("domain truly has NO MX → still invalid", async () => {
    fetchMock.mockResolvedValue(actor([dneRow("ada@gmail.con")]));
    mockDomainHasMx.mockResolvedValue(false);
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail("ada@gmail.con", CTX);
    expect(r).toMatchObject({ verdict: "invalid", deliverable: false });
    expect(inserted[0]).toMatchObject({ verdict: "invalid", billed: true });
  });

  it("a mailbox-level invalid (the domain's server refused it) is NOT re-checked", async () => {
    fetchMock.mockResolvedValue(actor([{ email: "ada@example.com", status: "invalid", domain_exists: true, mx_found: true, reason: "Mailbox does not exist" }]));
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail("ada@example.com", CTX);
    expect(r.verdict).toBe("invalid");
    expect(mockDomainHasMx).not.toHaveBeenCalled();
  });

  it("our DNS cannot answer → no verdict (loud), the vendor's charge still declared", async () => {
    fetchMock.mockResolvedValue(actor([dneRow("team@definitejobsgroup.co.uk")]));
    const { MailDomainLookupError } = await import("../../src/lib/mail-domain.js");
    mockDomainHasMx.mockRejectedValue(new MailDomainLookupError("definitejobsgroup.co.uk", new Error("queryMx ETIMEOUT")));
    const { verifyRevealedEmail, EmailVerificationError } = await import("../../src/lib/email-verification.js");
    await expect(verifyRevealedEmail("team@definitejobsgroup.co.uk", CTX)).rejects.toBeInstanceOf(EmailVerificationError);
    expect(inserted[0]).toMatchObject({ verdict: null, billed: true });
    expect(inserted[0].error).toContain("ETIMEOUT");
    expect(mockAddCosts).toHaveBeenNthCalledWith(2, "verify-run-1", [expect.objectContaining({ status: "actual" })], expect.anything());
    expect(mockUpdateRun).toHaveBeenCalledWith("verify-run-1", "failed", expect.anything());
  });

  it("a HELD 'Domain does not exist' invalid on a domain with MX is not reused as invalid: a free unknown row replaces it", async () => {
    heldRows = [{ id: "ver-old", email: "team@definitejobsgroup.co.uk", verdict: "invalid", httpStatus: 201, rawResult: dneRow("team@definitejobsgroup.co.uk"), verifiedAt: new Date("2026-10-15T12:10:22Z") }];
    mockDomainHasMx.mockResolvedValue(true);
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail("team@definitejobsgroup.co.uk", CTX);

    expect(r).toMatchObject({ verdict: "unknown", deliverable: false, reused: true });
    expect(r.verificationId).not.toBe("ver-old");
    expect(inserted[0]).toMatchObject({ verdict: "unknown", billed: false, verifyRunId: null, rawResult: expect.objectContaining({ reason: "Domain does not exist" }) });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockDecryptKey).not.toHaveBeenCalled();
    expect(mockAddCosts).not.toHaveBeenCalled();
  });

  it("a HELD 'Domain does not exist' invalid on a domain with NO MX is reused as invalid", async () => {
    heldRows = [{ id: "ver-old", email: "ada@gmail.con", verdict: "invalid", rawResult: dneRow("ada@gmail.con"), verifiedAt: new Date("2026-10-15T00:00:00Z") }];
    mockDomainHasMx.mockResolvedValue(false);
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail("ada@gmail.con", CTX);
    expect(r).toMatchObject({ verdict: "invalid", reused: true, verificationId: "ver-old" });
    expect(inserted).toHaveLength(0);
  });

  it("a held unknown WE decided (vendor row says invalid) is reused: the vendor is not paid again", async () => {
    heldRows = [{ id: "ver-fixed", email: "team@definitejobsgroup.co.uk", verdict: "unknown", rawResult: dneRow("team@definitejobsgroup.co.uk"), verifiedAt: new Date("2026-10-15T00:00:00Z") }];
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail("team@definitejobsgroup.co.uk", CTX);
    expect(r).toMatchObject({ verdict: "unknown", reused: true, verificationId: "ver-fixed" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockDomainHasMx).not.toHaveBeenCalled();
  });
});
