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
    if (req.headers["x-brand-id"]) req.brandId = req.headers["x-brand-id"];
    if (req.headers["x-campaign-id"]) req.campaignId = req.headers["x-campaign-id"];
    if (req.headers["x-workflow-name"]) req.workflowName = req.headers["x-workflow-name"];
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
    brandId: { name: "brand_id" },
    contextHash: { name: "context_hash" },
    createdAt: { name: "created_at" },
  },
}));

// Mock keys-client
const mockDecryptKey = vi.fn();

vi.mock("../../src/lib/keys-client.js", () => ({
  decryptKey: (...args: unknown[]) => mockDecryptKey(...args),
}));

// Mock Apollo client
const mockSearchPeople = vi.fn();

vi.mock("../../src/lib/apollo-client.js", () => ({
  searchPeople: (...args: unknown[]) => mockSearchPeople(...args),
}));

// Mock Anthropic client
const mockCallClaude = vi.fn();

vi.mock("../../src/lib/anthropic-client.js", () => ({
  callClaude: (...args: unknown[]) => mockCallClaude(...args),
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

    mockDecryptKey.mockImplementation((_orgId: string, _userId: string, provider: string) => {
      if (provider === "anthropic") return Promise.resolve({ key: "fake-anthropic-key", keySource: "platform" });
      return Promise.resolve({ key: "fake-apollo-key", keySource: "platform" });
    });

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
    mockCallClaude.mockResolvedValue({
      content: JSON.stringify({ personTitles: ["CTO", "VP Engineering"] }),
      inputTokens: 500,
      outputTokens: 50,
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
    expect(mockCallClaude).toHaveBeenCalledTimes(1);
    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
  });

  // ─── Retry succeeds on second attempt ────────────────────────────────────

  it("retries and succeeds when first attempt returns 0 results", async () => {
    mockCallClaude
      .mockResolvedValueOnce({
        content: JSON.stringify({ personTitles: ["CEO"], qKeywords: "niche obscure thing" }),
        inputTokens: 500,
        outputTokens: 50,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ personTitles: ["CEO", "Founder", "CTO"] }),
        inputTokens: 600,
        outputTokens: 60,
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
    expect(mockCallClaude).toHaveBeenCalledTimes(2);
    expect(mockSearchPeople).toHaveBeenCalledTimes(2);
  });

  // ─── All 10 attempts fail ────────────────────────────────────────────────

  it("returns last params with totalResults=0 after 10 failed attempts", async () => {
    mockCallClaude.mockResolvedValue({
      content: JSON.stringify({ personTitles: ["CEO"] }),
      inputTokens: 500,
      outputTokens: 50,
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
    expect(mockCallClaude).toHaveBeenCalledTimes(10);
    expect(mockSearchPeople).toHaveBeenCalledTimes(10);
  });

  // ─── Invalid JSON from LLM ──────────────────────────────────────────────

  it("handles invalid JSON from LLM gracefully and retries", async () => {
    mockCallClaude
      .mockResolvedValueOnce({
        content: "Here are the params: {invalid json",
        inputTokens: 500,
        outputTokens: 50,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ personTitles: ["CEO"] }),
        inputTokens: 500,
        outputTokens: 50,
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

  it("tracks LLM token costs and Apollo search credits with costSource", async () => {
    mockCallClaude.mockResolvedValue({
      content: JSON.stringify({ personTitles: ["CTO"] }),
      inputTokens: 1234,
      outputTokens: 56,
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

    // LLM token costs
    expect(mockAddCosts).toHaveBeenCalledWith("run-1", [
      { costName: "anthropic-sonnet-4.6-tokens-input", costSource: "platform", quantity: 1234 },
      { costName: "anthropic-sonnet-4.6-tokens-output", costSource: "platform", quantity: 56 },
    ], expectedIdentity);

    // Apollo search credit
    expect(mockAddCosts).toHaveBeenCalledWith("run-1", [
      { costName: "apollo-search-credit", costSource: "platform", quantity: 1 },
    ], expectedIdentity);

    // Run completed
    expect(mockUpdateRun).toHaveBeenCalledWith("run-1", "completed", expectedIdentity);
  });

  // ─── Key resolution via decryptKey ─────────────────────────────────────

  it("calls decryptKey for both Apollo and Anthropic providers", async () => {
    mockDecryptKey.mockImplementation((_orgId: string, _userId: string, provider: string) => {
      if (provider === "anthropic") return Promise.resolve({ key: "user-anthropic-key", keySource: "org" });
      return Promise.resolve({ key: "user-apollo-key", keySource: "org" });
    });

    mockCallClaude.mockResolvedValue({
      content: JSON.stringify({ personTitles: ["CEO"] }),
      inputTokens: 100,
      outputTokens: 20,
    });

    mockSearchPeople.mockResolvedValue({ people: [{ id: "p1" }], total_entries: 5 });

    await request(app)
      .post("/search/params")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set(BASE_HEADERS)
      .send(BASE_BODY)
      .expect(200);

    // Should call decryptKey for both providers
    const expectedCaller = { callerMethod: "POST", callerPath: "/search/params" };
    const expectedTracking = { brandId: "brand-1", campaignId: "campaign-1", workflowName: undefined };
    expect(mockDecryptKey).toHaveBeenCalledWith("org_test", "user_test", "apollo", expectedCaller, expectedTracking);
    expect(mockDecryptKey).toHaveBeenCalledWith("org_test", "user_test", "anthropic", expectedCaller, expectedTracking);
    // callClaude should receive the Anthropic key
    expect(mockCallClaude).toHaveBeenCalledWith(
      "user-anthropic-key",
      expect.any(String),
      expect.any(String)
    );
    // searchPeople should receive the Apollo key
    expect(mockSearchPeople).toHaveBeenCalledWith(
      "user-apollo-key",
      expect.any(Object)
    );
  });

  it("uses correct costSource per provider when they differ", async () => {
    mockDecryptKey.mockImplementation((_orgId: string, _userId: string, provider: string) => {
      if (provider === "anthropic") return Promise.resolve({ key: "anthropic-key", keySource: "org" });
      return Promise.resolve({ key: "apollo-key", keySource: "platform" });
    });

    mockCallClaude.mockResolvedValue({
      content: JSON.stringify({ personTitles: ["CEO"] }),
      inputTokens: 100,
      outputTokens: 20,
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

    // Anthropic costs should use "org" costSource
    expect(mockAddCosts).toHaveBeenCalledWith("run-1", [
      { costName: "anthropic-sonnet-4.6-tokens-input", costSource: "org", quantity: 100 },
      { costName: "anthropic-sonnet-4.6-tokens-output", costSource: "org", quantity: 20 },
    ], expectedIdentity);

    // Apollo costs should use "platform" costSource
    expect(mockAddCosts).toHaveBeenCalledWith("run-1", [
      { costName: "apollo-search-credit", costSource: "platform", quantity: 1 },
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
    expect(mockCallClaude).not.toHaveBeenCalled();
  });

  // ─── LLM returns markdown-wrapped JSON ───────────────────────────────────

  it("handles LLM response wrapped in markdown code blocks", async () => {
    mockCallClaude.mockResolvedValue({
      content: '```json\n{"personTitles": ["CEO"]}\n```',
      inputTokens: 100,
      outputTokens: 20,
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

  // ─── workflowName propagation ──────────────────────────────────────────

  it("passes workflowName to createRun when provided", async () => {
    mockCallClaude.mockResolvedValue({
      content: JSON.stringify({ personTitles: ["CEO"] }),
      inputTokens: 100,
      outputTokens: 20,
    });

    mockSearchPeople.mockResolvedValue({ people: [{ id: "p1" }], total_entries: 5 });

    await request(app)
      .post("/search/params")
      .set("X-Org-Id", "org_test")
      .set("X-User-Id", "user_test")
      .set({ ...BASE_HEADERS, "X-Workflow-Name": "fetch-lead" })
      .send(BASE_BODY)
      .expect(200);

    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({ workflowName: "fetch-lead" })
    );
  });

  it("omits workflowName from createRun when not provided", async () => {
    mockCallClaude.mockResolvedValue({
      content: JSON.stringify({ personTitles: ["CEO"] }),
      inputTokens: 100,
      outputTokens: 20,
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
      expect.objectContaining({ workflowName: undefined })
    );
  });

  // ─── Run is marked failed on error ───────────────────────────────────────

  it("marks run as failed when an error occurs", async () => {
    mockCallClaude.mockRejectedValue(new Error("API key invalid"));

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

  // ─── 24h cache ──────────────────────────────────────────────────────────

  it("returns cached result without calling LLM when cache hit within 24h", async () => {
    mockCacheResult = {
      orgId: "org_test",
      brandId: "brand-1",
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
    expect(mockCallClaude).not.toHaveBeenCalled();
    expect(mockSearchPeople).not.toHaveBeenCalled();
    expect(mockDecryptKey).not.toHaveBeenCalled();
    // Still creates a run for traceability
    expect(mockCreateRun).toHaveBeenCalledTimes(1);
    expect(mockUpdateRun).toHaveBeenCalledWith(expect.any(String), "completed", expect.any(Object));
  });

  it("calls LLM on cache miss and stores result in cache", async () => {
    // No cache hit
    mockCacheResult = null;

    mockCallClaude.mockResolvedValue({
      content: JSON.stringify({ personTitles: ["CTO"] }),
      inputTokens: 500,
      outputTokens: 50,
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
    expect(mockCallClaude).toHaveBeenCalledTimes(1);
    // Should store in cache via insert
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_test",
        brandId: "brand-1",
        searchParams: { personTitles: ["CTO"] },
        totalResults: 100,
      })
    );
  });
});
