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

/**
 * Apollo mock. The refine loop hits people-search twice per round: per_page=1
 * for the count, then 2 random pages of 10 (5 rows kept from each) for the
 * sample. `counts` is consumed one per dry-run (the last value repeats);
 * `people` is what every sampled page returns.
 */
const apollo: { counts: number[]; people: any[]; pagesRequested: number[] } = {
  counts: [42000],
  people: [],
  pagesRequested: [],
};
/** Apollo's free teaser serves only the title + the employer's name — every
 * location field is redacted to a `has_*` boolean. */
const person = (company: string, title: string) => ({ name: "P", title, organization: { name: company } });
function apolloImpl(_key: unknown, params: any) {
  if (params.per_page === 1) {
    const c = apollo.counts.length > 1 ? apollo.counts.shift()! : (apollo.counts[0] ?? 0);
    return Promise.resolve({ total_entries: c, people: [] });
  }
  apollo.pagesRequested.push(params.page);
  return Promise.resolve({ total_entries: 0, people: apollo.people });
}
/** Live counts, one per dry-run, last value repeating. */
const setCounts = (...counts: number[]) => {
  apollo.counts = counts;
};

const HEADERS = { "X-Org-Id": "org-1", "X-User-Id": "user-1", "X-Api-Key": "k" };
const FINAL_FILTERS = { personSeniorities: ["head"], personTitles: ["Head of Growth"] };
const FIRST_ENCODING = { personSeniorities: ["head"], qOrganizationKeywordTags: ["fintech"] };

const chatRes = (json: unknown) => ({ json, content: "", tokensInput: 1, tokensOutput: 1, model: "m" });
/** One model turn: a filter set plus the two booleans and the three notes. */
const round = (
  filters: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) =>
  chatRes({
    filters,
    showable: true,
    toContinue: true,
    whatWorked: "w",
    whatToImprove: "i",
    nextExperiment: "n",
    reasoning: "r",
    ...extra,
  });
/** The model's last round: satisfied, stop here. */
const stop = (filters: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  round(filters, { toContinue: false, ...extra });

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
    apollo.counts = [42000];
    apollo.people = [person("Drogerie Müller", "Owner")];
    apollo.pagesRequested = [];
    mockSearchPeople.mockImplementation(apolloImpl);
    // Default: one exploratory round, then the model stops on FINAL_FILTERS.
    mockChatComplete
      .mockResolvedValueOnce(round(FIRST_ENCODING, { showable: false }))
      .mockResolvedValue(stop(FINAL_FILTERS));
    app = await createApp();
  });

  it("POST /suggest-from-segment persists and returns {apolloAudienceId, filters, count}", async () => {
    setCounts(1000, 42000);

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "Heads of growth", description: "Heads of growth at US fintech", brandId: "brand-1" })
      .expect(200);

    expect(res.body.apolloAudienceId).toBe("aud-1");
    expect(res.body.filters).toEqual(FINAL_FILTERS);
    expect(res.body.count).toBe(42000);
    expect(res.body.degraded).toBe(false);
    expect(mockChatComplete).toHaveBeenCalledTimes(2);
    // Schemaless JSON mode on the cheap-and-smart model (zai/glm-pro). No
    // Anthropic, no google/pro.
    expect(mockChatComplete).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "zai", model: "glm-pro", responseFormat: "json" }),
      expect.anything(),
    );
    // Reasoning stays ON.
    expect(mockChatComplete.mock.calls[0][0].disableThinking).toBeUndefined();
    // Schemaless: no responseSchema is sent — the Zod guards validate.
    expect(mockChatComplete.mock.calls[0][0].responseSchema).toBeUndefined();
    // Each candidate was dry-run for free via Apollo per_page=1.
    expect(mockSearchPeople).toHaveBeenCalledWith("apollo-key", expect.objectContaining({ per_page: 1 }), expect.anything());
    // Stored row carries the winning filters + count snapshot + the sample.
    expect(state.inserted.filters).toEqual(FINAL_FILTERS);
    expect(state.inserted.count).toBe(42000);
    expect(state.inserted.status).toBe("confirmed");
    expect(state.inserted.refineTrace[0].sample[0]).toEqual({ company: "Drogerie Müller", title: "Owner" });
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
      filters: FINAL_FILTERS,
      count: 4200,
      status: "confirmed",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
    const res = await request(app).get("/audiences/aud-1").set({ "X-Org-Id": "org-1", "X-Api-Key": "k" }).expect(200);
    expect(res.body).toEqual({
      apolloAudienceId: "aud-1",
      filters: FINAL_FILTERS,
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
    state.selectRow = { id: "aud-1", orgId: "org-1", brandId: "brand-1", filters: FINAL_FILTERS, count: 4200 };
    setCounts(5000);
    const res = await request(app).post("/audiences/aud-1/dry-run").set(HEADERS).expect(200);
    expect(res.body).toEqual({ count: 5000 });
    expect(mockSearchPeople).toHaveBeenCalledWith("apollo-key", expect.objectContaining({ per_page: 1 }), expect.anything());
  });

  it("POST /:id/dry-run 404 when not found", async () => {
    state.selectRow = null;
    await request(app).post("/audiences/missing/dry-run").set(HEADERS).expect(404);
  });

  // ────────────────────────────────────────────────────────────────────────
  // AC1 — the prompt gives DATA and CONTEXT, never targeting rules
  // ────────────────────────────────────────────────────────────────────────

  it("AC1 — the prompt states the goal, the cold-email context (both halves) and the budget", async () => {
    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    const [[opts]] = mockChatComplete.mock.calls;
    // The goal, plainly stated, and the loop's own mechanics.
    expect(opts.systemPrompt).toContain("reaches as many relevant people as possible");
    expect(opts.systemPrompt).toContain("You have up to 10 rounds");
    // Half one: why volume matters, with the orientation numbers.
    expect(opts.systemPrompt).toContain("COLD EMAIL campaign");
    expect(opts.systemPrompt).toContain("2,000 contactable");
    expect(opts.systemPrompt).toContain("50,000");
    expect(opts.systemPrompt).toContain("An audience of 4 people makes the whole engagement pointless");
    // Half two — without it the model loosens until it hits the number.
    expect(opts.systemPrompt).toContain("CONTEXT, not a target and not a floor");
    expect(opts.systemPrompt).toContain("genuinely small answer is a VALID, CORRECT answer");
    expect(opts.systemPrompt).toContain("Never loosen the request to reach a number");
    // Selection rule is stated, so a good early set is known to stay in the running.
    expect(opts.systemPrompt).toContain("SHOWABLE set with the LARGEST count is what we return");

    const allPrompts = mockChatComplete.mock.calls
      .map(([o]: any[]) => `${o.systemPrompt}\n${o.message}`)
      .join("\n");

    // AC5 — no targeting rule, count floor or threshold came back.
    expect(allPrompts).not.toMatch(/MECE/);
    expect(allPrompts).not.toMatch(/reachesOffTarget|leavesTargetUnreached/);
    expect(allPrompts).not.toMatch(/maximize volume/i);
    expect(allPrompts).not.toContain("FIRMOGRAPHIC CONSTRAINTS ARE NEVER INVENTED");
    expect(allPrompts).not.toContain("Do not infer a size band");
    expect(allPrompts).not.toContain("Never drop the concept");
    expect(allPrompts).not.toMatch(/ambition|aim for|at least [0-9~]/i);
    // No drugstore / geography / industry / company-size instruction in the
    // standing prompt (the SAMPLE legitimately names companies — that is data).
    expect(opts.systemPrompt.toLowerCase()).not.toContain("drogerie");
    expect(opts.systemPrompt).not.toMatch(/German-speaking|canton/i);
  });

  it("AC1 — the request is repeated verbatim every round", async () => {
    setCounts(1000, 42000);
    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "Drogerien", description: "People who run drugstores", brandId: null })
      .expect(200);

    for (const [opts] of mockChatComplete.mock.calls) {
      expect(opts.message).toContain("=== THE REQUEST (verbatim) ===");
      expect(opts.message).toContain("Segment description: People who run drugstores");
    }
  });

  // ────────────────────────────────────────────────────────────────────────
  // AC2 — history carries filters, count, 10 sample rows and the three notes
  // ────────────────────────────────────────────────────────────────────────

  it("AC2 — history entries carry filters, count, sample rows and the model's three notes", async () => {
    apollo.people = [person("Drogerie Meer", "Inhaber"), person("Rolex", "Head of Retail")];
    mockChatComplete
      .mockReset()
      .mockResolvedValueOnce(
        round(FIRST_ENCODING, {
          showable: false,
          whatWorked: "tags found shops",
          whatToImprove: "too narrow",
          nextExperiment: "drop the industry filter",
        }),
      )
      .mockResolvedValue(stop(FINAL_FILTERS));
    setCounts(1222, 2640);

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    const second = mockChatComplete.mock.calls[1][0].message as string;
    expect(second).toContain("count=1222");
    expect(second).toContain("showable=false");
    expect(second).toContain('"qOrganizationKeywordTags":["fintech"]');
    expect(second).toContain("Drogerie Meer — Inhaber");
    expect(second).toContain("Rolex — Head of Retail");
    expect(second).toContain("worked: tags found shops");
    expect(second).toContain("to improve: too narrow");
    expect(second).toContain("next: drop the industry filter");
    expect(second).toContain("Round 2 of 10");
  });

  it("AC2 — 10 sample rows, drawn from random pages, never past Apollo's 500-page cap", async () => {
    apollo.people = Array.from({ length: 10 }, (_, i) => person(`Co ${i}`, "Owner"));
    mockChatComplete.mockReset().mockResolvedValue(stop(FINAL_FILTERS));
    setCounts(42000); // 4,200 pages of 10, clamped to Apollo's 500

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    expect(state.inserted.refineTrace[0].sample).toHaveLength(10); // 2 pages x 5 rows
    expect(apollo.pagesRequested.length).toBe(2);
    expect(new Set(apollo.pagesRequested).size).toBe(2); // distinct pages
    for (const p of apollo.pagesRequested) {
      expect(p).toBeGreaterThanOrEqual(1);
      expect(p).toBeLessThanOrEqual(500);
    }
    expect(mockSearchPeople).toHaveBeenCalledWith("apollo-key", expect.objectContaining({ per_page: 10 }), expect.anything());
  });

  it("a zero-match set costs no sample requests", async () => {
    mockChatComplete
      .mockReset()
      .mockResolvedValueOnce(round({ personTitles: ["Nobody"] }, { showable: false }))
      .mockResolvedValue(stop(FINAL_FILTERS));
    setCounts(0, 42000);

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    expect(apollo.pagesRequested.length).toBe(2); // only the non-empty round sampled
    expect(state.inserted.refineTrace[0].sample).toEqual([]);
  });

  // ────────────────────────────────────────────────────────────────────────
  // AC3/AC4 — showable + toContinue, and largest-showable selection
  // ────────────────────────────────────────────────────────────────────────

  it("AC3 — toContinue:false ends the loop early", async () => {
    mockChatComplete.mockReset().mockResolvedValue(stop(FINAL_FILTERS));
    setCounts(42000);

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    expect(mockChatComplete).toHaveBeenCalledTimes(1);
    expect(state.inserted.refineTrace[0]).toMatchObject({ action: "round", showable: true, toContinue: false });
  });

  it("AC4 — the LARGEST showable round wins, not the last one", async () => {
    // The failure this exists to fix: the loop shipped its final over-constrained
    // set (4 people) while an earlier showable round reached 659.
    const wide = { personTitles: ["Owner"], qOrganizationKeywordTags: ["drogerie"] };
    const narrow = { ...wide, organizationNumEmployeesRanges: ["1,5"] };
    mockChatComplete
      .mockReset()
      .mockResolvedValueOnce(round(wide))
      .mockResolvedValue(stop(narrow));
    setCounts(659, 4);

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    expect(res.body.filters).toEqual(wide);
    expect(res.body.count).toBe(659);
    expect(res.body.degraded).toBe(false);
    // The losing round is still traced (bronze).
    expect(state.inserted.refineTrace[1]).toMatchObject({ count: 4, action: "round" });
  });

  it("AC4 — a bigger NON-showable round never beats a smaller showable one", async () => {
    const offTarget = { personTitles: ["Owner"] };
    mockChatComplete
      .mockReset()
      .mockResolvedValueOnce(round(offTarget, { showable: false }))
      .mockResolvedValue(stop(FINAL_FILTERS, { showable: true }));
    setCounts(164721, 659);

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    expect(res.body.filters).toEqual(FINAL_FILTERS);
    expect(res.body.count).toBe(659);
    expect(res.body.degraded).toBe(false);
  });

  it("AC4 — with NO showable round, the largest overall is returned, marked degraded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const a = { personTitles: ["Owner"] };
    const b = { personTitles: ["Founder"] };
    mockChatComplete
      .mockReset()
      .mockResolvedValueOnce(round(a, { showable: false }))
      .mockResolvedValue(stop(b, { showable: false }));
    setCounts(300, 90);

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    expect(res.body.degraded).toBe(true);
    expect(res.body.filters).toEqual(a);
    expect(res.body.count).toBe(300);
    expect(state.inserted.status).toBe("exhausted");
    warn.mockRestore();
  });

  it("an omitted showable is not confidence — degraded, largest set still returned", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockChatComplete
      .mockReset()
      .mockResolvedValue(chatRes({ filters: FINAL_FILTERS, toContinue: false, reasoning: "r" }));
    setCounts(42000);

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    expect(res.body.degraded).toBe(true);
    expect(res.body.filters).toEqual(FINAL_FILTERS);
    warn.mockRestore();
  });

  it("AC3 — up to 10 rounds; malformed output runs on its own budget", async () => {
    // 2 malformed decisions (retry budget) then rounds that never stop: the loop
    // spends exactly 10 dry-runs.
    mockChatComplete
      .mockReset()
      .mockResolvedValueOnce(chatRes({ garbage: true }))
      .mockResolvedValueOnce(chatRes({ still: "wrong" }))
      .mockResolvedValue(round({ personTitles: ["Owner"] }));
    setCounts(1000);

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    expect(mockChatComplete).toHaveBeenCalledTimes(12); // 2 invalid + 10 rounds
    expect(res.body.filters).toEqual({ personTitles: ["Owner"] });
    expect(res.body.degraded).toBe(false);
    expect(state.inserted.status).toBe("confirmed");
  });

  it("schema-invalid filters burn the retry budget, not a round", async () => {
    mockChatComplete
      .mockReset()
      .mockResolvedValueOnce(round({ notAnApolloField: ["x"] }))
      .mockResolvedValue(stop(FINAL_FILTERS));
    setCounts(42000);

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    expect(res.body.count).toBe(42000);
    expect(state.inserted.refineTrace[0].action).toBe("invalid");
    expect(state.inserted.refineTrace[0].validationErrors.length).toBeGreaterThan(0);
  });

  it("filters sent as a JSON STRING are accepted — a strict-schema provider can only send that", async () => {
    mockChatComplete
      .mockReset()
      .mockResolvedValue(
        chatRes({ filters: JSON.stringify(FINAL_FILTERS), showable: true, toContinue: false, reasoning: "r" }),
      );
    setCounts(42000);

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    expect(res.body.filters).toEqual(FINAL_FILTERS);
    expect(res.body.degraded).toBe(false);
  });

  it("a filters string that is not a JSON object burns the retry budget, not a round", async () => {
    mockChatComplete
      .mockReset()
      .mockResolvedValueOnce(chatRes({ filters: "not json at all", showable: false, toContinue: true }))
      .mockResolvedValue(stop(FINAL_FILTERS));
    setCounts(42000);

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    expect(res.body.count).toBe(42000);
    expect(state.inserted.refineTrace[0].action).toBe("invalid");
    expect(state.inserted.refineTrace[0].validationErrors[0]).toContain("not a JSON object");
  });

  it("aborts once the invalid-retry budget is exhausted", async () => {
    mockChatComplete.mockReset().mockResolvedValue(chatRes({ garbage: true }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(500);

    expect(mockChatComplete).toHaveBeenCalledTimes(4); // 4th trips invalidRetries > 3 → break
    expect(mockSearchPeople).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("a run where every set matched NOBODY still throws, nothing persisted", async () => {
    mockChatComplete.mockReset().mockResolvedValue(stop({ personTitles: ["Nobody"] }));
    setCounts(0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(500);

    expect(res.body.error).toContain("matched at least one person");
    expect(state.inserted).toBeNull();
    warn.mockRestore();
  });

  it("a degraded run logs its full trace; the happy path logs nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockChatComplete
      .mockReset()
      .mockResolvedValueOnce(round({ personTitles: ["Founder"] }, { showable: false }))
      .mockResolvedValue(stop({ personTitles: ["Owner"] }, { showable: false }));
    setCounts(90000, 1959);
    apollo.people = [person("Procter & Gamble", "Owner")];

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "drugstores", brandId: null })
      .expect(200);

    const line = warn.mock.calls.map((c) => c.join(" ")).find((l) => l.includes("refine ended without a confident set"));
    expect(line).toBeDefined();
    expect(line).toContain('"outcome":"degraded"');
    expect(line).toContain('"count":90000');
    expect(line).toContain('"count":1959');
    // The sample and the notes are in the log — that is what makes a bad run diagnosable.
    expect(line).toContain("Procter & Gamble");
    expect(line).toContain('"whatWorked":"w"');

    // Happy path: nothing logged.
    warn.mockClear();
    mockChatComplete.mockReset().mockResolvedValue(stop(FINAL_FILTERS));
    setCounts(42000);
    const ok = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);
    expect(ok.body.degraded).toBe(false);
    expect(warn.mock.calls.some((c) => c.join(" ").includes("refine ended without a confident set"))).toBe(false);
    warn.mockRestore();
  });
});
