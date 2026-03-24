import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Regression test: x-campaign-id, x-brand-id, x-workflow-name headers
 * must be forwarded on all downstream HTTP calls (runs-service, key-service)
 * and stored in the database.
 */

// Track all call args
const mockCreateRun = vi.fn().mockResolvedValue({ id: "child-run-1" });
const mockUpdateRun = vi.fn().mockResolvedValue({});
const mockAddCosts = vi.fn().mockResolvedValue({ costs: [] });

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
  addCosts: (...args: unknown[]) => mockAddCosts(...args),
}));

const mockDecryptKey = vi.fn().mockResolvedValue({ key: "test-key", keySource: "platform" });
vi.mock("../../src/lib/keys-client.js", () => ({
  decryptKey: (...args: unknown[]) => mockDecryptKey(...args),
}));

vi.mock("../../src/lib/billing-client.js", () => ({
  authorizeCredit: vi.fn().mockResolvedValue({ sufficient: true, balance_cents: 99999 }),
}));

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = req.headers["x-org-id"] || "org-1";
    req.userId = req.headers["x-user-id"] || "user-1";
    if (req.headers["x-run-id"]) req.runId = req.headers["x-run-id"];
    if (req.headers["x-brand-id"]) req.brandId = req.headers["x-brand-id"];
    if (req.headers["x-campaign-id"]) req.campaignId = req.headers["x-campaign-id"];
    if (req.headers["x-feature-slug"]) req.featureSlug = req.headers["x-feature-slug"];
    if (req.headers["x-workflow-name"]) req.workflowName = req.headers["x-workflow-name"];
    next();
  },
}));

const mockSearchPeople = vi.fn().mockResolvedValue({
  people: [{ id: "p1", first_name: "Jane", last_name: "Doe", email: "jane@test.com", email_status: "verified", title: "CEO", linkedin_url: null }],
  total_entries: 1,
  pagination: { total_entries: 1 },
});

vi.mock("../../src/lib/apollo-client.js", () => ({
  searchPeople: (...args: unknown[]) => mockSearchPeople(...args),
  enrichPerson: vi.fn(),
  matchPersonByName: vi.fn(),
  bulkMatchPeopleByName: vi.fn(),
}));

// DB mock: capture insert values
let lastInsertValues: Record<string, unknown> | null = null;

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((vals: unknown) => {
        lastInsertValues = vals as Record<string, unknown>;
        return {
          returning: vi.fn().mockResolvedValue([{ id: "record-1" }]),
        };
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

const TRACKING_HEADERS = {
  "X-Org-Id": "org-1",
  "X-User-Id": "user-1",
  "X-Run-Id": "run-parent",
  "X-Brand-Id": "brand-abc",
  "X-Campaign-Id": "campaign-xyz",
  "X-Feature-Slug": "lead-gen",
  "X-Workflow-Name": "lead-search-workflow",
};

function createApp() {
  const app = express();
  app.use(express.json());
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  lastInsertValues = null;
});

describe("tracking headers forwarding", () => {
  it("forwards x-brand-id, x-campaign-id, x-workflow-name to key-service via decryptKey", async () => {
    const { default: searchRouter } = await import("../../src/routes/search.js");
    const app = createApp();
    app.use(searchRouter);

    await request(app)
      .post("/search")
      .set(TRACKING_HEADERS)
      .send({ personTitles: ["CEO"] })
      .expect(200);

    expect(mockDecryptKey).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "apollo",
      expect.any(Object),
      { brandId: "brand-abc", campaignId: "campaign-xyz", featureSlug: "lead-gen", workflowName: "lead-search-workflow" }
    );
  });

  it("forwards tracking fields in identity to runs-service calls (addCosts, updateRun)", async () => {
    const { default: searchRouter } = await import("../../src/routes/search.js");
    const app = createApp();
    app.use(searchRouter);

    await request(app)
      .post("/search")
      .set(TRACKING_HEADERS)
      .send({ personTitles: ["CEO"] })
      .expect(200);

    // addCosts receives identity with tracking fields
    expect(mockAddCosts).toHaveBeenCalledWith(
      "child-run-1",
      expect.any(Array),
      expect.objectContaining({
        brandId: "brand-abc",
        campaignId: "campaign-xyz",
        featureSlug: "lead-gen",
        workflowName: "lead-search-workflow",
      })
    );

    // updateRun receives identity with tracking fields
    expect(mockUpdateRun).toHaveBeenCalledWith(
      "child-run-1",
      "completed",
      expect.objectContaining({
        brandId: "brand-abc",
        campaignId: "campaign-xyz",
        featureSlug: "lead-gen",
        workflowName: "lead-search-workflow",
      })
    );
  });

  it("passes workflowName to createRun", async () => {
    const { default: searchRouter } = await import("../../src/routes/search.js");
    const app = createApp();
    app.use(searchRouter);

    await request(app)
      .post("/search")
      .set(TRACKING_HEADERS)
      .send({ personTitles: ["CEO"] })
      .expect(200);

    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowName: "lead-search-workflow",
        brandId: "brand-abc",
        campaignId: "campaign-xyz",
      })
    );
  });

  it("forwards featureSlug to createRun", async () => {
    const { default: searchRouter } = await import("../../src/routes/search.js");
    const app = createApp();
    app.use(searchRouter);

    await request(app)
      .post("/search")
      .set(TRACKING_HEADERS)
      .send({ personTitles: ["CEO"] })
      .expect(200);

    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        featureSlug: "lead-gen",
      })
    );
  });

  it("stores featureSlug in DB insert", async () => {
    const { default: searchRouter } = await import("../../src/routes/search.js");
    const app = createApp();
    app.use(searchRouter);

    await request(app)
      .post("/search")
      .set(TRACKING_HEADERS)
      .send({ personTitles: ["CEO"] })
      .expect(200);

    expect(lastInsertValues).toMatchObject({
      featureSlug: "lead-gen",
    });
  });

  it("stores workflowName in DB insert", async () => {
    const { default: searchRouter } = await import("../../src/routes/search.js");
    const app = createApp();
    app.use(searchRouter);

    await request(app)
      .post("/search")
      .set(TRACKING_HEADERS)
      .send({ personTitles: ["CEO"] })
      .expect(200);

    // The first insert is the search record
    expect(lastInsertValues).toMatchObject({
      workflowName: "lead-search-workflow",
    });
  });

  it("works without x-workflow-name header (optional)", async () => {
    const { default: searchRouter } = await import("../../src/routes/search.js");
    const app = createApp();
    app.use(searchRouter);

    const headersWithout = { ...TRACKING_HEADERS };
    delete (headersWithout as any)["X-Workflow-Name"];

    await request(app)
      .post("/search")
      .set(headersWithout)
      .send({ personTitles: ["CEO"] })
      .expect(200);

    // Should still work — workflowName is undefined
    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowName: undefined,
      })
    );
  });
});
