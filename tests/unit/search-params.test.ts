import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Tests for POST /search/params — LLM-powered search param generation with retry loop.
 */

// Mock runs-client
const mockCreateRun = vi.fn();
const mockUpdateRun = vi.fn().mockResolvedValue({});
const mockAddCosts = vi.fn().mockResolvedValue({ costs: [] });

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
  addCosts: (...args: unknown[]) => mockAddCosts(...args),
}));

// Mock auth
vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = req.headers["x-org-id"] || "org-internal-123";
    req.userId = req.headers["x-user-id"] || "user-internal-456";
    if (req.headers["x-run-id"]) req.runId = req.headers["x-run-id"];
    if (req.headers["x-brand-id"]) { req.brandId = req.headers["x-brand-id"] as string; req.brandIds = String(req.headers["x-brand-id"]).split(",").map((s: string) => s.trim()).filter(Boolean); }
    if (req.headers["x-campaign-id"]) req.campaignId = req.headers["x-campaign-id"];
    if (req.headers["x-feature-slug"]) req.featureSlug = req.headers["x-feature-slug"];
    if (req.headers["x-workflow-slug"]) req.workflowSlug = req.headers["x-workflow-slug"];
    next();
  },
}));

// Stateful DB mock for cache
let mockCacheResult: Record<string, unknown> | null = null;
const mockInsertValues = vi.fn();
const mockOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => ({
          limit: vi.fn().mockImplementation(() =>
            Promise.resolve(mockCacheResult ? [mockCacheResult] : [])
          ),
        })),
      })),
    })),
    insert: vi.fn().mockImplementation(() => ({
      values: (...args: unknown[]) => {
        mockInsertValues(...args);
        return {
          onConflictDoUpdate: (...ocArgs: unknown[]) => {
            mockOnConflictDoUpdate(...ocArgs);
            return Promise.resolve();
          },
        };
      },
    })),
    query: {
      apolloPeopleSearches: { findMany: vi.fn().mockResolvedValue([]) },
      apolloPeopleEnrichments: { findMany: vi.fn().mockResolvedValue([]) },
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  apolloSearchParamsCache: {
    orgId: { name: "org_id" },
    brandIds: { name: "brand_ids" },
    brandIdsKey: { name: "brand_ids_key" },
    contextHash: { name: "context_hash" },
    createdAt: { name: "created_at" },
  },
}));

// Mock keys-client
const mockDecryptKey = vi.fn();

vi.mock("../../src/lib/keys-client.js", () => ({
  decryptKey: (...args: unknown[]) => mockDecryptKey(...args),
}));

vi.mock("../../src/lib/billing-client.js", () => ({
  authorizeCredit: vi.fn().mockResolvedValue({ sufficient: true, balance_cents: 99999 }),
}));

// Mock campaign-client
const mockGetFeatureInputs = vi.fn();

vi.mock("../../src/lib/campaign-client.js", () => ({
  getFeatureInputs: (...args: unknown[]) => mockGetFeatureInputs(...args),
  clearFeatureInputsCache: vi.fn(),
}));

// Mock brand-fields-client
const mockExtractBrandFields = vi.fn();

vi.mock("../../src/lib/brand-fields-client.js", () => ({
  extractBrandFields: (...args: unknown[]) => mockExtractBrandFields(...args),
}));

// Mock Apollo client
const mockSearchPeople = vi.fn();

vi.mock("../../src/lib/apollo-client.js", () => ({
  searchPeople: (...args: unknown[]) => mockSearchPeople(...args),
}));

// Mock chat-client
const mockChatComplete = vi.fn();

vi.mock("../../src/lib/chat-client.js", () => ({
  chatComplete: (...args: unknown[]) => mockChatComplete(...args),
}));

const BASE_BODY = {
  context: "We sell B2B developer tools to engineering leaders",
};

const BASE_HEADERS = {
  "X-Run-Id": "run-parent-1",
  "X-Brand-Id": "brand-1",
  "X-Campaign-Id": "campaign-1",
};

function createTestApp() {
  const app = express();
  app.use(express.json());
  return app;
}

describe("POST /search/params", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCacheResult = null;

    mockDecryptKey.mockResolvedValue({ key: "fake-apollo-key", keySource: "platform" });

    mockGetFeatureInputs.mockResolvedValue(null);
    mockExtractBrandFields.mockResolvedValue([]);

    let runCount = 0;
    mockCreateRun.mockImplementation(() => {
      runCount++;
      return Promise.resolve({ id: `run-${runCount}` });
    });

    app = createTestApp();
    const { default: searchParamsRoutes } = await import("../../src/routes/search-params.js");
    app.use(searchParamsRoutes);
  });

  // ─── First try succeeds ──────────────────────────────────────────────────

  it("returns params on first try when Apollo returns results", async () => {
    mockChatComplete.mockResolvedValue({
      content: JSON.stringify({ personTitles: ["CTO", "VP Engineering"] }),
      tokensInput: 500,
      tokensOutput: 50,
    });

    mockSearchPeople.mockResolvedValue({
      people: [{ id: "p1" }],
      total_entries: 42,
    });

    const res = await request(app)
      .post("/search/params")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send(BASE_BODY)
      .expect(200);

    expect(res.body.searchParams).toEqual({ personTitles: ["CTO", "VP Engineering"] });
    expect(res.body.totalResults).toBe(42);
    expect(res.body.attempts).toBe(1);
    expect(res.body.attemptHistory).toHaveLength(1);
    expect(mockChatComplete).toHaveBeenCalledTimes(1);
    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
  });

  // ─── Retry succeeds on second attempt ────────────────────────────────────

  it("retries and succeeds when first attempt returns 0 results", async () => {
    mockChatComplete
      .mockResolvedValueOnce({
        content: JSON.stringify({ personTitles: ["CEO"], qKeywords: "niche obscure thing" }),
        tokensInput: 500,
        tokensOutput: 50,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ personTitles: ["CEO", "Founder", "CTO"] }),
        tokensInput: 600,
        tokensOutput: 60,
      });

    mockSearchPeople
      .mockResolvedValueOnce({ people: [], total_entries: 0 })
      .mockResolvedValueOnce({ people: [{ id: "p1" }], total_entries: 15 });

    const res = await request(app)
      .post("/search/params")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send(BASE_BODY)
      .expect(200);

    expect(res.body.attempts).toBe(2);
    expect(res.body.totalResults).toBe(15);
    expect(res.body.searchParams).toEqual({ personTitles: ["CEO", "Founder", "CTO"] });
    expect(mockChatComplete).toHaveBeenCalledTimes(2);
    expect(mockSearchPeople).toHaveBeenCalledTimes(2);
  });

  // ─── All 10 attempts fail ────────────────────────────────────────────────

  it("returns last params with totalResults=0 after 10 failed attempts", async () => {
    mockChatComplete.mockResolvedValue({
      content: JSON.stringify({ personTitles: ["CEO"] }),
      tokensInput: 500,
      tokensOutput: 50,
    });

    mockSearchPeople.mockResolvedValue({ people: [], total_entries: 0 });

    const res = await request(app)
      .post("/search/params")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send(BASE_BODY)
      .expect(200);

    expect(res.body.attempts).toBe(10);
    expect(res.body.totalResults).toBe(0);
    expect(mockChatComplete).toHaveBeenCalledTimes(10);
    expect(mockSearchPeople).toHaveBeenCalledTimes(10);
  });

  // ─── Invalid JSON from LLM ──────────────────────────────────────────────

  it("handles invalid JSON from LLM gracefully and retries", async () => {
    mockChatComplete
      .mockResolvedValueOnce({
        content: "Here are the params: {invalid json",
        tokensInput: 500,
        tokensOutput: 50,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ personTitles: ["CEO"] }),
        tokensInput: 500,
        tokensOutput: 50,
      });

    mockSearchPeople.mockResolvedValue({ people: [{ id: "p1" }], total_entries: 10 });

    const res = await request(app)
      .post("/search/params")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send(BASE_BODY)
      .expect(200);

    expect(res.body.attempts).toBe(2);
    expect(res.body.totalResults).toBe(10);
    // First attempt was invalid JSON, so no Apollo call for it
    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
  });

  // ─── Cost tracking ──────────────────────────────────────────────────────

  it("tracks Apollo search credits (LLM costs handled by chat-service)", async () => {
    mockChatComplete.mockResolvedValue({
      content: JSON.stringify({ personTitles: ["CTO"] }),
      json: { personTitles: ["CTO"] },
      tokensInput: 1234,
      tokensOutput: 56,
      model: "gemini-2.5-flash",
    });

    mockSearchPeople.mockResolvedValue({ people: [{ id: "p1" }], total_entries: 5 });

    await request(app)
      .post("/search/params")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send(BASE_BODY)
      .expect(200);

    const expectedIdentity = expect.objectContaining({ orgId: "org_test" });

    // Apollo search credit only — LLM costs are tracked by chat-service
    expect(mockAddCosts).toHaveBeenCalledWith("run-1", [
      { costName: "apollo-search-credit", costSource: "platform", quantity: 1 },
    ], expectedIdentity);

    // Run completed
    expect(mockUpdateRun).toHaveBeenCalledWith("run-1", "completed", expectedIdentity);
  });

  // ─── Key resolution via decryptKey ─────────────────────────────────────

  it("calls decryptKey for Apollo only (LLM keys handled by chat-service)", async () => {
    mockDecryptKey.mockResolvedValue({ key: "user-apollo-key", keySource: "org" });

    mockChatComplete.mockResolvedValue({
      content: JSON.stringify({ personTitles: ["CEO"] }),
      json: { personTitles: ["CEO"] },
      tokensInput: 100,
      tokensOutput: 20,
      model: "gemini-2.5-flash",
    });

    mockSearchPeople.mockResolvedValue({ people: [{ id: "p1" }], total_entries: 5 });

    await request(app)
      .post("/search/params")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send(BASE_BODY)
      .expect(200);

    // Should call decryptKey for Apollo only — no Anthropic key needed
    const expectedCaller = { callerMethod: "POST", callerPath: "/search/params" };
    const expectedTracking = { brandId: "brand-1", campaignId: "campaign-1", workflowSlug: undefined };
    expect(mockDecryptKey).toHaveBeenCalledTimes(1);
    expect(mockDecryptKey).toHaveBeenCalledWith("org_test", "user_test", "apollo", expectedCaller, expectedTracking);
    // chatComplete receives request object + identity, not raw API key
    expect(mockChatComplete).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "google", model: "flash" }),
      expect.objectContaining({ orgId: "org_test" })
    );
    // searchPeople should receive the Apollo key
    expect(mockSearchPeople).toHaveBeenCalledWith(
      "user-apollo-key",
      expect.any(Object)
    );
  });

  it("uses Apollo key costSource for search credit tracking", async () => {
    mockDecryptKey.mockResolvedValue({ key: "apollo-key", keySource: "org" });

    mockChatComplete.mockResolvedValue({
      content: JSON.stringify({ personTitles: ["CEO"] }),
      json: { personTitles: ["CEO"] },
      tokensInput: 100,
      tokensOutput: 20,
      model: "gemini-2.5-flash",
    });

    mockSearchPeople.mockResolvedValue({ people: [{ id: "p1" }], total_entries: 5 });

    await request(app)
      .post("/search/params")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send(BASE_BODY)
      .expect(200);

    const expectedIdentity = expect.objectContaining({ orgId: "org_test" });

    // Apollo costs should use "org" costSource from decryptKey
    expect(mockAddCosts).toHaveBeenCalledWith("run-1", [
      { costName: "apollo-search-credit", costSource: "org", quantity: 1 },
    ], expectedIdentity);
  });

  // ─── Request validation ──────────────────────────────────────────────────

  it("returns 400 when context is missing", async () => {
    const res = await request(app)
      .post("/search/params")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send({ ...BASE_BODY, context: undefined })
      .expect(400);

    expect(res.body.error).toBe("Invalid request");
    expect(mockChatComplete).not.toHaveBeenCalled();
  });

  // ─── LLM returns markdown-wrapped JSON ───────────────────────────────────

  it("handles LLM response wrapped in markdown code blocks", async () => {
    mockChatComplete.mockResolvedValue({
      content: '```json\n{"personTitles": ["CEO"]}\n```',
      tokensInput: 100,
      tokensOutput: 20,
    });

    mockSearchPeople.mockResolvedValue({ people: [{ id: "p1" }], total_entries: 5 });

    const res = await request(app)
      .post("/search/params")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send(BASE_BODY)
      .expect(200);

    expect(res.body.searchParams).toEqual({ personTitles: ["CEO"] });
    expect(res.body.totalResults).toBe(5);
  });

  // ─── workflowSlug propagation ──────────────────────────────────────────

  it("passes workflowSlug to createRun when provided", async () => {
    mockChatComplete.mockResolvedValue({
      content: JSON.stringify({ personTitles: ["CEO"] }),
      tokensInput: 100,
      tokensOutput: 20,
    });

    mockSearchPeople.mockResolvedValue({ people: [{ id: "p1" }], total_entries: 5 });

    await request(app)
      .post("/search/params")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set({ ...BASE_HEADERS, "X-Workflow-Slug": "fetch-lead" })
      .send(BASE_BODY)
      .expect(200);

    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({ workflowSlug: "fetch-lead" })
    );
  });

  it("omits workflowSlug from createRun when not provided", async () => {
    mockChatComplete.mockResolvedValue({
      content: JSON.stringify({ personTitles: ["CEO"] }),
      tokensInput: 100,
      tokensOutput: 20,
    });

    mockSearchPeople.mockResolvedValue({ people: [{ id: "p1" }], total_entries: 5 });

    await request(app)
      .post("/search/params")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send(BASE_BODY)
      .expect(200);

    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({ workflowSlug: undefined })
    );
  });

  // ─── Run is marked failed on error ───────────────────────────────────────

  it("marks run as failed when an error occurs", async () => {
    mockChatComplete.mockRejectedValue(new Error("API key invalid"));

    const res = await request(app)
      .post("/search/params")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send(BASE_BODY)
      .expect(500);

    expect(res.body.error).toBe("API key invalid");
    expect(mockUpdateRun).toHaveBeenCalledWith("run-1", "failed", expect.objectContaining({ orgId: "org_test" }));
  });

  // ─── runId forwarded to chat-service ─────────────────────────────────────

  it("forwards x-run-id to chatComplete identity headers", async () => {
    mockChatComplete.mockResolvedValue({
      content: JSON.stringify({ personTitles: ["CTO"] }),
      tokensInput: 500,
      tokensOutput: 50,
    });

    mockSearchPeople.mockResolvedValue({ people: [{ id: "p1" }], total_entries: 10 });

    await request(app)
      .post("/search/params")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send(BASE_BODY)
      .expect(200);

    const identityArg = mockChatComplete.mock.calls[0][1];
    expect(identityArg.runId).toBe("run-parent-1");
  });

  // ─── Convention 2: Campaign context in LLM calls ─────────────────────────

  it("fetches campaign featureInputs and injects them into the LLM prompt", async () => {
    mockGetFeatureInputs.mockResolvedValue({
      angle: "sustainability",
      target_region: "Europe",
    });

    mockChatComplete.mockResolvedValue({
      content: JSON.stringify({ personTitles: ["CTO"] }),
      tokensInput: 500,
      tokensOutput: 50,
    });

    mockSearchPeople.mockResolvedValue({ people: [{ id: "p1" }], total_entries: 10 });

    await request(app)
      .post("/search/params")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send(BASE_BODY)
      .expect(200);

    expect(mockGetFeatureInputs).toHaveBeenCalledWith("campaign-1", expect.objectContaining({ orgId: "org_test" }));

    // The LLM user message should contain the campaign context
    const userMessage = mockChatComplete.mock.calls[0][0].message;
    expect(userMessage).toContain("Campaign context");
    expect(userMessage).toContain("sustainability");
    expect(userMessage).toContain("Europe");
  });

  // ─── Convention 1: Brand Service fields in LLM calls ─────────────────────

  it("fetches brand fields and injects them into the LLM prompt", async () => {
    mockExtractBrandFields.mockResolvedValue([
      { key: "industry", value: "Renewable Energy", cached: true },
      { key: "target_geography", value: "North America", cached: true },
      { key: "target_job_titles", value: ["VP Sustainability", "Head of ESG"], cached: false },
      { key: "ideal_lead_type", value: null, cached: false },
    ]);

    mockChatComplete.mockResolvedValue({
      content: JSON.stringify({ personTitles: ["VP Sustainability"] }),
      tokensInput: 500,
      tokensOutput: 50,
    });

    mockSearchPeople.mockResolvedValue({ people: [{ id: "p1" }], total_entries: 5 });

    await request(app)
      .post("/search/params")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send(BASE_BODY)
      .expect(200);

    expect(mockExtractBrandFields).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ key: "industry" }),
        expect.objectContaining({ key: "target_geography" }),
        expect.objectContaining({ key: "target_job_titles" }),
        expect.objectContaining({ key: "ideal_lead_type" }),
      ]),
      expect.objectContaining({ orgId: "org_test" })
    );

    // The LLM user message should contain brand intelligence (non-null fields only)
    const userMessage = mockChatComplete.mock.calls[0][0].message;
    expect(userMessage).toContain("Brand intelligence");
    expect(userMessage).toContain("Renewable Energy");
    expect(userMessage).toContain("North America");
    expect(userMessage).toContain("VP Sustainability");
    // null fields should not appear
    expect(userMessage).not.toContain("ideal_lead_type");
  });

  it("still works when brand-service and campaign-service return nothing", async () => {
    mockExtractBrandFields.mockResolvedValue([]);
    mockGetFeatureInputs.mockResolvedValue(null);

    mockChatComplete.mockResolvedValue({
      content: JSON.stringify({ personTitles: ["CEO"] }),
      tokensInput: 500,
      tokensOutput: 50,
    });

    mockSearchPeople.mockResolvedValue({ people: [{ id: "p1" }], total_entries: 10 });

    const res = await request(app)
      .post("/search/params")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send(BASE_BODY)
      .expect(200);

    expect(res.body.searchParams).toEqual({ personTitles: ["CEO"] });
    // No enrichment sections in the prompt
    const userMessage = mockChatComplete.mock.calls[0][0].message;
    expect(userMessage).not.toContain("Brand intelligence");
    expect(userMessage).not.toContain("Campaign context");
  });

  // ─── 24h cache ──────────────────────────────────────────────────────────

  it("returns cached result without calling LLM when cache hit within 24h", async () => {
    mockCacheResult = {
      orgId: "org_test",
      brandIds: ["brand-1"],
      brandIdsKey: "brand-1",
      contextHash: "abc",
      searchParams: { personTitles: ["CEO"] },
      totalResults: 42,
      attempts: 1,
      attemptHistory: [{ searchParams: { personTitles: ["CEO"] }, totalResults: 42 }],
      createdAt: new Date(), // fresh
    };

    const res = await request(app)
      .post("/search/params")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send(BASE_BODY)
      .expect(200);

    expect(res.body.searchParams).toEqual({ personTitles: ["CEO"] });
    expect(res.body.totalResults).toBe(42);
    expect(res.body.cached).toBe(true);
    // No LLM or Apollo calls
    expect(mockChatComplete).not.toHaveBeenCalled();
    expect(mockSearchPeople).not.toHaveBeenCalled();
    expect(mockDecryptKey).not.toHaveBeenCalled();
    // Still creates a run for traceability
    expect(mockCreateRun).toHaveBeenCalledTimes(1);
    expect(mockUpdateRun).toHaveBeenCalledWith(expect.any(String), "completed", expect.any(Object));
  });

  it("calls LLM on cache miss and stores result in cache", async () => {
    // No cache hit
    mockCacheResult = null;

    mockChatComplete.mockResolvedValue({
      content: JSON.stringify({ personTitles: ["CTO"] }),
      tokensInput: 500,
      tokensOutput: 50,
    });

    mockSearchPeople.mockResolvedValue({ people: [{ id: "p1" }], total_entries: 100 });

    const res = await request(app)
      .post("/search/params")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send(BASE_BODY)
      .expect(200);

    expect(res.body.cached).toBe(false);
    expect(res.body.searchParams).toEqual({ personTitles: ["CTO"] });
    // Should have called LLM
    expect(mockChatComplete).toHaveBeenCalledTimes(1);
    // Should store in cache via insert
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_test",
        brandIds: ["brand-1"],
        brandIdsKey: "brand-1",
        searchParams: { personTitles: ["CTO"] },
        totalResults: 100,
      })
    );
  });
});
