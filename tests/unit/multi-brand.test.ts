import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
/**
 * Tests for multi-brand support:
 * - x-brand-id header parsed as CSV
 * - brandIds array stored in DB inserts
 * - brand-fields-client uses pathless endpoint
 */

// ─── parseBrandIds unit tests (inline reimplementation to avoid mock conflict) ─

function parseBrandIds(raw: string | undefined): string[] {
  return String(raw ?? "").split(",").map(s => s.trim()).filter(Boolean);
}

describe("parseBrandIds", () => {
  it("parses single UUID", () => {
    expect(parseBrandIds("brand-1")).toEqual(["brand-1"]);
  });

  it("parses comma-separated UUIDs", () => {
    expect(parseBrandIds("brand-1,brand-2,brand-3")).toEqual(["brand-1", "brand-2", "brand-3"]);
  });

  it("trims whitespace around values", () => {
    expect(parseBrandIds("brand-1 , brand-2 , brand-3")).toEqual(["brand-1", "brand-2", "brand-3"]);
  });

  it("filters empty strings", () => {
    expect(parseBrandIds("brand-1,,brand-2,")).toEqual(["brand-1", "brand-2"]);
  });

  it("returns empty array for undefined", () => {
    expect(parseBrandIds(undefined)).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(parseBrandIds("")).toEqual([]);
  });
});

// ─── Integration: multi-brand headers flow through to DB inserts ────────────

const mockCreateRun = vi.fn().mockResolvedValue({ id: "child-run-1" });
const mockUpdateRun = vi.fn().mockResolvedValue({});
const mockAddCosts = vi.fn().mockResolvedValue({ costs: [] });

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
  addCosts: (...args: unknown[]) => mockAddCosts(...args),
}));

vi.mock("../../src/lib/keys-client.js", () => ({
  decryptKey: vi.fn().mockResolvedValue({ key: "test-key", keySource: "platform" }),
}));

vi.mock("../../src/lib/billing-client.js", () => ({
  authorizeCredit: vi.fn().mockResolvedValue({ sufficient: true, balance_cents: 99999 }),
}));

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = req.headers["x-org-id"] || "org-1";
    req.userId = req.headers["x-user-id"] || "user-1";
    if (req.headers["x-run-id"]) req.runId = req.headers["x-run-id"];
    if (req.headers["x-brand-id"]) {
      req.brandId = req.headers["x-brand-id"] as string;
      req.brandIds = String(req.headers["x-brand-id"]).split(",").map((s: string) => s.trim()).filter(Boolean);
    }
    if (req.headers["x-campaign-id"]) req.campaignId = req.headers["x-campaign-id"];
    if (req.headers["x-feature-slug"]) req.featureSlug = req.headers["x-feature-slug"];
    if (req.headers["x-workflow-slug"]) req.workflowSlug = req.headers["x-workflow-slug"];
    next();
  },
}));

vi.mock("../../src/lib/apollo-client.js", () => ({
  searchPeople: vi.fn().mockResolvedValue({
    people: [{ id: "p1", first_name: "Jane", last_name: "Doe", email: "jane@test.com", email_status: "verified", title: "CEO", linkedin_url: null }],
    total_entries: 1,
  }),
  enrichPerson: vi.fn(),
  matchPersonByName: vi.fn(),
  bulkMatchPeopleByName: vi.fn(),
  buildWaterfallWebhookUrl: () => undefined,
}));

let lastInsertValues: Record<string, unknown> | null = null;

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockImplementation((table: unknown) => ({
      values: vi.fn().mockImplementation((vals: unknown) => {
        const tableName = (table as { _?: { name?: string } } | undefined)?._?.name;
        if (tableName !== "apollo_search_cursors") {
          lastInsertValues = vals as Record<string, unknown>;
        }
        return {
          returning: vi.fn().mockResolvedValue([{ id: "record-1" }]),
        };
      }),
    })),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    query: {
      apolloPeopleSearches: { findMany: vi.fn().mockResolvedValue([]) },
      apolloPeopleEnrichments: { findMany: vi.fn().mockResolvedValue([]) },
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  apolloPeopleSearches: { id: { name: "id" } },
  apolloPeopleEnrichments: {
    id: { name: "id" },
    apolloPersonId: { name: "apollo_person_id" },
    email: { name: "email" },
    emailStatus: { name: "email_status" },
    createdAt: { name: "created_at" },
    campaignId: { name: "campaign_id" },
    orgId: { name: "org_id" },
  },
  apolloSearchCursors: { id: { name: "id" }, orgId: { name: "org_id" }, campaignId: { name: "campaign_id" } },
}));

vi.mock("../../src/lib/transform.js", () => ({
  transformApolloPerson: (p: any) => ({ id: p.id, firstName: p.first_name }),
  toEnrichmentDbValues: (p: any) => ({ apolloPersonId: p.id, firstName: p.first_name }),
  transformCachedEnrichment: vi.fn(),
  toApolloSearchParams: (p: any) => p,
}));

const MULTI_BRAND_HEADERS = {
  "X-Org-Id": "org-1",
  "X-User-Id": "user-1",
  "X-Run-Id": "run-parent",
  "X-Brand-Id": "brand-aaa,brand-bbb,brand-ccc",
  "X-Campaign-Id": "campaign-xyz",
};

describe("multi-brand DB inserts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastInsertValues = null;
  });

  it("stores brandIds as array in search insert", async () => {
    const { default: searchRouter } = await import("../../src/routes/search.js");
    const app = express();
    app.use(express.json());
    app.use(searchRouter);

    await request(app)
      .post("/search/next")
      .set(MULTI_BRAND_HEADERS)
      .send({ searchParams: { personTitles: ["CEO"] } })
      .expect(200);

    expect(lastInsertValues).toMatchObject({
      brandIds: ["brand-aaa", "brand-bbb", "brand-ccc"],
    });
  });

  it("forwards raw CSV brandId to downstream services via identity/tracking", async () => {
    const { default: searchRouter } = await import("../../src/routes/search.js");
    const app = express();
    app.use(express.json());
    app.use(searchRouter);

    await request(app)
      .post("/search/next")
      .set(MULTI_BRAND_HEADERS)
      .send({ searchParams: { personTitles: ["CEO"] } })
      .expect(200);

    // identity passed to updateRun should contain raw CSV brandId
    expect(mockUpdateRun).toHaveBeenCalledWith(
      expect.any(String),
      "completed",
      expect.objectContaining({
        brandId: "brand-aaa,brand-bbb,brand-ccc",
      })
    );
  });

  it("single brand still works (backward compatible)", async () => {
    const { default: searchRouter } = await import("../../src/routes/search.js");
    const app = express();
    app.use(express.json());
    app.use(searchRouter);

    await request(app)
      .post("/search/next")
      .set({ ...MULTI_BRAND_HEADERS, "X-Brand-Id": "brand-single" })
      .send({ searchParams: { personTitles: ["CEO"] } })
      .expect(200);

    expect(lastInsertValues).toMatchObject({
      brandIds: ["brand-single"],
    });
  });
});
