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
 * are mocked — chat-service (chatComplete) and Apollo (searchPeople).
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
const decide = (
  action: "test" | "confirm",
  filters: Record<string, unknown>,
  judgement: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => chatRes({ action, filters, reasoning: "r", ...judgement, ...extra });

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
    mockSearchPeople.mockResolvedValue({ total_entries: 42000, people: [] });
    // Default: one exploratory encoding, then a confirm on a second encoding
    // (a confirm before a second encoding exists is premature — see the
    // "must test an alternative encoding" test).
    mockChatComplete
      .mockResolvedValueOnce(decide("test", FIRST_ENCODING, MECE))
      .mockResolvedValue(decide("confirm", CONFIRMED_FILTERS, MECE));
    app = await createApp();
  });

  it("POST /suggest-from-segment persists and returns {apolloAudienceId, filters, count}", async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ total_entries: 1000, people: [] })
      .mockResolvedValueOnce({ total_entries: 42000, people: [] });

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "Heads of growth", description: "Heads of growth at US fintech", brandId: "brand-1" })
      .expect(200);

    expect(res.body.apolloAudienceId).toBe("aud-1");
    expect(res.body.filters).toEqual(CONFIRMED_FILTERS);
    expect(res.body.count).toBe(42000);
    expect(mockChatComplete).toHaveBeenCalledTimes(2);
    // Refine LLM goes through DeepSeek JSON mode, NOT Anthropic: chat-service
    // requires a strict responseSchema for Anthropic JSON, incompatible with the
    // sparse Apollo filter object. DeepSeek serves schemaless `json_object`.
    expect(mockChatComplete).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "deepseek", responseFormat: "json" }),
      expect.anything(),
    );
    // The refine loop dry-ran each candidate via Apollo per_page=1.
    expect(mockSearchPeople).toHaveBeenCalledWith("apollo-key", expect.objectContaining({ per_page: 1 }), expect.anything());
    // Stored row carries the winning filters + count snapshot.
    expect(state.inserted.filters).toEqual(CONFIRMED_FILTERS);
    expect(state.inserted.count).toBe(42000);
    expect(state.inserted.status).toBe("confirmed");
    // The four target-fit fields land in the bronze refine_trace.
    expect(state.inserted.refineTrace[0]).toMatchObject({
      reachesOffTarget: false,
      offTargetReason: null,
      leavesTargetUnreached: false,
      unreachedReason: null,
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
    mockSearchPeople.mockResolvedValueOnce({ total_entries: 5000, people: [] });
    const res = await request(app).post("/audiences/aud-1/dry-run").set(HEADERS).expect(200);
    expect(res.body).toEqual({ count: 5000 });
    expect(mockSearchPeople).toHaveBeenCalledWith("apollo-key", expect.objectContaining({ per_page: 1 }), expect.anything());
  });

  it("POST /:id/dry-run 404 when not found", async () => {
    state.selectRow = null;
    await request(app).post("/audiences/missing/dry-run").set(HEADERS).expect(404);
  });

  // ────────────────────────────────────────────────────────────────────────
  // The MECE invariant + max-volume-among-MECE objective
  // ────────────────────────────────────────────────────────────────────────

  it("prompts with the MECE invariant + max-volume objective, and none of the removed size/keyword rules", async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ total_entries: 1000, people: [] })
      .mockResolvedValueOnce({ total_entries: 42000, people: [] });

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    const [[opts]] = mockChatComplete.mock.calls;
    // Refine loop runs on deepseek-pro with thinking ON — judgement quality is
    // the whole point of the loop.
    expect(opts.provider).toBe("deepseek");
    expect(opts.model).toBe("deepseek-pro");
    expect(opts.disableThinking).toBeUndefined();

    // The invariant, verbatim, plus the objective on top of it.
    expect(opts.systemPrompt).toContain("we do not add people who should not be there");
    expect(opts.systemPrompt).toContain("we do not leave out people who should be there");
    expect(opts.systemPrompt).toContain("maximize volume");
    // The exploration mandate — why the loop has rounds at all.
    expect(opts.systemPrompt).toContain('A 0 means "this word does not work"');
    expect(opts.systemPrompt).toContain("Never drop the concept.");

    // AC1 — the four instructions that pushed the model to drop the sector are GONE,
    // with no rule-based replacement. (Asserted on the exact authored strings: the
    // appended Apollo encart legitimately keeps the verified count figures, which
    // are observed Apollo behaviour, not a fidelity rule.)
    expect(opts.systemPrompt).not.toContain('"healthcare" / "medical practice" / "wellness"');
    expect(opts.systemPrompt).not.toContain("REDUNDANT filter");
    expect(opts.systemPrompt).not.toContain("harshest volume killer");
    expect(opts.systemPrompt).not.toContain("Add a keyword ONLY when");
    // (`wellness` still occurs in the schema-generated industry catalog — that is a
    // legal Apollo VALUE, not the banned-keyword rule that was removed.)
    expect(opts.systemPrompt).not.toContain("that betrays the request");

    // AC3 — no floor, no ambition, no band, anywhere in either prompt.
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

  it("AC2 — restates the MECE invariant in EVERY round's user message, independent of count", async () => {
    mockChatComplete
      .mockReset()
      .mockResolvedValueOnce(decide("test", FIRST_ENCODING, MECE))
      .mockResolvedValueOnce(decide("test", { personTitles: ["CTO"] }, MECE))
      .mockResolvedValue(decide("confirm", CONFIRMED_FILTERS, MECE));
    // A huge count on round 1 must NOT silence the invariant on round 2.
    mockSearchPeople
      .mockResolvedValueOnce({ total_entries: 900000, people: [] })
      .mockResolvedValueOnce({ total_entries: 300, people: [] })
      .mockResolvedValueOnce({ total_entries: 42000, people: [] });

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    expect(mockChatComplete).toHaveBeenCalledTimes(3);
    for (const [opts] of mockChatComplete.mock.calls) {
      expect(opts.message).toContain("we do not add people who should not be there");
      expect(opts.message).toContain("we do not leave out people who should be there");
    }
  });

  it("the 82,522 regression: a sector-less set flagged off-target never wins, even at 20x the count", async () => {
    // The exact prod row that motivated this change (apollo_audiences
    // aa95612d-…): "Owner" + include_similar_titles + US + 11-50 employees and
    // NO sector constraint matched every US small-business owner — 82,522 —
    // while the description states chiropractic/wellness clinics.
    const description =
      "Lead chiropractors, clinic directors, and owners managing multi-practitioner chiropractic " +
      "and wellness clinics with 11-50 employees located across the United States.";
    const sectorless = {
      personTitles: ["Chiropractor", "Clinic Director", "Owner"],
      personLocations: ["United States"],
      includeSimilarTitles: true,
      organizationNumEmployeesRanges: ["11,50"],
    };
    const withSector = { ...sectorless, qOrganizationKeywordTags: ["chiropractic", "wellness"] };

    mockChatComplete
      .mockReset()
      .mockResolvedValueOnce(
        decide("test", sectorless, offTarget("no sector constraint — matches US small-business owners in any industry")),
      )
      .mockResolvedValue(decide("confirm", withSector, MECE));
    mockSearchPeople
      .mockResolvedValueOnce({ total_entries: 82522, people: [] })
      .mockResolvedValueOnce({ total_entries: 4100, people: [] });

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "Multi-Practitioner Clinic Directors US", description, brandId: null })
      .expect(200);

    // Max-count-among-MECE, not max-count: 82,522 is excluded by its flag.
    expect(res.body.filters).toEqual(withSector);
    expect(res.body.count).toBe(4100);
    expect(state.inserted.count).toBe(4100);
    // The rejected set is still traced, flag + reason intact (bronze).
    expect(state.inserted.refineTrace[0]).toMatchObject({
      count: 82522,
      reachesOffTarget: true,
      offTargetReason: expect.stringContaining("no sector"),
    });
  });

  it("AC8 — a description that states no sector is NOT forced to acquire one", async () => {
    // Guards the opposite regression (#178, 14-67-match audiences): MECE is
    // measured against the DESCRIBED target, so a sector-free description is
    // correctly served by a sector-free filter set — and a set that invented a
    // sector leaves part of the target unreached.
    const sectorFree = { personTitles: ["Founder"], personSeniorities: ["founder"] };
    const inventedSector = { ...sectorFree, qOrganizationKeywordTags: ["software"] };

    mockChatComplete
      .mockReset()
      .mockResolvedValueOnce(decide("test", sectorFree, MECE))
      .mockResolvedValue(
        decide("confirm", inventedSector, unreached("adds a software sector the description never stated")),
      );
    mockSearchPeople
      .mockResolvedValueOnce({ total_entries: 61000, people: [] })
      .mockResolvedValueOnce({ total_entries: 9000, people: [] });

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "Solo Founders >$100k Revenue", description: "Solo founders with over $100k in revenue.", brandId: null })
      .expect(200);

    expect(res.body.filters).toEqual(sectorFree);
    expect(res.body.count).toBe(61000);
  });

  it("AC7 — a count of 0 drives a same-concept retry, never dropping the concept", async () => {
    mockChatComplete
      .mockReset()
      .mockResolvedValueOnce(decide("test", { personTitles: ["Chiropractor"], qKeywords: "chiropractie" }, MECE))
      .mockResolvedValue(decide("confirm", { personTitles: ["Chiropractor"], qOrganizationKeywordTags: ["chiropractic"] }, MECE));
    mockSearchPeople
      .mockResolvedValueOnce({ total_entries: 0, people: [] })
      .mockResolvedValueOnce({ total_entries: 4100, people: [] });

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "US Chiropractors", description: "Chiropractors in the US", brandId: null })
      .expect(200);

    const secondTurn = mockChatComplete.mock.calls[1][0].message as string;
    expect(secondTurn).toContain("returned 0 matches");
    expect(secondTurn).toContain("does not work");
    expect(secondTurn).toContain("NOT a signal that the constraint is superfluous");
    expect(secondTurn).toContain("Do not drop the concept");
  });

  it("AC6 — zero both-flags-false iterations degrades to the best attempt, flagged + logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockChatComplete
      .mockReset()
      .mockResolvedValue(decide("confirm", { personTitles: ["Owner"] }, offTarget("no sector constraint")));
    mockSearchPeople.mockResolvedValue({ total_entries: 82522, people: [] });

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "chiropractic clinics", brandId: null })
      .expect(200);

    // An audience the customer can look at and reject beats an empty screen —
    // but it is marked, never passed off as a blessed set.
    expect(res.body.degraded).toBe(true);
    expect(res.body.filters).toEqual({ personTitles: ["Owner"] });
    expect(res.body.count).toBe(82522);
    expect(state.inserted).not.toBeNull();
    // The loop still spends its whole exploration budget looking for a clean set.
    expect(mockChatComplete).toHaveBeenCalledTimes(6);

    // AC4 — the full trace is logged, with per-iteration verdicts and reasons.
    const line = warn.mock.calls.map((c) => c.join(" ")).find((l) => l.includes("no MECE-judged filter set"));
    expect(line).toBeDefined();
    expect(line).toContain('"outcome":"degraded"');
    expect(line).toContain('"reachesOffTarget":true');
    expect(line).toContain("no sector constraint");
    expect(line).toContain('"count":82522');
    warn.mockRestore();
  });

  it("the normal path is NOT flagged degraded and logs no trace", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    expect(res.body.degraded).toBe(false);
    expect(warn.mock.calls.map((c) => c.join(" ")).some((l) => l.includes("no MECE-judged filter set"))).toBe(false);
    warn.mockRestore();
  });

  it("a set matching NOBODY is not an audience — still throws, nothing persisted", async () => {
    // Fail loud survives for real errors: every candidate validated but matched
    // zero people, so there is nothing to degrade to.
    mockChatComplete
      .mockReset()
      .mockResolvedValue(decide("confirm", { personTitles: ["Nobody"] }, offTarget("no sector")));
    mockSearchPeople.mockResolvedValue({ total_entries: 0, people: [] });

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(500);

    expect(res.body.error).toContain("matched at least one person");
    expect(state.inserted).toBeNull();
  });

  it("AC5 — a later round revises a prior iteration's flags, changing who wins", async () => {
    const big = { personTitles: ["Owner"], personLocations: ["United States"] };
    const scoped = { ...big, qOrganizationKeywordTags: ["chiropractic"] };

    mockChatComplete
      .mockReset()
      // Round 1 grades its own proposal clean — the proposer bias this channel exists to correct.
      .mockResolvedValueOnce(decide("test", big, MECE))
      // Round 2 sees the count next to an alternative encoding and re-grades round 1.
      .mockResolvedValue(
        decide("confirm", scoped, MECE, {
          revisions: [
            {
              iteration: 1,
              reachesOffTarget: true,
              offTargetReason: "matches owners in every industry, not just chiropractic clinics",
              leavesTargetUnreached: false,
              unreachedReason: null,
            },
          ],
        }),
      );
    mockSearchPeople
      .mockResolvedValueOnce({ total_entries: 82522, people: [] })
      .mockResolvedValueOnce({ total_entries: 4100, people: [] });

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "Owners of US chiropractic clinics", brandId: null })
      .expect(200);

    // Without the revision, 82,522 would have won on count.
    expect(res.body.filters).toEqual(scoped);
    expect(res.body.count).toBe(4100);
    // Revision is persisted on the revised iteration, original + new both visible.
    const revised = state.inserted.refineTrace[0];
    expect(revised.reachesOffTarget).toBe(true);
    expect(revised.revisions).toEqual([
      expect.objectContaining({ atIteration: 2, reachesOffTarget: true }),
    ]);
  });

  it("a confirm is not accepted before a second encoding has been tested", async () => {
    // Same filter set confirmed twice = one encoding: the first confirm is
    // premature and the loop keeps exploring.
    mockChatComplete.mockReset().mockResolvedValue(decide("confirm", CONFIRMED_FILTERS, MECE));
    mockSearchPeople.mockResolvedValue({ total_entries: 42000, people: [] });

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    expect(mockChatComplete).toHaveBeenCalledTimes(6);
    expect(res.body.count).toBe(42000);
    // Never got a second encoding to compare → exploration ran out, not a confirm.
    expect(state.inserted.status).toBe("exhausted");
    expect(state.inserted.refineTrace[0].action).toBe("rejected_confirm");
    // And the model was told what was missing.
    expect(mockChatComplete.mock.calls[1][0].message).toContain("ALTERNATIVE");
  });

  it("selection is max count among MECE sets, whichever round produced it", async () => {
    mockChatComplete
      .mockReset()
      .mockResolvedValueOnce(decide("test", { personTitles: ["A"] }, MECE))
      .mockResolvedValueOnce(decide("test", { personTitles: ["B"] }, MECE))
      .mockResolvedValue(decide("confirm", { personTitles: ["C"] }, MECE));
    mockSearchPeople
      .mockResolvedValueOnce({ total_entries: 5000, people: [] })
      .mockResolvedValueOnce({ total_entries: 31000, people: [] }) // biggest, mid-loop
      .mockResolvedValueOnce({ total_entries: 9000, people: [] });

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
    mockChatComplete
      .mockReset()
      .mockResolvedValueOnce(decide("test", { personTitles: ["Nobody"] }, MECE))
      .mockResolvedValue(decide("confirm", CONFIRMED_FILTERS, MECE));
    mockSearchPeople
      .mockResolvedValueOnce({ total_entries: 0, people: [] })
      .mockResolvedValueOnce({ total_entries: 42000, people: [] });

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    expect(res.body.count).toBe(42000);
    expect(res.body.filters).toEqual(CONFIRMED_FILTERS);
  });

  it("a decision missing the target-fit flags is unusable output, not a clean default", async () => {
    // No silent default-to-MECE: an ungraded proposal burns the invalid-retry
    // budget exactly like malformed JSON.
    mockChatComplete
      .mockReset()
      .mockResolvedValue(chatRes({ action: "confirm", filters: CONFIRMED_FILTERS, reasoning: "r" }));

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(500);

    expect(mockChatComplete).toHaveBeenCalledTimes(4); // 4th trips invalidRetries > 3 → break
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  it("invalid model output does not consume the 6 real-attempt budget", async () => {
    // 2 malformed decisions (no real attempt) then 6 valid off-target confirms (6 real attempts).
    mockChatComplete
      .mockReset()
      .mockResolvedValueOnce(chatRes({ garbage: true }))
      .mockResolvedValueOnce(chatRes({ still: "wrong" }))
      .mockResolvedValue(decide("confirm", { personTitles: ["Founder"] }, offTarget("no sector")));
    mockSearchPeople.mockResolvedValue({ total_entries: 1000, people: [] });

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200); // no MECE-judged set → degraded to the best attempt

    // 2 invalid (retry budget) + 6 valid (real budget) = 8 chat calls; invalids did not eat the 6.
    expect(mockChatComplete).toHaveBeenCalledTimes(8);
    expect(mockSearchPeople).toHaveBeenCalledTimes(6);
  });

  it("aborts once the invalid-retry budget is exhausted", async () => {
    // 4 consecutive malformed decisions (> MAX_INVALID_RETRIES of 3) → break, nothing to select → 500.
    mockChatComplete.mockReset().mockResolvedValue(chatRes({ garbage: true }));

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(500);

    expect(mockChatComplete).toHaveBeenCalledTimes(4); // 4th trips invalidRetries > 3 → break
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });
});
