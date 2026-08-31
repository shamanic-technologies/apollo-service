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
 * Apollo mock. The refine loop hits people-search twice per attempt: per_page=1
 * for the count, then SAMPLE_PAGES pages of 10 for the sample. `counts` is
 * consumed one per dry-run (the last value repeats); `people` is what every
 * sampled page returns.
 */
const apollo: { counts: number[]; people: any[]; pagesRequested: number[] } = {
  counts: [42000],
  people: [],
  pagesRequested: [],
};
const person = (company: string, title: string, city: string, country: string) => ({
  name: "P",
  title,
  city,
  country,
  organization: { name: company },
});
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
/** One model turn. `extra` carries the closing answer on a "final" turn. */
const decide = (
  action: "test" | "final",
  filters: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => chatRes({ action, filters, reasoning: "r", ...extra });

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
    apollo.people = [person("Drogerie Müller", "Owner", "Zürich", "Switzerland")];
    apollo.pagesRequested = [];
    mockSearchPeople.mockImplementation(apolloImpl);
    // Default: one exploratory proposal, then the model's own final answer.
    mockChatComplete
      .mockResolvedValueOnce(decide("test", FIRST_ENCODING))
      .mockResolvedValue(decide("final", FINAL_FILTERS, { matchesRequest: true }));
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
    // The strongest model chat-service exposes, JSON mode with NO responseSchema
    // (a strict Anthropic schema cannot describe the sparse filter object).
    expect(mockChatComplete).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic", model: "opus", responseFormat: "json" }),
      expect.anything(),
    );
    // Reasoning stays ON.
    expect(mockChatComplete.mock.calls[0][0].disableThinking).toBeUndefined();
    // Each candidate was dry-run for free via Apollo per_page=1.
    expect(mockSearchPeople).toHaveBeenCalledWith("apollo-key", expect.objectContaining({ per_page: 1 }), expect.anything());
    // Stored row carries the winning filters + count snapshot + the sample.
    expect(state.inserted.filters).toEqual(FINAL_FILTERS);
    expect(state.inserted.count).toBe(42000);
    expect(state.inserted.status).toBe("confirmed");
    expect(state.inserted.refineTrace[0].sample[0]).toEqual({
      company: "Drogerie Müller",
      title: "Owner",
      city: "Zürich",
      country: "Switzerland",
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
  // A strong model, a plain goal, a real budget, and its own final answer
  // ────────────────────────────────────────────────────────────────────────

  it("AC1 — the prompt states the goal and carries none of the deleted rules", async () => {
    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    const [[opts]] = mockChatComplete.mock.calls;
    // The goal, plainly stated, and the loop's own mechanics.
    expect(opts.systemPrompt).toContain("find the Apollo People Search filter set that best answers");
    expect(opts.systemPrompt).toContain("You have up to 10 proposals");
    expect(opts.systemPrompt).toContain("Stop when you have the set you want");

    const allPrompts = mockChatComplete.mock.calls
      .map(([o]: any[]) => `${o.systemPrompt}\n${o.message}`)
      .join("\n");

    // The MECE vocabulary and its invariant are gone.
    expect(allPrompts).not.toMatch(/MECE/);
    expect(allPrompts).not.toContain("we do not add people who should not be there");
    expect(allPrompts).not.toContain("we do not leave out people who should be there");
    expect(allPrompts).not.toMatch(/reachesOffTarget|leavesTargetUnreached/);
    // The volume objective is gone.
    expect(allPrompts).not.toMatch(/maximize volume/i);
    expect(allPrompts).not.toContain("the biggest count wins");
    // The accumulated patch rules are gone — each of them, by its own words.
    expect(allPrompts).not.toContain("FIRMOGRAPHIC CONSTRAINTS ARE NEVER INVENTED");
    expect(allPrompts).not.toContain("Do not infer a size band");
    expect(allPrompts).not.toContain("READ THE COUNTS");
    expect(allPrompts).not.toContain("Never drop the concept");
    expect(allPrompts).not.toContain("NOT a signal that the constraint is superfluous");
    expect(allPrompts).not.toContain("ALTERNATIVE");
    // No size steering ever came back either.
    expect(allPrompts).not.toMatch(/ambition|aim for|at least [0-9~]/i);
  });

  it("AC2 — the model's own final set is returned, even when an earlier round counted 20x more", async () => {
    // The 82,522 regression, from the other end: nothing re-ranks on count, so
    // the sector-less monster loses simply by not being the model's answer.
    const sectorless = { personTitles: ["Owner"], personLocations: ["United States"] };
    const withSector = { ...sectorless, qOrganizationKeywordTags: ["chiropractic"] };
    mockChatComplete
      .mockReset()
      .mockResolvedValueOnce(decide("test", sectorless))
      .mockResolvedValue(decide("final", withSector, { matchesRequest: true }));
    setCounts(82522, 4100);

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "Owners of US chiropractic clinics", brandId: null })
      .expect(200);

    expect(res.body.filters).toEqual(withSector);
    expect(res.body.count).toBe(4100);
    expect(state.inserted.count).toBe(4100);
    // The rejected set is still traced (bronze).
    expect(state.inserted.refineTrace[0]).toMatchObject({ count: 82522, action: "test" });
  });

  it("AC4 — degraded carries the model's closing answer and does NOT change the set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const chosen = { personTitles: ["Owner"] };
    const bigger = { personTitles: ["Founder"] };
    mockChatComplete
      .mockReset()
      .mockResolvedValueOnce(decide("test", bigger))
      // Says no — and still gets its own set back, unchanged.
      .mockResolvedValue(decide("final", chosen, { matchesRequest: false }));
    setCounts(90000, 300);

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    expect(res.body.degraded).toBe(true);
    expect(res.body.filters).toEqual(chosen);
    expect(res.body.count).toBe(300);
    expect(state.inserted.refineTrace[1].matchesRequest).toBe(false);
    warn.mockRestore();
  });

  it("an omitted closing answer is not confidence — degraded, same set", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockChatComplete.mockReset().mockResolvedValue(decide("final", FINAL_FILTERS));
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

  it("AC3 — up to 10 real attempts; malformed output runs on its own budget", async () => {
    // 2 malformed decisions (retry budget) then 10 "test" turns (real budget):
    // the loop never gets a final and spends exactly 10 dry-runs.
    mockChatComplete
      .mockReset()
      .mockResolvedValueOnce(chatRes({ garbage: true }))
      .mockResolvedValueOnce(chatRes({ still: "wrong" }))
      .mockResolvedValue(decide("test", { personTitles: ["Owner"] }));
    setCounts(1000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    expect(mockChatComplete).toHaveBeenCalledTimes(12); // 2 invalid + 10 real
    // No closing answer was ever given → the last proposal stands, unblessed.
    expect(res.body.filters).toEqual({ personTitles: ["Owner"] });
    expect(res.body.degraded).toBe(true);
    expect(state.inserted.status).toBe("exhausted");
    warn.mockRestore();
  });

  it("schema-invalid filters burn the retry budget, not a real attempt", async () => {
    mockChatComplete
      .mockReset()
      .mockResolvedValueOnce(decide("test", { notAnApolloField: ["x"] }))
      .mockResolvedValue(decide("final", FINAL_FILTERS, { matchesRequest: true }));
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

  it("a set matching NOBODY is not an audience — still throws, nothing persisted", async () => {
    // Fail loud survives for real errors: every candidate matched zero people.
    mockChatComplete.mockReset().mockResolvedValue(decide("final", { personTitles: ["Nobody"] }, { matchesRequest: true }));
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

  it("AC5 — a degraded run logs its full trace; the happy path logs nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockChatComplete
      .mockReset()
      .mockResolvedValueOnce(decide("test", { personTitles: ["Founder"] }))
      .mockResolvedValue(decide("final", { personTitles: ["Owner"] }, { matchesRequest: false }));
    setCounts(90000, 1959);
    apollo.people = [person("Procter & Gamble", "Owner", "Genève", "Switzerland")];

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "drugstores in German-speaking Switzerland", brandId: null })
      .expect(200);

    const line = warn.mock.calls.map((c) => c.join(" ")).find((l) => l.includes("refine ended without a confident set"));
    expect(line).toBeDefined();
    expect(line).toContain('"outcome":"degraded"');
    expect(line).toContain('"count":90000');
    expect(line).toContain('"count":1959');
    // The sample is in the log — that is what makes a bad run diagnosable.
    expect(line).toContain("Procter & Gamble");
    expect(line).toContain("Genève");

    // Happy path: nothing logged.
    warn.mockClear();
    mockChatComplete.mockReset().mockResolvedValue(decide("final", FINAL_FILTERS, { matchesRequest: true }));
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

  // ────────────────────────────────────────────────────────────────────────
  // The sample: a count says how many, never who
  // ────────────────────────────────────────────────────────────────────────

  it("shows the model company / title / city / country for real matched people", async () => {
    apollo.people = [
      person("Drogerie Müller", "Inhaber", "Zürich", "Switzerland"),
      person("Rolex", "Head of Retail", "Genève", "Switzerland"),
    ];
    setCounts(1222, 2640);

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "drugstores in German-speaking Switzerland", brandId: null })
      .expect(200);

    // Round 2 sees what round 1 actually returned — the Genève row is the leak.
    const second = mockChatComplete.mock.calls[1][0].message as string;
    expect(second).toContain("count=1222");
    expect(second).toContain("Drogerie Müller — Inhaber — Zürich, Switzerland");
    expect(second).toContain("Rolex — Head of Retail — Genève, Switzerland");
  });

  it("samples random pages, not just the head — and never past Apollo's 500-page cap", async () => {
    // 42,000 matches = 4,200 pages of 10, clamped to Apollo's 500.
    mockChatComplete.mockReset().mockResolvedValue(decide("final", FINAL_FILTERS, { matchesRequest: true }));
    setCounts(42000);

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    expect(apollo.pagesRequested.length).toBe(2);
    expect(new Set(apollo.pagesRequested).size).toBe(2); // distinct pages
    for (const p of apollo.pagesRequested) {
      expect(p).toBeGreaterThanOrEqual(1);
      expect(p).toBeLessThanOrEqual(500);
    }
    // Sampled pages are pulled at 10/page, not 1.
    expect(mockSearchPeople).toHaveBeenCalledWith("apollo-key", expect.objectContaining({ per_page: 10 }), expect.anything());
  });

  it("a zero-match set costs no sample requests", async () => {
    mockChatComplete
      .mockReset()
      .mockResolvedValueOnce(decide("test", { personTitles: ["Nobody"] }))
      .mockResolvedValue(decide("final", FINAL_FILTERS, { matchesRequest: true }));
    setCounts(0, 42000);

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    // Only the second (non-empty) attempt sampled.
    expect(apollo.pagesRequested.length).toBe(2);
    expect(state.inserted.refineTrace[0].sample).toEqual([]);
  });
});
