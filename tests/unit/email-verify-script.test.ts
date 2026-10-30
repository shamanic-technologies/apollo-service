import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * FACTORY-P3 next outcomes (email_found): while workflow-service says the waterfall is switched for this service, the
 * stored script decides; each verifier call runs here through its door, on the script's run, with the same hold, run,
 * bronze row (naming the CALLER's run) and email_checked declaration; a refusal reaches the caller as our own error.
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

const inserted: any[] = [];
const decisions: any[] = [];
vi.mock("../../src/db/index.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (cond: { id?: string }) => {
          // The decided row, read back by id; every reuse / pending lookup finds nothing.
          const byId = cond?.id ? inserted.filter((r) => r.id === cond.id) : [];
          return Object.assign(Promise.resolve(byId), { orderBy: () => ({ limit: async () => [] }) });
        },
      }),
    }),
    insert: (table: string) => ({
      values: (v: any) => {
        if (table === "decisions") {
          decisions.push(v);
          return Promise.resolve();
        }
        return {
          returning: async () => {
            const row = { id: `ver-${inserted.length + 1}`, verifiedAt: new Date("2026-10-29T10:00:00Z"), ...v };
            inserted.push(row);
            return [row];
          },
        };
      },
    }),
  },
}));
vi.mock("drizzle-orm", async (orig) => ({
  ...(await orig<typeof import("drizzle-orm")>()),
  eq: (col: string, v: string) => (col === "id" ? { id: v } : {}),
}));
vi.mock("../../src/db/schema.js", () => ({
  emailVerifications: { id: "id", email: "email", verdict: "verdict", verifiedAt: "verified_at", rawResult: "raw_result", verifier: "verifier" },
  emailVerificationDecisions: "decisions",
}));
const mockRecordOutcome = vi.fn();
vi.mock("../../src/lib/outcome-declarations.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/outcome-declarations.js")>()),
  recordOutcomeDetached: (...a: unknown[]) => mockRecordOutcome(...a),
}));

// The switch and the script door, mocked: the "script" below asks the doors exactly as the stored script does.
const mockSwitch = vi.fn();
const mockDecide = vi.fn();
vi.mock("../../src/lib/email-verify-script.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/email-verify-script.js")>()),
  verifyScriptSwitch: (...a: unknown[]) => mockSwitch(...a),
  decideWithScript: (...a: unknown[]) => mockDecide(...a),
}));

const fetchMock = vi.fn();
const CTX = {
  identity: { orgId: "org-1", userId: "user-1", brandIds: ["b-1"], campaignId: "c-1" },
  tracking: { brandIds: ["b-1"], campaignId: "c-1" },
  runId: "run-1",
  source: "enrich",
};
const treg = (body: unknown, status = 200, costMicro = "1500") =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-treg-cost-micro": costMicro } });

/** The stored waterfall, as the script runs it: through the doors only. */
async function scriptLike(dynasty: string, email: string) {
  const ev = await import("../../src/lib/email-verification.js");
  for (const verifier of ["contactout", "bounceverify", "trykitt", "millionverifier"]) {
    if (verifier === "bounceverify" && !(ev.doorApifyAvailable({ callerRunId: "run-1", email }).body.available as boolean)) continue;
    const out = await ev.doorVerifierCall({ callerRunId: "run-1", scriptRunId: "script-run-1", verifier, email });
    if (out.status !== 200) throw new Error(`script ${dynasty} failed: ${verifier}: ${String(out.body.error)}`);
    if (!out.body.error && out.body.verdict) return out.body;
  }
  throw new Error("every step-1 verifier failed");
}

beforeEach(async () => {
  vi.clearAllMocks();
  inserted.length = 0;
  decisions.length = 0;
  const ev = await import("../../src/lib/email-verification.js");
  ev.resetApifyFallback();
  mockSwitch.mockResolvedValue({ switched: true, dynasty: "dy_verify_waterfall" });
  mockCreateRun.mockImplementation(async (p: { taskName: string }) => ({ id: `run-${p.taskName}` }));
  mockUpdateRun.mockResolvedValue({});
  mockAddCosts.mockImplementation(async (_r: string, items: any[]) => ({ costs: [{ id: items[0].status === "provisioned" ? "hold-1" : "actual-1" }] }));
  mockUpdateCostStatus.mockResolvedValue({});
  mockAuthorizeCredit.mockResolvedValue({ sufficient: true, balance_cents: 100, required_cents: 1 });
  mockDecryptKey.mockResolvedValue({ key: "k", keySource: "platform" });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("the stored waterfall decides through our doors", () => {
  it("each verifier call runs here on the script's run; the bronze row names the caller's run; the decision is recorded", async () => {
    // ContactOut 429 → Apify answered valid.
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("contactout")
        ? new Response("<html>Too Many Requests</html>", { status: 429, headers: { "x-treg-cost-micro": "0" } })
        : new Response(JSON.stringify([{ email: "ada@example.com", status: "valid", is_catch_all: false }]), { status: 200 }),
    );
    mockDecide.mockImplementation(async (input: { dynasty: string; email: string }) => {
      const row = await scriptLike(input.dynasty, input.email);
      return { runId: "script-run-1", scriptSlug: "email_found/dy_verify_waterfall/v1", verificationId: row.verificationId };
    });
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail("Ada@Example.com", CTX);
    expect(r).toMatchObject({ email: "ada@example.com", verdict: "valid", deliverable: true, verifier: "bounceverify", reused: false });
    expect(mockDecide).toHaveBeenCalledWith(expect.objectContaining({ dynasty: "dy_verify_waterfall", orgId: "org-1", userId: "user-1", callerRunId: "run-1", email: "ada@example.com", held: null }));
    // No decision run of ours: the script's run is the decision. Every verifier call's run hangs under it.
    expect(mockCreateRun.mock.calls.map((c) => [c[0].taskName, c[0].parentRunId])).toEqual([
      ["verify-email-contactout", "script-run-1"],
      ["verify-email", "script-run-1"],
    ]);
    expect(inserted.every((row) => row.runId === "run-1")).toBe(true);
    expect(mockRecordOutcome).toHaveBeenCalledTimes(1);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ path: "script", runId: "script-run-1", callerRunId: "run-1", held: null, result: { verifier: "bounceverify", verdict: "valid", deliverable: true }, error: null });
    expect(decisions[0].calls.map((c: any) => [c.name, c.args?.verifier ?? null, c.answer.ok])).toEqual([
      ["apollo.email.verify", "contactout", true],
      ["apollo.apify.available", null, true],
      ["apollo.email.verify", "bounceverify", true],
    ]);
  });

  it("a billing refusal at a door reaches the caller as the SAME error our own code throws", async () => {
    mockAuthorizeCredit.mockResolvedValue({ sufficient: false, balance_cents: 0, required_cents: 1 });
    fetchMock.mockImplementation(async () => new Response("<html>Too Many Requests</html>", { status: 429, headers: { "x-treg-cost-micro": "0" } }));
    mockDecide.mockImplementation(async (input: { dynasty: string; email: string }) => {
      await scriptLike(input.dynasty, input.email);
      throw new Error("unreachable");
    });
    const ev = await import("../../src/lib/email-verification.js");
    const err = await ev.verifyRevealedEmail("ada@example.com", CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ev.EmailVerificationError);
    expect((err as InstanceType<typeof ev.EmailVerificationError>).creditRefusal).toMatchObject({ sufficient: false });
    expect(decisions[0]).toMatchObject({ path: "script", result: null });
  });

  it("a door serves only a verification in flight here", async () => {
    const ev = await import("../../src/lib/email-verification.js");
    expect((await ev.doorVerifierCall({ callerRunId: "run-x", scriptRunId: "s", verifier: "contactout", email: "a@b.co" })).status).toBe(409);
    expect(ev.doorApifyAvailable({ callerRunId: "run-x", email: "a@b.co" }).status).toBe(409);
  });

  it("not switched: our own decision, on its own email-verification run, recorded too", async () => {
    mockSwitch.mockResolvedValue({ switched: false, dynasty: null });
    fetchMock.mockImplementation(async () => treg({ data: { status: "valid" } }, 200, "0"));
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail("ada@example.com", CTX);
    expect(r).toMatchObject({ verdict: "valid", verifier: "contactout" });
    expect(mockDecide).not.toHaveBeenCalled();
    expect(mockCreateRun.mock.calls.map((c) => [c[0].taskName, c[0].parentRunId])).toEqual([
      ["email-verification", "run-1"],
      ["verify-email-contactout", "run-email-verification"],
    ]);
    expect(decisions[0]).toMatchObject({ path: "service", runId: "run-email-verification", result: { verifier: "contactout", verdict: "valid" } });
    expect(decisions[0].calls).toEqual([{ name: "apollo.email.verify", args: { verifier: "contactout", email: "ada@example.com" }, answer: { ok: true, data: { verificationId: "ver-1", verifier: "contactout", verdict: "valid", error: null } } }]);
  });
});

describe("a decision the world left without a verdict (`unmade`)", () => {
  it("every verifier silent: the caller gets our own error, Apify's exhaustion named when Apify is out", async () => {
    const { VerifyScriptError } = await import("../../src/lib/email-verify-script.js");
    mockDecide.mockRejectedValueOnce(new VerifyScriptError("every step-1 verifier failed — contactout: 429; bounceverify: skipped, Apify out of usage", "script-run-1", true));
    const ev = await import("../../src/lib/email-verification.js");
    const err = await ev.verifyRevealedEmail("ada@example.com", CTX).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ev.EmailVerificationError);
    expect((err as Error).message).toBe("email verification failed: every step-1 verifier failed — contactout: 429; bounceverify: skipped, Apify out of usage");
    expect(decisions[0]).toMatchObject({ path: "script", runId: "script-run-1", result: null });
  });
});
