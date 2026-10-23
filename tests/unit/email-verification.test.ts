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

// One entry per SELECT, in order: [held verdict lookup, pending BounceBan lookup, ...].
let selectQueue: any[][] = [];
const inserted: any[] = [];
vi.mock("../../src/db/index.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => selectQueue.shift() ?? [] }) }) }) }),
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
  emailVerifications: { email: "email", verdict: "verdict", verifiedAt: "verified_at", rawResult: "raw_result", verifier: "verifier" },
}));
const mockDomainHasMx = vi.fn();
vi.mock("../../src/lib/mail-domain.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/mail-domain.js")>()),
  domainHasMx: (...a: unknown[]) => mockDomainHasMx(...a),
}));

const mockRecordOutcome = vi.fn();
vi.mock("../../src/lib/outcome-declarations.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/outcome-declarations.js")>()),
  recordOutcomeDetached: (...a: unknown[]) => mockRecordOutcome(...a),
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

/** A treg answer: body verbatim + treg's own charge header. */
function treg(body: unknown, status = 200, costMicro: string | null = "4000") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (costMicro !== null) headers["x-treg-cost-micro"] = costMicro;
  return new Response(JSON.stringify(body), { status, headers });
}

type Vendor = "contactout" | "apify" | "trykitt" | "millionverifier" | "bounceban" | "status";
function vendorOf(url: string): Vendor {
  if (url.includes("api.apify.com")) return "apify";
  if (url.includes("contactout.people.email.verify")) return "contactout";
  if (url.includes("trykitt.people.email.verify")) return "trykitt";
  if (url.includes("millionverifier.people.email.verify")) return "millionverifier";
  if (url.includes("bounceban.people.email.verify.status")) return "status";
  if (url.includes("bounceban.people.email.verify")) return "bounceban";
  throw new Error(`unexpected fetch ${url}`);
}
/** ContactOut (step 1, first) as it answers most of the time live: 429, so BounceVerify answers. */
const contactout429 = () => new Response("<html>Too Many Requests</html>", { status: 429, headers: { "x-treg-cost-micro": "0" } });
/** Answers per vendor, consumed in order; the last one repeats. */
const down = () => new Response("{}", { status: 503, headers: { "x-treg-cost-micro": "0" } });
let answers: Record<Vendor, Array<() => Response>> = { contactout: [contactout429], apify: [], trykitt: [down], millionverifier: [down], bounceban: [], status: [] };
/** Bronze rows minus the failed treg step-1 attempts (ContactOut's 429, TryKitt/MillionVerifier down). */
const rows = () => inserted.filter((r) => !(["contactout", "trykitt", "millionverifier"].includes(r.verifier) && r.verdict === null));
const callsTo = (v: Vendor) => fetchMock.mock.calls.filter(([url]) => vendorOf(String(url)) === v);

const bounceban = (result: string, extra: Record<string, unknown> = {}, costMicro = "4000") =>
  treg({ id: "bb-1", status: "success", email: "ada@example.com", result, score: 90, is_accept_all: false, credits_consumed: 1, ...extra }, 200, costMicro);

beforeEach(async () => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  answers = { contactout: [contactout429], apify: [], trykitt: [down], millionverifier: [down], bounceban: [], status: [] };
  fetchMock.mockImplementation(async (url: string) => {
    const q = answers[vendorOf(String(url))];
    if (q.length === 0) throw new Error(`no answer queued for ${url}`);
    return (q.length > 1 ? q.shift()! : q[0])();
  });
  (await import("../../src/lib/email-verification.js")).resetApifyFallback();
  selectQueue = [];
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

describe("outcome occurrences (COST-ACCOUNTING-1023): the deciding verification produces email_checked", () => {
  it("valid at step 1 → its run produced email_checked and consumed email_found, for the person's email", async () => {
    answers.apify = [() => actor([{ email: "ada@example.com", status: "valid", is_catch_all: false }])];
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    await verifyRevealedEmail("ada@example.com", CTX);
    expect(mockRecordOutcome).toHaveBeenCalledTimes(1);
    expect(mockRecordOutcome).toHaveBeenCalledWith({
      runId: "verify-run-1",
      orgId: "org-1",
      brandIds: ["b-1"],
      campaignId: "c-1",
      produced: ["email_checked"],
      consumed: ["email_found"],
      person: { email: "ada@example.com" },
    });
  });

  it("step-1 catch_all is not final: only BounceBan's run declares", async () => {
    mockCreateRun.mockReset();
    mockCreateRun.mockImplementation(async (p: { taskName: string }) => ({ id: `run-${p.taskName}` }));
    answers.apify = [() => actor([{ email: "ada@example.com", status: "valid", is_catch_all: true }])];
    answers.bounceban = [() => bounceban("risky", { is_accept_all: true })];
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    await verifyRevealedEmail("ada@example.com", CTX);
    expect(mockRecordOutcome.mock.calls.map((c) => c[0].runId)).toEqual(["run-verify-email-bounceban"]);
  });

  it("a caller-named subject (a subscriber, not a lead) is declared as is, with nothing consumed", async () => {
    answers.apify = [() => actor([{ email: "ada@example.com", status: "valid", is_catch_all: false }])];
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const subject = { subjectService: "transactional-email-service", subjectId: "sub-1" };
    await verifyRevealedEmail("Ada@Example.com", { ...CTX, subjects: new Map([["ada@example.com", subject]]) });
    expect(mockRecordOutcome).toHaveBeenCalledWith(expect.objectContaining({ subject, produced: ["email_checked"], consumed: [] }));
  });

  it("an invalid final verdict is a loss: nothing declared", async () => {
    answers.apify = [() => actor([{ email: "ada@example.com", status: "unknown" }])];
    answers.bounceban = [() => bounceban("undeliverable")];
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    await verifyRevealedEmail("ada@example.com", CTX);
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });
});

describe("verifyRevealedEmail", () => {
  it("valid → deliverable, billed exactly 1, hold released, raw row stored", async () => {
    answers.apify = [() => actor([{ email: "Ada@Example.com", status: "valid", is_catch_all: false }])];
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail(" Ada@Example.com ", CTX);

    expect(r).toMatchObject({ email: "ada@example.com", verdict: "valid", deliverable: true, verifier: "bounceverify", reused: false });
    const [url, init] = callsTo("apify")[0];
    expect(url).toContain("bounceverify~bounceverify-email-verifier/run-sync-get-dataset-items");
    expect(init.headers.Authorization).toBe("Bearer apify-token");
    expect(JSON.parse(init.body)).toEqual({ emails: ["ada@example.com"] });

    expect(mockAuthorizeCredit).toHaveBeenCalledWith(expect.objectContaining({ items: [{ costName: "apify-bounceverify-email", quantity: 1 }] }));
    expect(mockAddCosts).toHaveBeenNthCalledWith(1, "verify-run-1", [{ costName: "apify-bounceverify-email", costSource: "platform", quantity: 1, status: "provisioned" }], expect.anything());
    expect(mockAddCosts).toHaveBeenNthCalledWith(2, "verify-run-1", [{ costName: "apify-bounceverify-email", costSource: "platform", quantity: 1, status: "actual" }], expect.anything());
    expect(mockUpdateCostStatus).toHaveBeenCalledWith("verify-run-1", "hold-1", "cancelled", expect.anything());
    expect(mockUpdateRun).toHaveBeenCalledWith("verify-run-1", "completed", expect.anything());
    expect(rows()[0]).toMatchObject({ email: "ada@example.com", verdict: "valid", billed: true, source: "enrich", rawResult: { email: "Ada@Example.com", status: "valid", is_catch_all: false } });
  });

  it("catch_all → BounceBan decides (deliverable → valid), each vendor's spend declared and actualized", async () => {
    answers.apify = [() => actor([{ email: "ada@example.com", status: "valid", is_catch_all: true }])];
    answers.bounceban = [() => bounceban("deliverable", { is_accept_all: true })];
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail("ada@example.com", CTX);

    expect(r).toMatchObject({ verdict: "valid", deliverable: true, verifier: "bounceban", reused: false, verificationId: "ver-3" });
    const [url, init] = callsTo("bounceban")[0];
    expect(url).toBe("https://treg.to/call/bounceban.people.email.verify?email=ada%40example.com&mode=regular");
    expect(init.headers).toMatchObject({ "X-Treg-Token": "apify-token", "X-Treg-Org": "apify-token", "Cache-Control": "no-cache" });
    expect(mockDecryptKey.mock.calls.map((c) => c[2])).toEqual(["treg", "treg-org", "apify", "treg", "treg-org"]);
    // Apify: hold, actual 1. treg: hold 4000 micro, actual = X-Treg-Cost-Micro.
    expect(mockAddCosts.mock.calls.map((c) => c[1][0])).toEqual([
      { costName: "apify-bounceverify-email", costSource: "platform", quantity: 1, status: "provisioned" },
      { costName: "apify-bounceverify-email", costSource: "platform", quantity: 1, status: "actual" },
      { costName: "treg-micro-usd", costSource: "platform", quantity: 4000, status: "provisioned" },
      { costName: "treg-micro-usd", costSource: "platform", quantity: 4000, status: "actual" },
    ]);
    expect(mockAuthorizeCredit).toHaveBeenLastCalledWith(expect.objectContaining({ items: [{ costName: "treg-micro-usd", quantity: 4000 }] }));
    expect(mockUpdateCostStatus).toHaveBeenCalledTimes(2);
    expect(mockCreateRun.mock.calls.map((c) => c[0].taskName)).toEqual(["verify-email-contactout", "verify-email", "verify-email-bounceban"]);
    expect(rows().map((r) => [r.verifier, r.verdict, r.billed, r.costName, r.costQuantity])).toEqual([
      ["bounceverify", "catch_all", true, "apify-bounceverify-email", 1],
      ["bounceban", "valid", true, "treg-micro-usd", 4000],
    ]);
    expect(rows()[1].rawResult).toMatchObject({ result: "deliverable", is_accept_all: true, id: "bb-1" });
  });

  it("unknown → BounceBan decides (undeliverable → invalid); BounceVerify's unknown stays free", async () => {
    answers.apify = [() => actor([{ email: "ada@example.com", status: "unknown" }])];
    answers.bounceban = [() => bounceban("undeliverable")];
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail("ada@example.com", CTX);
    expect(r).toMatchObject({ verdict: "invalid", deliverable: false, verifier: "bounceban" });
    expect(rows()[0]).toMatchObject({ verifier: "bounceverify", verdict: "unknown", billed: false, costQuantity: 0 });
    expect(mockAddCosts.mock.calls.filter((c) => c[1][0].status === "actual").map((c) => c[1][0].costName)).toEqual(["treg-micro-usd"]);
  });

  it("valid / invalid first passes never pay for a second opinion", async () => {
    answers.apify = [() => actor([{ email: "ada@example.com", status: "invalid" }])];
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail("ada@example.com", CTX);
    expect(r).toMatchObject({ verdict: "invalid", verifier: "bounceverify" });
    expect(callsTo("bounceban")).toHaveLength(0);
  });

  it("a BounceBan failure is loud: the first-pass catch_all is NEVER served, its charge still declared", async () => {
    answers.apify = [() => actor([{ email: "ada@example.com", status: "valid", is_catch_all: true }])];
    answers.bounceban = [() => treg({ detail: "provider_capacity_unavailable" }, 503, null)];
    const { verifyRevealedEmail, EmailVerificationError } = await import("../../src/lib/email-verification.js");
    const err = await verifyRevealedEmail("ada@example.com", CTX).catch((e) => e);
    expect(err).toBeInstanceOf(EmailVerificationError);
    expect(err.message).toMatch(/bounceban.*503/);
    expect(rows()[1]).toMatchObject({ verifier: "bounceban", verdict: null, httpStatus: 503, billed: false });
    expect(mockAddCosts.mock.calls.filter((c) => c[1][0].status === "actual").map((c) => c[1][0].costName)).toEqual(["apify-bounceverify-email"]);
    expect(mockUpdateRun).toHaveBeenLastCalledWith("verify-run-1", "failed", expect.anything());
  });

  it("BounceBan answering `verifying` is polled by its task id (free) until it decides", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      answers.apify = [() => actor([{ email: "ada@example.com", status: "unknown" }])];
      answers.bounceban = [() => treg({ id: "bb-7", status: "verifying", email: "ada@example.com", credits_consumed: 1 })];
      answers.status = [() => treg({ id: "bb-7", status: "verifying" }, 200, "0"), () => bounceban("deliverable", { id: "bb-7" }, "0")];
      const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
      const p = verifyRevealedEmail("ada@example.com", CTX);
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(10_000);
      const r = await p;
      expect(r).toMatchObject({ verdict: "valid", verifier: "bounceban" });
      expect(callsTo("status").map(([u]) => u)).toEqual([
        "https://treg.to/call/bounceban.people.email.verify.status?id=bb-7",
        "https://treg.to/call/bounceban.people.email.verify.status?id=bb-7",
      ]);
      expect(rows()[1]).toMatchObject({ verdict: "valid", costQuantity: 4000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("BounceBan still verifying past the budget: loud, paid once, and the next ask RESUMES the task instead of paying again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      answers.apify = [() => actor([{ email: "ada@example.com", status: "unknown" }])];
      answers.bounceban = [() => treg({ id: "bb-9", status: "verifying", email: "ada@example.com" })];
      answers.status = [() => treg({ id: "bb-9", status: "verifying" }, 200, "0")];
      const { verifyRevealedEmail, EmailVerificationError, SecondOpinionPendingError, BOUNCEBAN_POLL_BUDGET_MS } = await import("../../src/lib/email-verification.js");
      const p = verifyRevealedEmail("ada@example.com", CTX).catch((e) => e);
      for (let i = 0; i < BOUNCEBAN_POLL_BUDGET_MS / 10_000 + 2; i++) await vi.advanceTimersByTimeAsync(10_000);
      const err = await p;
      expect(err).toBeInstanceOf(EmailVerificationError);
      // The pending subclass: still loud for a person's address, readable as "no evidence" by the domain gate's probe.
      expect(err).toBeInstanceOf(SecondOpinionPendingError);
      expect(err.taskId).toBe("bb-9");
      expect(err.message).toMatch(/still verifying/);
      const pendingRow = rows()[1];
      expect(pendingRow).toMatchObject({ verifier: "bounceban", verdict: null, billed: true, costQuantity: 4000, rawResult: { id: "bb-9", status: "verifying" } });

      // Next ask: the first pass is held (unknown), the BounceBan task is pending → poll only.
      mockAuthorizeCredit.mockClear();
      mockAddCosts.mockClear();
      const submissions = callsTo("bounceban").length;
      answers.status = [() => bounceban("undeliverable", { id: "bb-9" }, "0")];
      selectQueue = [[rows()[0]], [pendingRow]];
      const r = await verifyRevealedEmail("ada@example.com", CTX);
      expect(r).toMatchObject({ verdict: "invalid", verifier: "bounceban" });
      expect(callsTo("bounceban")).toHaveLength(submissions);
      expect(callsTo("status").at(-1)![0]).toBe("https://treg.to/call/bounceban.people.email.verify.status?id=bb-9");
      expect(mockAuthorizeCredit).not.toHaveBeenCalled();
      expect(mockAddCosts.mock.calls.filter((c) => c[1][0].status === "provisioned")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a HELD first-pass catch_all goes straight to BounceBan: BounceVerify is not asked again", async () => {
    selectQueue = [[{ id: "ver-old", email: "ada@example.com", verifier: "bounceverify", verdict: "catch_all", verifiedAt: new Date("2026-10-10T00:00:00Z") }]];
    answers.bounceban = [() => bounceban("deliverable")];
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail("ada@example.com", CTX);
    expect(r).toMatchObject({ verdict: "valid", verifier: "bounceban", reused: false });
    expect(callsTo("apify")).toHaveLength(0);
  });

  it("a HELD BounceBan verdict is final, whatever it says (reused, nothing called)", async () => {
    selectQueue = [[{ id: "ver-bb", email: "ada@example.com", verifier: "bounceban", verdict: "unknown", verifiedAt: new Date("2026-10-10T00:00:00Z") }]];
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail("ada@example.com", CTX);
    expect(r).toMatchObject({ verdict: "unknown", verifier: "bounceban", reused: true, verificationId: "ver-bb" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reuses a held decisive verdict: no key, no authorize, no call, no cost", async () => {
    selectQueue = [[{ id: "ver-old", email: "ada@example.com", verifier: "bounceverify", verdict: "invalid", verifiedAt: new Date("2026-09-20T00:00:00Z") }]];
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail("ada@example.com", CTX);
    expect(r).toMatchObject({ verdict: "invalid", deliverable: false, reused: true, verificationId: "ver-old" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockDecryptKey).not.toHaveBeenCalled();
    expect(mockAddCosts).not.toHaveBeenCalled();
  });

  it("an actor failure throws, releases the hold, fails the run, and stores the error", async () => {
    answers.apify = [() => actor({ error: "boom" }, 500)];
    const { verifyRevealedEmail, EmailVerificationError } = await import("../../src/lib/email-verification.js");
    await expect(verifyRevealedEmail("ada@example.com", CTX)).rejects.toBeInstanceOf(EmailVerificationError);
    expect(mockUpdateCostStatus).toHaveBeenCalledWith("verify-run-1", "hold-1", "cancelled", expect.anything());
    expect(mockUpdateRun).toHaveBeenCalledWith("verify-run-1", "failed", expect.anything());
    expect(rows()[0]).toMatchObject({ verdict: null, httpStatus: 500 });
    expect(rows()[0].error).toContain("500");
  });

  describe("a TIMED-OUT actor run gets one longer second chance (VERIFY-TIMEOUT-1014)", () => {
    const timedOut = () =>
      actor({ error: { type: "run-failed", message: "Actor run did not succeed (run ID: XdYBX0KRc2FI3cqrP, status: TIMED-OUT)." } }, 400);

    it("times out once, then answers: the verdict comes back in the SAME call, billed once, one bronze row", async () => {
      answers.apify = [timedOut, () => actor([{ email: "tz-ny-1014@distribute.you", status: "valid", is_catch_all: false }])];
      const { verifyRevealedEmail, ACTOR_RETRY_TIMEOUT_S } = await import("../../src/lib/email-verification.js");
      const r = await verifyRevealedEmail("tz-ny-1014@distribute.you", CTX);

      expect(r).toMatchObject({ verdict: "valid", deliverable: true, reused: false });
      expect(callsTo("apify")).toHaveLength(2);
      expect(callsTo("apify")[0][0]).toContain("timeout=60");
      expect(callsTo("apify")[1][0]).toContain(`timeout=${ACTOR_RETRY_TIMEOUT_S}`);
      expect(ACTOR_RETRY_TIMEOUT_S).toBeGreaterThan(60);
      expect(mockAddCosts).toHaveBeenCalledTimes(2);
      expect(mockAddCosts).toHaveBeenNthCalledWith(2, "verify-run-1", [expect.objectContaining({ status: "actual", quantity: 1 })], expect.anything());
      expect(mockUpdateRun).toHaveBeenCalledWith("verify-run-1", "completed", expect.anything());
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({ verdict: "valid", httpStatus: 200, error: null, billed: true });
    });

    it("keeps timing out: still NO verdict, fails loud with the reason, bills nothing, hold cancelled, no third call", async () => {
      answers.apify = [timedOut];
      answers.contactout = [contactout429];
      const { verifyRevealedEmail, EmailVerificationError } = await import("../../src/lib/email-verification.js");
      const err = await verifyRevealedEmail("gate-nobody-1014@distribute.you", CTX).catch((e) => e);

      expect(err).toBeInstanceOf(EmailVerificationError);
      expect(err.message).toMatch(/TIMED-OUT/);
      expect(callsTo("apify")).toHaveLength(2);
      // BounceVerify: the hold only, never an actual.
      expect(mockAddCosts.mock.calls.filter((c) => c[1][0].costName === "apify-bounceverify-email").map((c) => c[1][0].status)).toEqual(["provisioned"]);
      expect(mockUpdateCostStatus).toHaveBeenCalledWith("verify-run-1", "hold-1", "cancelled", expect.anything());
      expect(mockUpdateRun).toHaveBeenCalledWith("verify-run-1", "failed", expect.anything());
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({ verdict: null, httpStatus: 400, billed: false });
      expect(rows()[0].error).toContain("TIMED-OUT");
    });

    it("a run-failed that is NOT a timeout is not retried", async () => {
      answers.apify = [() => actor({ error: { type: "run-failed", message: "Actor run did not succeed (run ID: x, status: FAILED)." } }, 400)];
      const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
      await expect(verifyRevealedEmail("ada@example.com", CTX)).rejects.toThrow(/FAILED/);
      expect(callsTo("apify")).toHaveLength(1);
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

  it("insufficient balance throws before any paid call or hold (only the free ContactOut was asked)", async () => {
    mockAuthorizeCredit.mockResolvedValue({ sufficient: false, balance_cents: 0, required_cents: 1 });
    const { verifyRevealedEmail, EmailVerificationError } = await import("../../src/lib/email-verification.js");
    await expect(verifyRevealedEmail("ada@example.com", CTX)).rejects.toBeInstanceOf(EmailVerificationError);
    expect(callsTo("apify")).toHaveLength(0);
    expect(callsTo("trykitt")).toHaveLength(0);
    expect(mockAddCosts).not.toHaveBeenCalled();
  });

  it("a sales funnel max budget refusal answers 402 naming the cap, never a retryable 502", async () => {
    const cap = { salesFunnelId: "sf-1", salesFunnelCampaignId: null, amountCents: "500", period: "total", consumedCents: "500", reservedCents: "0" };
    mockAuthorizeCredit.mockResolvedValue({ sufficient: false, balance_cents: 900, required_cents: 3, reason: "sales_funnel_max_budget_reached", sales_funnel_cap: cap });
    const { verifyRevealedEmail, EmailVerificationError } = await import("../../src/lib/email-verification.js");
    const { emailVerificationErrorResponse } = await import("../../src/lib/email-verification-response.js");
    const err = await verifyRevealedEmail("ada@example.com", CTX).catch((e) => e);
    expect(err).toBeInstanceOf(EmailVerificationError);
    expect(emailVerificationErrorResponse(err)).toEqual({
      status: 402,
      body: { type: "credit_insufficient", source: "email-verification", error: "Sales funnel max budget reached", reason: "sales_funnel_max_budget_reached", sales_funnel_cap: cap, balance_cents: 900, required_cents: 3 },
    });
    expect(callsTo("apify")).toHaveLength(0);
  });

  it("a balance refusal keeps its 502 email_verification answer", async () => {
    mockAuthorizeCredit.mockResolvedValue({ sufficient: false, balance_cents: 0, required_cents: 1 });
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const { emailVerificationErrorResponse } = await import("../../src/lib/email-verification-response.js");
    const err = await verifyRevealedEmail("ada@example.com", CTX).catch((e) => e);
    const answer = emailVerificationErrorResponse(err);
    expect(answer.status).toBe(502);
    expect(answer.body.type).toBe("email_verification");
  });

  it("a missing apify key throws a legible error", async () => {
    mockDecryptKey.mockImplementation(async (_o: string, _u: string, provider: string) => {
      if (provider === "apify") throw new Error("apify key not configured for this organization");
      return { key: `${provider}-key`, keySource: "platform" };
    });
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

  it("domain HAS MX → first pass unknown (billed as the vendor charged), then BounceBan decides", async () => {
    answers.apify = [() => actor([dneRow("team@definitejobsgroup.co.uk")])];
    answers.bounceban = [() => bounceban("deliverable", { email: "team@definitejobsgroup.co.uk" })];
    mockDomainHasMx.mockResolvedValue(true);
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail("team@definitejobsgroup.co.uk", CTX);

    expect(mockDomainHasMx).toHaveBeenCalledWith("definitejobsgroup.co.uk");
    expect(r).toMatchObject({ verdict: "valid", deliverable: true, verifier: "bounceban", reused: false });
    expect(rows()[0]).toMatchObject({ verdict: "unknown", billed: true, rawResult: expect.objectContaining({ status: "invalid", reason: "Domain does not exist" }) });
    expect(mockAddCosts).toHaveBeenNthCalledWith(2, "verify-run-1", [expect.objectContaining({ status: "actual" })], expect.anything());
  });

  it("domain truly has NO MX → still invalid", async () => {
    answers.apify = [() => actor([dneRow("ada@gmail.con")])];
    mockDomainHasMx.mockResolvedValue(false);
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail("ada@gmail.con", CTX);
    expect(r).toMatchObject({ verdict: "invalid", deliverable: false });
    expect(rows()[0]).toMatchObject({ verdict: "invalid", billed: true });
  });

  it("a mailbox-level invalid (the domain's server refused it) is NOT re-checked", async () => {
    answers.apify = [() => actor([{ email: "ada@example.com", status: "invalid", domain_exists: true, mx_found: true, reason: "Mailbox does not exist" }])];
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail("ada@example.com", CTX);
    expect(r.verdict).toBe("invalid");
    expect(mockDomainHasMx).not.toHaveBeenCalled();
  });

  it("our DNS cannot answer → no verdict (loud), the vendor's charge still declared", async () => {
    answers.apify = [() => actor([dneRow("team@definitejobsgroup.co.uk")])];
    const { MailDomainLookupError } = await import("../../src/lib/mail-domain.js");
    mockDomainHasMx.mockRejectedValue(new MailDomainLookupError("definitejobsgroup.co.uk", new Error("queryMx ETIMEOUT")));
    const { verifyRevealedEmail, EmailVerificationError } = await import("../../src/lib/email-verification.js");
    await expect(verifyRevealedEmail("team@definitejobsgroup.co.uk", CTX)).rejects.toBeInstanceOf(EmailVerificationError);
    expect(rows()[0]).toMatchObject({ verdict: null, billed: true });
    expect(rows()[0].error).toContain("ETIMEOUT");
    expect(mockAddCosts).toHaveBeenNthCalledWith(2, "verify-run-1", [expect.objectContaining({ status: "actual" })], expect.anything());
    expect(mockUpdateRun).toHaveBeenCalledWith("verify-run-1", "failed", expect.anything());
  });

  it("a HELD 'Domain does not exist' invalid on a domain with MX is not reused as invalid: a free unknown row replaces it, BounceBan decides", async () => {
    selectQueue = [[{ id: "ver-old", email: "team@definitejobsgroup.co.uk", verifier: "bounceverify", verdict: "invalid", httpStatus: 201, rawResult: dneRow("team@definitejobsgroup.co.uk"), verifiedAt: new Date("2026-10-15T12:10:22Z") }]];
    mockDomainHasMx.mockResolvedValue(true);
    answers.bounceban = [() => bounceban("undeliverable", { email: "team@definitejobsgroup.co.uk" })];
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail("team@definitejobsgroup.co.uk", CTX);

    expect(r).toMatchObject({ verdict: "invalid", verifier: "bounceban", reused: false });
    expect(rows()[0]).toMatchObject({ verdict: "unknown", billed: false, verifyRunId: null, rawResult: expect.objectContaining({ reason: "Domain does not exist" }) });
    expect(callsTo("apify")).toHaveLength(0);
    expect(mockDecryptKey.mock.calls.map((c) => c[2])).toEqual(["treg", "treg-org"]);
  });

  it("a HELD 'Domain does not exist' invalid on a domain with NO MX is reused as invalid", async () => {
    selectQueue = [[{ id: "ver-old", email: "ada@gmail.con", verifier: "bounceverify", verdict: "invalid", rawResult: dneRow("ada@gmail.con"), verifiedAt: new Date("2026-10-15T00:00:00Z") }]];
    mockDomainHasMx.mockResolvedValue(false);
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    const r = await verifyRevealedEmail("ada@gmail.con", CTX);
    expect(r).toMatchObject({ verdict: "invalid", reused: true, verificationId: "ver-old" });
    expect(rows()).toHaveLength(0);
  });

  it("a held unknown WE decided (vendor row says invalid) is not re-asked of BounceVerify: BounceBan decides it", async () => {
    selectQueue = [[{ id: "ver-fixed", email: "team@definitejobsgroup.co.uk", verifier: "bounceverify", verdict: "unknown", rawResult: dneRow("team@definitejobsgroup.co.uk"), verifiedAt: new Date("2026-10-15T00:00:00Z") }]];
    const { verifyRevealedEmail } = await import("../../src/lib/email-verification.js");
    answers.bounceban = [() => bounceban("deliverable", { email: "team@definitejobsgroup.co.uk" })];
    const r = await verifyRevealedEmail("team@definitejobsgroup.co.uk", CTX);
    expect(r).toMatchObject({ verdict: "valid", verifier: "bounceban", reused: false });
    expect(callsTo("apify")).toHaveLength(0);
    expect(mockDomainHasMx).not.toHaveBeenCalled();
  });
});
