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
    mockChatComplete.mockResolvedValue({
      json: { action: "confirm", filters: CONFIRMED_FILTERS, reasoning: "good fit" },
      content: "",
      tokensInput: 10,
      tokensOutput: 5,
      model: "claude-sonnet",
    });
    app = await createApp();
  });

  it("POST /suggest-from-segment persists and returns {apolloAudienceId, filters, count}", async () => {
    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "Heads of growth", description: "Heads of growth at US fintech", brandId: "brand-1" })
      .expect(200);

    expect(res.body.apolloAudienceId).toBe("aud-1");
    expect(res.body.filters).toEqual(CONFIRMED_FILTERS);
    expect(res.body.count).toBe(42000);
    expect(mockChatComplete).toHaveBeenCalledTimes(1);
    // Refine LLM goes through Google (Gemini) JSON mode, NOT Anthropic: chat-service
    // requires a strict responseSchema for Anthropic JSON, incompatible with the
    // sparse Apollo filter object. Gemini JSON mode needs no schema.
    expect(mockChatComplete).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google", responseFormat: "json" }),
      expect.anything(),
    );
    // The refine loop dry-ran the confirmed filters via Apollo per_page=1.
    expect(mockSearchPeople).toHaveBeenCalledWith("apollo-key", expect.objectContaining({ per_page: 1 }));
    // Stored row carries the faithful filters + count snapshot.
    expect(state.inserted.filters).toEqual(CONFIRMED_FILTERS);
    expect(state.inserted.count).toBe(42000);
    expect(state.inserted.status).toBe("confirmed");
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
    expect(mockSearchPeople).toHaveBeenCalledWith("apollo-key", expect.objectContaining({ per_page: 1 }));
  });

  it("POST /:id/dry-run 404 when not found", async () => {
    state.selectRow = null;
    await request(app).post("/audiences/missing/dry-run").set(HEADERS).expect(404);
  });

  it("refine loop tests then confirms (test → confirm sequence)", async () => {
    mockChatComplete
      .mockResolvedValueOnce({
        json: { action: "test", filters: { personSeniorities: ["c_suite"] }, reasoning: "too broad, try c_suite" },
        content: "", tokensInput: 1, tokensOutput: 1, model: "m",
      })
      .mockResolvedValueOnce({
        json: { action: "confirm", filters: CONFIRMED_FILTERS, reasoning: "good" },
        content: "", tokensInput: 1, tokensOutput: 1, model: "m",
      });
    mockSearchPeople
      .mockResolvedValueOnce({ total_entries: 90000, people: [] }) // test result
      .mockResolvedValueOnce({ total_entries: 42000, people: [] }); // confirm result

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    expect(mockChatComplete).toHaveBeenCalledTimes(2);
    expect(res.body.count).toBe(42000);
    expect(res.body.filters).toEqual(CONFIRMED_FILTERS);
  });

  it("does not accept a zero-match confirm when a later in-band audience exists", async () => {
    const zeroFilters = { personTitles: ["Founder"], qKeywords: "consulting OR \"professional services\"" };
    const inBandFilters = { personTitles: ["Head of Sales"], qKeywords: "consulting" };
    mockChatComplete
      .mockResolvedValueOnce({
        json: { action: "confirm", filters: zeroFilters, reasoning: "specific founder segment" },
        content: "", tokensInput: 1, tokensOutput: 1, model: "m",
      })
      .mockResolvedValueOnce({
        json: { action: "confirm", filters: inBandFilters, reasoning: "healthy sales segment" },
        content: "", tokensInput: 1, tokensOutput: 1, model: "m",
      });
    mockSearchPeople
      .mockResolvedValueOnce({ total_entries: 0, people: [] })
      .mockResolvedValueOnce({ total_entries: 42000, people: [] });

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    expect(mockChatComplete).toHaveBeenCalledTimes(2);
    expect(res.body.count).toBe(42000);
    expect(res.body.filters).toEqual(inBandFilters);
    expect(state.inserted.count).toBe(42000);
  });

  it("does not persist an audience when every tried filter set has zero matches", async () => {
    mockChatComplete.mockResolvedValue({
      json: { action: "confirm", filters: { personTitles: ["Founder"] }, reasoning: "try founders" },
      content: "", tokensInput: 1, tokensOutput: 1, model: "m",
    });
    mockSearchPeople.mockResolvedValue({ total_entries: 0, people: [] });

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(500);

    expect(mockChatComplete).toHaveBeenCalledTimes(6);
    expect(state.inserted).toBeNull();
  });

  it("prompts the model with the faithful-then-largest objective, no forced floor", async () => {
    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(200);

    const [[opts]] = mockChatComplete.mock.calls;
    // Refine loop runs on flash (Gemini 2.5 Flash) with thinking fully off.
    expect(opts.model).toBe("flash");
    expect(opts.disableThinking).toBe(true);
    // Objective: largest FAITHFUL set; ambition of ~20,000 but faithfulness wins.
    expect(opts.systemPrompt).toContain("LARGEST audience");
    expect(opts.systemPrompt).toContain("Never trade faithfulness for size");
    expect(opts.systemPrompt).toContain("at least ~20,000");
    // Faithfulness examples that kill the healthcare-dilution / worldwide bugs.
    expect(opts.systemPrompt).toContain("healthcare");
    // The old carcan is GONE — no "FAILURE below" language that forced betrayal.
    expect(opts.systemPrompt).not.toContain("is a FAILURE");
    expect(opts.systemPrompt).not.toContain("NEVER confirm");
  });

  it("nudges toward a FAITHFULLY-broader set below the ambition, then confirms it", async () => {
    // Two narrow faithful sets below ~20,000, then a faithfully-broader set the model confirms.
    mockChatComplete
      .mockResolvedValueOnce({ json: { action: "test", filters: { personTitles: ["Head of Sales"], qKeywords: "SaaS" }, reasoning: "narrow" }, content: "", tokensInput: 1, tokensOutput: 1, model: "m" })
      .mockResolvedValueOnce({ json: { action: "test", filters: { personTitles: ["Head of Sales"], organizationNumEmployeesRanges: ["50,500"] }, reasoning: "drop keyword" }, content: "", tokensInput: 1, tokensOutput: 1, model: "m" })
      .mockResolvedValueOnce({ json: { action: "confirm", filters: { personTitles: ["Head of Sales"] }, reasoning: "broadest faithful" }, content: "", tokensInput: 1, tokensOutput: 1, model: "m" });
    mockSearchPeople
      .mockResolvedValueOnce({ total_entries: 136, people: [] })
      .mockResolvedValueOnce({ total_entries: 480, people: [] })
      .mockResolvedValueOnce({ total_entries: 25000, people: [] });

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "Heads of Sales at SaaS 50-500", brandId: null })
      .expect(200);

    expect(mockChatComplete).toHaveBeenCalledTimes(3);
    expect(res.body.count).toBe(25000);
    expect(state.inserted.status).toBe("confirmed");

    // The nudge fires on the 2nd+ turn once a below-ambition count is on record,
    // steering toward FAITHFUL widening (never off-topic filters).
    const secondTurnMsg = mockChatComplete.mock.calls[1][0].message as string;
    expect(secondTurnMsg).toContain("below the ~20,000 we aim for");
    expect(secondTurnMsg).toContain("FAITHFULLY-broader set");
    expect(secondTurnMsg).not.toContain("FAILURE");
  });

  it("confirms and persists a genuinely niche faithful audience below the ambition", async () => {
    // US chiropractors ~ a few thousand: a faithful set below ~20,000 must be
    // ACCEPTED as-is, never rejected or inflated with off-topic keywords.
    mockChatComplete.mockResolvedValueOnce({
      json: { action: "confirm", filters: { personTitles: ["Chiropractor"], personLocations: ["United States"] }, reasoning: "faithful niche" },
      content: "", tokensInput: 1, tokensOutput: 1, model: "m",
    });
    mockSearchPeople.mockResolvedValueOnce({ total_entries: 3850, people: [] });

    const res = await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "US Chiropractors", description: "Licensed chiropractors in the US", brandId: null })
      .expect(200);

    expect(mockChatComplete).toHaveBeenCalledTimes(1);
    expect(res.body.count).toBe(3850);
    expect(res.body.filters).toEqual({ personTitles: ["Chiropractor"], personLocations: ["United States"] });
    expect(state.inserted.status).toBe("confirmed");
  });

  it("invalid model output does not consume the 6 real-attempt budget", async () => {
    // 2 malformed decisions (no real attempt) then 6 valid zero-match confirms (6 real attempts).
    mockChatComplete
      .mockResolvedValueOnce({ json: { garbage: true }, content: "", tokensInput: 1, tokensOutput: 1, model: "m" })
      .mockResolvedValueOnce({ json: { still: "wrong" }, content: "", tokensInput: 1, tokensOutput: 1, model: "m" })
      .mockResolvedValue({ json: { action: "confirm", filters: { personTitles: ["Founder"] }, reasoning: "x" }, content: "", tokensInput: 1, tokensOutput: 1, model: "m" });
    mockSearchPeople.mockResolvedValue({ total_entries: 0, people: [] });

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(500); // all real attempts zero-match → no positive set → 500

    // 2 invalid (retry budget) + 6 valid (real budget) = 8 chat calls; invalids did not eat the 6.
    expect(mockChatComplete).toHaveBeenCalledTimes(8);
    expect(mockSearchPeople).toHaveBeenCalledTimes(6);
  });

  it("aborts once the invalid-retry budget is exhausted", async () => {
    // 4 consecutive malformed decisions (> MAX_INVALID_RETRIES of 3) → break, no positive set → 500.
    mockChatComplete.mockResolvedValue({ json: { garbage: true }, content: "", tokensInput: 1, tokensOutput: 1, model: "m" });

    await request(app)
      .post("/audiences/suggest-from-segment")
      .set(HEADERS)
      .send({ name: "n", description: "d", brandId: null })
      .expect(500);

    expect(mockChatComplete).toHaveBeenCalledTimes(4); // 4th trips invalidRetries > 3 → break
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });
});
