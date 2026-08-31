import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Tests for the stateful Apollo-audience endpoints:
 *   POST /audiences/suggest-from-segment  → refine loop + persist
 *   GET  /audiences/:id                   → fetch persisted
 *   POST /audiences/:id/dry-run           → re-count
 *
 * The agentic refine loop (audience-refine.ts) runs for real; only its leaves
 * are mocked — chat-service (chatComplete) and Apollo (searchPeople). The loop
 * makes TWO kinds of chat calls per real attempt: a PROPOSER turn that emits a
 * filter set and an independent GRADER turn that judges it. The mock routes by
 * system prompt, so a test queues the two sides separately.
 */

// ── Stateful db mock ──
const state: { inserted: any; selectRow: any } = { inserted: null, selectRow: undefined };

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: () => ({
      values: (v: any) => ({
        returning: async () => {
          state.inserted = { id: "aud-1", createdAt: new Date("2026-01-01T00:00:00.000Z"), ...v };
          return [state.inserted];
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            const r = state.selectRow !== undefined ? state.selectRow : state.inserted;
            return r ? [r] : [];
          },
        }),
      }),
    }),
    update: () => ({
      set: (s: any) => ({
        where: async () => {
          if (state.inserted) Object.assign(state.inserted, s);
          return undefined;
        },
      }),
    }),
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  apolloAudiences: { id: { name: "id" }, orgId: { name: "org_id" } },
}));

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, res: any, next: any) => {
    if (!req.headers["x-org-id"]) return res.status(400).json({ type: "validation", error: "x-org-id header required" });
    if (!req.headers["x-user-id"]) return res.status(400).json({ type: "validation", error: "x-user-id header required" });
    req.orgId = req.headers["x-org-id"];
    req.userId = req.headers["x-user-id"];
    next();
  },
  orgAuth: (req: any, res: any, next: any) => {
    if (!req.headers["x-org-id"]) return res.status(400).json({ type: "validation", error: "x-org-id header required" });
    req.orgId = req.headers["x-org-id"];
    next();
  },
}));

const mockDecryptKey = vi.fn();
vi.mock("../../src/lib/keys-client.js", () => ({
  decryptKey: (...a: unknown[]) => mockDecryptKey(...a),
}));

const mockChatComplete = vi.fn();
vi.mock("../../src/lib/chat-client.js", () => ({
  chatComplete: (...a: unknown[]) => mockChatComplete(...a),
}));

const mockSearchPeople = vi.fn();
vi.mock("../../src/lib/apollo-client.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  searchPeople: (...a: unknown[]) => mockSearchPeople(...a),
}));

const HEADERS = { "X-Org-Id": "org-1", "X-User-Id": "user-1", "X-Api-Key": "k" };
const CONFIRMED_FILTERS = { personSeniorities: ["head"], personTitles: ["Head of Growth"] };
const FIRST_ENCODING = { personSeniorities: ["head"], qOrganizationKeywordTags: ["fintech"] };

/** Both target-fit flags false = the set is MECE with the described target. */
const MECE = {
  reachesOffTarget: false,
  offTargetReason: null,
  leavesTargetUnreached: false,
  unreachedReason: null,
};
const offTarget = (why: string) => ({
  reachesOffTarget: true,
  offTargetReason: why,
  leavesTargetUnreached: false,
  unreachedReason: null,
});
const unreached = (why: string) => ({
  reachesOffTarget: false,
  offTargetReason: null,
  leavesTargetUnreached: true,
  unreachedReason: why,
});

const chatRes = (json: unknown) => ({ json, content: "", tokensInput: 1, tokensOutput: 1, model: "m" });
/** A PROPOSER turn: it emits an action + a filter set, and NOTHING else — it no
 * longer grades its own proposal. */
const propose = (action: "test" | "confirm", filters: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  chatRes({ action, filters, reasoning: "r", ...extra });
/** A GRADER turn: the independent verdict on someone else's filter set. */
const verdict = (judgement: Record<string, unknown>) => chatRes(judgement);

const GRADER_MARKER = "You review Apollo People Search filter sets";
const isGraderCall = (opts: any) => String(opts.systemPrompt).includes(GRADER_MARKER);

/** Queues, consumed in order; the last entry repeats once a queue runs dry. */
let proposerQueue: any[] = [];
let graderQueue: any[] = [];

function queueProposer(...responses: any[]) {
  proposerQueue = [...responses];
}
function queueGrader(...responses: any[]) {
  graderQueue = [...responses];
}
const proposerCalls = () => mockChatComplete.mock.calls.filter(([o]: any[]) => !isGraderCall(o));
const graderCalls = () => mockChatComplete.mock.calls.filter(([o]: any[]) => isGraderCall(o));

/** A search result carrying a company sample, so the grader sees real names. */
const searchRes = (total: number, companies: string[] = []) => ({
  total_entries: total,
  people: companies.map((name, i) => ({
    id: `p-${i}`,
    name: `Person ${i}`,
    title: "Buyer",
    organization: { id: `o-${i}`, name, industry: "retail" },
  })),
});

async function createApp() {
  const app = express();
  app.use(express.json());
  const { default: audienceRoutes } = await import("../../src/routes/audiences.js");
  app.use(audienceRoutes);
  return app;
}

describe("Apollo audience endpoints", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    state.inserted = null;
    state.selectRow = undefined;
    mockDecryptKey.mockResolvedValue({ key: "apollo-key", keySource: "platform" });
    // mockReset (not clearAllMocks): leftover `…Once` queues would otherwise
    // leak counts into the next test.
    mockSearchPeople.mockReset();
    mockChatComplete.mockReset();
    mockSearchPeople.mockResolvedValue(searchRes(42000));

    // Default: one exploratory encoding, then a confirm on a second encoding
    // (a confirm before a second encoding exists is premature — see the
    // "must test an alternative encoding" test). Every set grades MECE.
    queueProposer(propose("test", FIRST_ENCODING), propose("confirm", CONFIRMED_FILTERS));
    queueGrader(verdict(MECE));

    mockChatComplete.mockImplementation(async (opts: any) => {
      const queue = isGraderCall(opts) ? graderQueue : proposerQueue;
      if (queue.length === 0) throw new Error("test mock: no queued chat response");
      return queue.length === 1 ? queue[0] : queue.shift();
    });

    app = await createApp();
  });

  it("POST /suggest-from-segment persists and returns {apolloAudienceId, filters, count}", async () => {
    mockSearchPeople
      .mockResolvedValueOnce(searchRes(1000, ["Acme"]))
      .mockResolvedValueOnce(searchRes(42000, ["Globex"]));

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "Heads of growth", description: "Heads of growth at US fintech", brandId: "brand-1" })
      .expect(200);

    expect(res.body.apolloAudienceId).toBe("aud-1");
    expect(res.body.filters).toEqual(CONFIRMED_FILTERS);
    expect(res.body.count).toBe(42000);
    // Two real attempts → two proposer turns and two INDEPENDENT grader turns.
    expect(proposerCalls()).toHaveLength(2);
    expect(graderCalls()).toHaveLength(2);
    // Both sides run on zai/glm-flash with reasoning off.
    for (const [opts] of mockChatComplete.mock.calls) {
      expect(opts.provider).toBe("zai");
      expect(opts.model).toBe("glm-flash");
      expect(opts.disableThinking).toBe(true);
      expect(opts.responseFormat).toBe("json");
    }
    // The grader's fixed verdict shape is enforced server-side; the sparse
    // filter object the proposer emits cannot carry a schema.
    expect(graderCalls()[0][0].responseSchema).toMatchObject({
      required: ["reachesOffTarget", "offTargetReason", "leavesTargetUnreached", "unreachedReason"],
    });
    expect(proposerCalls()[0][0].responseSchema).toBeUndefined();
    // The refine loop dry-runs with a small SAMPLE so the grader sees companies.
    expect(mockSearchPeople).toHaveBeenCalledWith("apollo-key", expect.objectContaining({ per_page: 10 }), expect.anything());
    // Stored row carries the winning filters + count snapshot.
    expect(state.inserted.filters).toEqual(CONFIRMED_FILTERS);
    expect(state.inserted.count).toBe(42000);
    expect(state.inserted.status).toBe("confirmed");
    // The four target-fit fields + the sample land in the bronze refine_trace.
    expect(state.inserted.refineTrace[0]).toMatchObject({
      reachesOffTarget: false,
      offTargetReason: null,
      leavesTargetUnreached: false,
      unreachedReason: null,
      sampleCompanies: [expect.stringContaining("Acme")],
    });
  });

  it("400 when description missing", async () => {
    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "x", brandId: null })
      .expect(400);
  });

  it("GET /:id returns the persisted audience", async () => {
    state.selectRow = {
      id: "aud-1",
      orgId: "org-1",
      filters: CONFIRMED_FILTERS,
      count: 4200,
      status: "confirmed",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const res = await request(app).get("/audiences/aud-1").set({ "X-Org-Id": "org-1", "X-Api-Key": "k" }).expect(200);
    expect(res.body).toEqual({
      apolloAudienceId: "aud-1",
      filters: CONFIRMED_FILTERS,
      count: 4200,
      status: "confirmed",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("GET /:id 404 when not found", async () => {
    state.selectRow = null;
    await request(app).get("/audiences/missing").set({ "X-Org-Id": "org-1" }).expect(404);
  });

  it("GET /:id 400 without x-org-id", async () => {
    await request(app).get("/audiences/aud-1").expect(400);
  });

  it("POST /:id/dry-run re-counts the stored filters and returns {count}", async () => {
    state.selectRow = { id: "aud-1", orgId: "org-1", brandId: "brand-1", filters: CONFIRMED_FILTERS, count: 4200 };
    mockSearchPeople.mockResolvedValueOnce(searchRes(5000));
    const res = await request(app).post("/audiences/aud-1/dry-run").set(HEADERS).expect(200);
    expect(res.body).toEqual({ count: 5000 });
    // The count-only route stays on the cheapest teaser — no sample needed.
    expect(mockSearchPeople).toHaveBeenCalledWith("apollo-key", expect.objectContaining({ per_page: 1 }), expect.anything());
  });

  it("POST /:id/dry-run 404 when not found", async () => {
    state.selectRow = null;
    await request(app).post("/audiences/missing/dry-run").set(HEADERS).expect(404);
  });

  // ────────────────────────────────────────────────────────────────────────
  // The MECE invariant, judged by an independent grader
  // ────────────────────────────────────────────────────────────────────────

  it("prompts the proposer with the MECE invariant + max-volume objective, and none of the removed size/keyword rules", async () => {
    mockSearchPeople.mockResolvedValueOnce(searchRes(1000)).mockResolvedValueOnce(searchRes(42000));

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    const [opts] = proposerCalls()[0];

    // The invariant, verbatim, plus the objective on top of it.
    expect(opts.systemPrompt).toContain("we do not add people who should not be there");
    expect(opts.systemPrompt).toContain("we do not leave out people who should be there");
    expect(opts.systemPrompt).toContain("maximize volume");
    // The exploration mandate — why the loop has rounds at all.
    expect(opts.systemPrompt).toContain('A 0 means "this word does not work"');
    expect(opts.systemPrompt).toContain("Never drop the concept.");
    // The proposer no longer grades anything.
    expect(opts.systemPrompt).toContain("YOU DO NOT GRADE YOUR OWN SETS");
    expect(opts.systemPrompt).not.toContain('"reachesOffTarget": true | false');

    // The four instructions that pushed the model to drop the sector are GONE,
    // with no rule-based replacement. (Asserted on the exact authored strings: the
    // appended Apollo encart legitimately keeps the verified count figures, which
    // are observed Apollo behaviour, not a fidelity rule.)
    expect(opts.systemPrompt).not.toContain('"healthcare" / "medical practice" / "wellness"');
    expect(opts.systemPrompt).not.toContain("REDUNDANT filter");
    expect(opts.systemPrompt).not.toContain("harshest volume killer");
    expect(opts.systemPrompt).not.toContain("Add a keyword ONLY when");
    expect(opts.systemPrompt).not.toContain("that betrays the request");

    // No floor, no ambition, no band, anywhere in any prompt.
    const allPrompts = mockChatComplete.mock.calls
      .map(([o]: any[]) => `${o.systemPrompt}\n${o.message}`)
      .join("\n");
    expect(allPrompts).not.toMatch(/ambition/i);
    expect(allPrompts).not.toMatch(/aim for/i);
    expect(allPrompts).not.toContain("at least ~7,000");
    expect(allPrompts).not.toContain("20,000");
    expect(allPrompts).not.toContain("is a FAILURE");
    expect(allPrompts).not.toContain("NEVER confirm");
  });

  it("restates the MECE invariant in EVERY proposer round, independent of count", async () => {
    queueProposer(
      propose("test", FIRST_ENCODING),
      propose("test", { personTitles: ["CTO"] }),
      propose("confirm", CONFIRMED_FILTERS),
    );
    // A huge count on round 1 must NOT silence the invariant on round 2.
    mockSearchPeople
      .mockResolvedValueOnce(searchRes(900000))
      .mockResolvedValueOnce(searchRes(300))
      .mockResolvedValueOnce(searchRes(42000));

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    expect(proposerCalls()).toHaveLength(3);
    for (const [opts] of proposerCalls()) {
      expect(opts.message).toContain("we do not add people who should not be there");
      expect(opts.message).toContain("we do not leave out people who should be there");
    }
  });

  it("AC1 — the judgement on a trace row comes from a call that did not author that row's filters", async () => {
    // The proposer emits the flags anyway (old shape); they are IGNORED. Only
    // the grader's verdict lands on the row.
    queueProposer(
      propose("test", FIRST_ENCODING, MECE),
      propose("confirm", CONFIRMED_FILTERS, MECE),
    );
    queueGrader(verdict(offTarget("matches employers outside the described target")), verdict(MECE));
    mockSearchPeople.mockResolvedValueOnce(searchRes(82522, ["Rolex"])).mockResolvedValueOnce(searchRes(4100, ["Drogerie Müller"]));

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    // Round 1 self-graded clean and had 20x the volume — the grader excluded it.
    expect(res.body.count).toBe(4100);
    expect(res.body.filters).toEqual(CONFIRMED_FILTERS);
    expect(state.inserted.refineTrace[0]).toMatchObject({
      count: 82522,
      reachesOffTarget: true,
      offTargetReason: expect.stringContaining("outside the described target"),
    });
    // The grader was handed the set it judged, not asked to write one.
    expect(graderCalls()[0][0].message).toContain("fintech");
    expect(graderCalls()[0][0].message).toContain("Filter set under review");
  });

  it("AC2 — the grader's input contains no count", async () => {
    mockSearchPeople
      .mockResolvedValueOnce(searchRes(137, ["Coop City"]))
      .mockResolvedValueOnce(searchRes(19, ["Reformhaus Ruprecht"]));

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "Bio shop buyers in Zurich", brandId: null })
      .expect(200);

    for (const [opts] of graderCalls()) {
      const whole = `${opts.systemPrompt}\n${opts.message}`;
      expect(whole).not.toContain("137");
      expect(whole).not.toContain("19");
      expect(opts.message).not.toMatch(/count/i);
      expect(opts.message).not.toMatch(/matches|volume|how many/i);
    }
    // And the grader is told size is not its business.
    expect(graderCalls()[0][0].systemPrompt).toContain("audience size is NOT your concern");
  });

  it("AC3 — the grader's rejection reason appears in the next round's proposer message", async () => {
    queueProposer(propose("test", FIRST_ENCODING), propose("confirm", CONFIRMED_FILTERS));
    queueGrader(
      verdict(offTarget("matches Honeywell and Rolex, which are not drugstores")),
      verdict(MECE),
    );
    mockSearchPeople
      .mockResolvedValueOnce(searchRes(552, ["Honeywell Technologies", "Rolex"]))
      .mockResolvedValueOnce(searchRes(120, ["Drogerie Bahnhof"]));

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "Drugstore buyers", brandId: null })
      .expect(200);

    const secondTurn = proposerCalls()[1][0].message as string;
    expect(secondTurn).toContain("The reviewer REJECTED your last set");
    expect(secondTurn).toContain("matches Honeywell and Rolex, which are not drugstores");
    expect(secondTurn).toContain("Honeywell Technologies");
    expect(secondTurn).toContain("without dropping any concept the description states");
  });

  it("AC4 — `revisions` is gone: a proposer that sends them cannot re-judge an earlier row", async () => {
    queueProposer(
      propose("test", FIRST_ENCODING),
      propose("confirm", CONFIRMED_FILTERS, {
        revisions: [{ iteration: 1, reachesOffTarget: true, offTargetReason: "nope", leavesTargetUnreached: false, unreachedReason: null }],
      }),
    );
    queueGrader(verdict(MECE));
    mockSearchPeople.mockResolvedValueOnce(searchRes(82522)).mockResolvedValueOnce(searchRes(4100));

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    // Iteration 1 keeps the grader's verdict; the "revision" is inert.
    expect(state.inserted.refineTrace[0].reachesOffTarget).toBe(false);
    expect(state.inserted.refineTrace[0].revisions).toBeUndefined();
    expect(res.body.count).toBe(82522);
    // And the proposer is never invited to revise anything.
    expect(proposerCalls()[0][0].systemPrompt).not.toContain("revisions");
    expect(proposerCalls()[1][0].message).not.toContain("revisions");
  });

  it("AC5 — the Swiss drugstore replay: a Switzerland+retail set that dropped the shop type and region fails loud", async () => {
    const description =
      "Buyers and purchasing managers of psyllium husk products working in independent drogueries and " +
      "health drugstores located across German-speaking Switzerland outside of Zurich, excluding pharmacies.";
    const withKeyword = {
      personTitles: ["Buyer", "Purchasing Manager"],
      personLocations: ["Switzerland"],
      qKeywords: "psyllium OR Flohsamenschalen",
    };
    const dropped = { personTitles: ["Buyer", "Purchasing Manager"], personLocations: ["Switzerland"], qOrganizationKeywordTags: ["retail"] };

    queueProposer(propose("test", withKeyword), propose("confirm", dropped));
    queueGrader(
      verdict(unreached("the psyllium keyword returned nothing, but the shop type is still required")),
      verdict(offTarget("matches Honeywell Technologies, Procter & Gamble and Rolex — not drugstores; the shop type and the German-speaking region were dropped")),
    );
    mockSearchPeople
      .mockResolvedValueOnce(searchRes(0))
      .mockResolvedValue(searchRes(552, ["Honeywell Technologies", "Procter & Gamble", "Rolex"]));

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "Regional Swiss-German Drugstore Buyers", description, brandId: null })
      .expect(500);

    expect(res.body.error).toContain("judged MECE");
    expect(state.inserted).toBeNull();
  });

  it("AC6 — the Zurich bio-shop replay: the 19-count set carrying the sector tags beats the 137-count sector-less one", async () => {
    const description =
      "Buyers and purchasing managers at organic and health-food shops in Zurich, excluding pharmacies.";
    const sectorless = {
      personTitles: ["Buyer", "Purchasing Manager"],
      personLocations: ["Zurich"],
      qOrganizationKeywordTags: ["retail"],
    };
    const withSector = {
      ...sectorless,
      qOrganizationKeywordTags: ["organic", "health food"],
      person_not_titles: ["Pharmacist", "Pharmacy"],
    };

    queueProposer(propose("test", sectorless), propose("confirm", withSector));
    queueGrader(
      verdict(offTarget("no organic/health-food constraint and no pharmacy exclusion — matches Coop City and Migros")),
      verdict(MECE),
    );
    mockSearchPeople
      .mockResolvedValueOnce(searchRes(137, ["Coop City", "Migros"]))
      .mockResolvedValueOnce(searchRes(19, ["Reformhaus Ruprecht", "Bioladen Zürich"]));

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "Zurich Bio Shop Buyers", description, brandId: null })
      .expect(200);

    expect(res.body.filters).toEqual(withSector);
    expect(res.body.count).toBe(19);
  });

  it("a description that states no sector is NOT forced to acquire one", async () => {
    // Guards the opposite regression (#178, 14-67-match audiences): MECE is
    // measured against the DESCRIBED target, so a sector-free description is
    // correctly served by a sector-free filter set — and a set that invented a
    // sector leaves part of the target unreached.
    const sectorFree = { personTitles: ["Founder"], personSeniorities: ["founder"] };
    const inventedSector = { ...sectorFree, qOrganizationKeywordTags: ["software"] };

    queueProposer(propose("test", sectorFree), propose("confirm", inventedSector));
    queueGrader(verdict(MECE), verdict(unreached("adds a software sector the description never stated")));
    mockSearchPeople.mockResolvedValueOnce(searchRes(61000)).mockResolvedValueOnce(searchRes(9000));

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "Solo Founders >$100k Revenue", description: "Solo founders with over $100k in revenue.", brandId: null })
      .expect(200);

    expect(res.body.filters).toEqual(sectorFree);
    expect(res.body.count).toBe(61000);
  });

  it("a count of 0 drives a same-concept retry, never dropping the concept", async () => {
    queueProposer(
      propose("test", { personTitles: ["Chiropractor"], qKeywords: "chiropractie" }),
      propose("confirm", { personTitles: ["Chiropractor"], qOrganizationKeywordTags: ["chiropractic"] }),
    );
    mockSearchPeople.mockResolvedValueOnce(searchRes(0)).mockResolvedValueOnce(searchRes(4100));

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "US Chiropractors", description: "Chiropractors in the US", brandId: null })
      .expect(200);

    const secondTurn = proposerCalls()[1][0].message as string;
    expect(secondTurn).toContain("returned 0 matches");
    expect(secondTurn).toContain("does not work");
    expect(secondTurn).toContain("NOT a signal that the constraint is superfluous");
    expect(secondTurn).toContain("Do not drop the concept");
  });

  it("zero both-flags-false iterations throws (no audience persisted)", async () => {
    queueProposer(propose("confirm", { personTitles: ["Owner"] }));
    queueGrader(verdict(offTarget("no sector constraint")));
    mockSearchPeople.mockResolvedValue(searchRes(82522));

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "chiropractic clinics", brandId: null })
      .expect(500);

    expect(res.body.error).toContain("judged MECE");
    expect(state.inserted).toBeNull();
    // A big count never rescues an off-target set: the budget runs out instead.
    // The grader adds one CALL per attempt, never an extra attempt.
    expect(proposerCalls()).toHaveLength(6);
    expect(graderCalls()).toHaveLength(6);
  });

  it("a confirm is not accepted before a second encoding has been tested", async () => {
    // Same filter set confirmed twice = one encoding: the first confirm is
    // premature and the loop keeps exploring.
    queueProposer(propose("confirm", CONFIRMED_FILTERS));
    mockSearchPeople.mockResolvedValue(searchRes(42000));

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    expect(proposerCalls()).toHaveLength(6);
    expect(res.body.count).toBe(42000);
    // Never got a second encoding to compare → exploration ran out, not a confirm.
    expect(state.inserted.status).toBe("exhausted");
    expect(state.inserted.refineTrace[0].action).toBe("rejected_confirm");
    // And the model was told what was missing.
    expect(proposerCalls()[1][0].message).toContain("ALTERNATIVE");
  });

  it("selection is max count among MECE sets, whichever round produced it", async () => {
    queueProposer(
      propose("test", { personTitles: ["A"] }),
      propose("test", { personTitles: ["B"] }),
      propose("confirm", { personTitles: ["C"] }),
    );
    mockSearchPeople
      .mockResolvedValueOnce(searchRes(5000))
      .mockResolvedValueOnce(searchRes(31000)) // biggest, mid-loop
      .mockResolvedValueOnce(searchRes(9000));

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    expect(res.body.filters).toEqual({ personTitles: ["B"] });
    expect(res.body.count).toBe(31000);
    expect(state.inserted.status).toBe("confirmed");
  });

  it("a zero-match set never wins even when judged MECE", async () => {
    queueProposer(propose("test", { personTitles: ["Nobody"] }), propose("confirm", CONFIRMED_FILTERS));
    mockSearchPeople.mockResolvedValueOnce(searchRes(0)).mockResolvedValueOnce(searchRes(42000));

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    expect(res.body.count).toBe(42000);
    expect(res.body.filters).toEqual(CONFIRMED_FILTERS);
  });

  it("a grader verdict that does not parse fails loud — no default-to-clean", async () => {
    queueProposer(propose("test", FIRST_ENCODING), propose("confirm", CONFIRMED_FILTERS));
    queueGrader(chatRes({ verdict: "looks fine to me" }));
    mockSearchPeople.mockResolvedValue(searchRes(42000));

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(500);

    expect(res.body.error).toContain("unusable verdict");
    expect(state.inserted).toBeNull();
  });

  it("invalid model output does not consume the 6 real-attempt budget", async () => {
    // 2 malformed decisions (no real attempt) then 6 valid off-target confirms (6 real attempts).
    queueProposer(
      chatRes({ garbage: true }),
      chatRes({ still: "wrong" }),
      propose("confirm", { personTitles: ["Founder"] }),
    );
    queueGrader(verdict(offTarget("no sector")));
    mockSearchPeople.mockResolvedValue(searchRes(1000));

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(500); // no MECE-judged set → no audience

    // 2 invalid (retry budget) + 6 valid (real budget) = 8 proposer turns; invalids did not eat the 6.
    expect(proposerCalls()).toHaveLength(8);
    expect(mockSearchPeople).toHaveBeenCalledTimes(6);
    // A malformed proposal is never graded — there is no usable set to judge.
    expect(graderCalls()).toHaveLength(6);
  });

  it("aborts once the invalid-retry budget is exhausted", async () => {
    // 4 consecutive malformed decisions (> MAX_INVALID_RETRIES of 3) → break, nothing to select → 500.
    queueProposer(chatRes({ garbage: true }));

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(500);

    expect(proposerCalls()).toHaveLength(4); // 4th trips invalidRetries > 3 → break
    expect(graderCalls()).toHaveLength(0);
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });
});
