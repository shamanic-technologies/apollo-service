import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// Track db.select calls to return different results for enrichment vs search queries
let selectCalls: Array<{ groupBy?: boolean }> = [];
let selectResults: any[][] = [];

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "run-1" }),
  updateRun: vi.fn().mockResolvedValue({}),
  addCosts: vi.fn().mockResolvedValue({ costs: [] }),
}));

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = req.headers["x-org-id"] || "org-internal-123";
    if (req.headers["x-run-id"]) req.runId = req.headers["x-run-id"];
    if (req.headers["x-brand-id"]) req.brandId = req.headers["x-brand-id"];
    if (req.headers["x-campaign-id"]) req.campaignId = req.headers["x-campaign-id"];
    if (req.headers["x-feature-slug"]) req.featureSlug = req.headers["x-feature-slug"];
    if (req.headers["x-workflow-slug"]) req.workflowSlug = req.headers["x-workflow-slug"];
    next();
  },
}));

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: vi.fn().mockImplementation((selectObj: any) => {
      const callIndex = selectCalls.length;
      selectCalls.push({ groupBy: false });
      const result = selectResults[callIndex] || [{ enrichedLeadsCount: 0 }];
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockImplementation(() => {
            // If groupBy follows, return the mock; otherwise return result
            return {
              groupBy: vi.fn().mockResolvedValue(result),
              then: (resolve: any) => Promise.resolve(result).then(resolve),
              catch: (reject: any) => Promise.resolve(result).catch(reject),
              [Symbol.toStringTag]: "Promise",
            };
          }),
        }),
      };
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "record-1" }]),
      }),
    }),
    query: {
      apolloPeopleSearches: { findMany: vi.fn().mockResolvedValue([]) },
      apolloPeopleEnrichments: { findMany: vi.fn().mockResolvedValue([]) },
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  apolloPeopleSearches: {
    orgId: "orgId",
    runId: "runId",
    brandId: "brandId",
    campaignId: "campaignId",
    featureSlug: "featureSlug",
    workflowSlug: "workflowSlug",
    peopleCount: "peopleCount",
    totalEntries: "totalEntries",
  },
  apolloPeopleEnrichments: {
    orgId: "orgId",
    runId: "runId",
    brandId: "brandId",
    campaignId: "campaignId",
    featureSlug: "featureSlug",
    workflowSlug: "workflowSlug",
    apolloPersonId: "apolloPersonId",
    email: "email",
    emailStatus: "emailStatus",
    createdAt: "createdAt",
  },
}));

vi.mock("../../src/lib/keys-client.js", () => ({
  getByokKey: vi.fn().mockResolvedValue("fake-apollo-key"),
}));

vi.mock("../../src/lib/billing-client.js", () => ({
  authorizeCredit: vi.fn().mockResolvedValue({ sufficient: true, balance_cents: 99999 }),
}));

vi.mock("../../src/lib/apollo-client.js", () => ({
  searchPeople: vi.fn().mockResolvedValue({ people: [], total_entries: 0 }),
  enrichPerson: vi.fn().mockResolvedValue({ person: null }),
}));

// Mock dynasty client
const mockResolveWorkflow = vi.fn().mockResolvedValue(["cold-email", "cold-email-v2"]);
const mockResolveFeature = vi.fn().mockResolvedValue(["feat-a", "feat-a-v2"]);
const mockFetchAllWorkflow = vi.fn().mockResolvedValue([
  { dynastySlug: "cold-email", slugs: ["cold-email", "cold-email-v2"] },
]);
const mockFetchAllFeature = vi.fn().mockResolvedValue([
  { dynastySlug: "feat-a", slugs: ["feat-a", "feat-a-v2"] },
]);

vi.mock("../../src/lib/dynasty-client.js", () => ({
  resolveWorkflowDynastySlugs: (...args: any[]) => mockResolveWorkflow(...args),
  resolveFeatureDynastySlugs: (...args: any[]) => mockResolveFeature(...args),
  fetchAllWorkflowDynasties: (...args: any[]) => mockFetchAllWorkflow(...args),
  fetchAllFeatureDynasties: (...args: any[]) => mockFetchAllFeature(...args),
  buildSlugToDynastyMap: (dynasties: { dynastySlug: string; slugs: string[] }[]) => {
    const map = new Map<string, string>();
    for (const d of dynasties) {
      for (const slug of d.slugs) map.set(slug, d.dynastySlug);
    }
    return map;
  },
}));

describe("POST /stats - dynasty slug support", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    selectCalls = [];
    selectResults = [];

    app = express();
    app.use(express.json());
    const { default: searchRoutes } = await import("../../src/routes/search.js");
    app.use(searchRoutes);
  });

  // ─── Filtering ──────────────────────────────────────────────────────────────

  it("filters by exact workflowSlug", async () => {
    selectResults = [
      [{ enrichedLeadsCount: 5 }],
      [{ searchCount: 2, fetchedPeopleCount: "30", totalMatchingPeople: "100" }],
    ];

    const res = await request(app)
      .post("/stats")
      .set("X-Org-Id", "org_test")
      .send({ workflowSlug: "cold-email-v2" })
      .expect(200);

    expect(res.body.stats).toBeDefined();
    expect(res.body.stats.enrichedLeadsCount).toBe(5);
    // Dynasty client should NOT be called for exact slug
    expect(mockResolveWorkflow).not.toHaveBeenCalled();
  });

  it("filters by exact featureSlug", async () => {
    selectResults = [
      [{ enrichedLeadsCount: 3 }],
      [{ searchCount: 1, fetchedPeopleCount: "10", totalMatchingPeople: "50" }],
    ];

    const res = await request(app)
      .post("/stats")
      .set("X-Org-Id", "org_test")
      .send({ featureSlug: "feat-a" })
      .expect(200);

    expect(res.body.stats.enrichedLeadsCount).toBe(3);
    expect(mockResolveFeature).not.toHaveBeenCalled();
  });

  it("filters by workflowDynastySlug (resolves to versioned slugs)", async () => {
    mockResolveWorkflow.mockResolvedValueOnce(["cold-email", "cold-email-v2"]);
    selectResults = [
      [{ enrichedLeadsCount: 10 }],
      [{ searchCount: 4, fetchedPeopleCount: "60", totalMatchingPeople: "200" }],
    ];

    const res = await request(app)
      .post("/stats")
      .set("X-Org-Id", "org_test")
      .send({ workflowDynastySlug: "cold-email" })
      .expect(200);

    expect(mockResolveWorkflow).toHaveBeenCalledWith("cold-email");
    expect(res.body.stats.enrichedLeadsCount).toBe(10);
  });

  it("filters by featureDynastySlug (resolves to versioned slugs)", async () => {
    mockResolveFeature.mockResolvedValueOnce(["feat-a", "feat-a-v2"]);
    selectResults = [
      [{ enrichedLeadsCount: 7 }],
      [{ searchCount: 3, fetchedPeopleCount: "40", totalMatchingPeople: "150" }],
    ];

    const res = await request(app)
      .post("/stats")
      .set("X-Org-Id", "org_test")
      .send({ featureDynastySlug: "feat-a" })
      .expect(200);

    expect(mockResolveFeature).toHaveBeenCalledWith("feat-a");
    expect(res.body.stats.enrichedLeadsCount).toBe(7);
  });

  it("returns zero stats when dynasty slug resolves to empty list", async () => {
    mockResolveWorkflow.mockResolvedValueOnce([]);

    const res = await request(app)
      .post("/stats")
      .set("X-Org-Id", "org_test")
      .send({ workflowDynastySlug: "nonexistent-dynasty" })
      .expect(200);

    expect(res.body.stats).toEqual({
      enrichedLeadsCount: 0,
      searchCount: 0,
      fetchedPeopleCount: 0,
      totalMatchingPeople: 0,
    });
  });

  it("dynasty slug takes priority over exact slug", async () => {
    mockResolveWorkflow.mockResolvedValueOnce(["cold-email", "cold-email-v2"]);
    selectResults = [
      [{ enrichedLeadsCount: 10 }],
      [{ searchCount: 4, fetchedPeopleCount: "60", totalMatchingPeople: "200" }],
    ];

    const res = await request(app)
      .post("/stats")
      .set("X-Org-Id", "org_test")
      .send({ workflowSlug: "cold-email-v2", workflowDynastySlug: "cold-email" })
      .expect(200);

    // Dynasty slug was used (resolve called), exact slug ignored
    expect(mockResolveWorkflow).toHaveBeenCalledWith("cold-email");
  });

  it("combines dynasty filter with other filters (brandId, campaignId)", async () => {
    mockResolveFeature.mockResolvedValueOnce(["feat-a", "feat-a-v2"]);
    selectResults = [
      [{ enrichedLeadsCount: 2 }],
      [{ searchCount: 1, fetchedPeopleCount: "5", totalMatchingPeople: "20" }],
    ];

    const res = await request(app)
      .post("/stats")
      .set("X-Org-Id", "org_test")
      .send({ featureDynastySlug: "feat-a", brandId: "brand-1", campaignId: "campaign-1" })
      .expect(200);

    expect(res.body.stats.enrichedLeadsCount).toBe(2);
  });

  // ─── GroupBy ────────────────────────────────────────────────────────────────

  it("groups by workflowSlug", async () => {
    selectResults = [
      // enrichment grouped results
      [
        { slug: "cold-email", enrichedLeadsCount: 5 },
        { slug: "cold-email-v2", enrichedLeadsCount: 8 },
      ],
      // search grouped results
      [
        { slug: "cold-email", searchCount: 2, fetchedPeopleCount: "30", totalMatchingPeople: "100" },
        { slug: "cold-email-v2", searchCount: 3, fetchedPeopleCount: "40", totalMatchingPeople: "150" },
      ],
    ];

    const res = await request(app)
      .post("/stats")
      .set("X-Org-Id", "org_test")
      .send({ groupBy: "workflowSlug" })
      .expect(200);

    expect(res.body.grouped).toBeDefined();
    expect(res.body.grouped.length).toBe(2);
    const ce = res.body.grouped.find((g: any) => g.key === "cold-email");
    const cev2 = res.body.grouped.find((g: any) => g.key === "cold-email-v2");
    expect(ce.enrichedLeadsCount).toBe(5);
    expect(cev2.enrichedLeadsCount).toBe(8);
  });

  it("groups by workflowDynastySlug (merges versioned slugs)", async () => {
    mockFetchAllWorkflow.mockResolvedValueOnce([
      { dynastySlug: "cold-email", slugs: ["cold-email", "cold-email-v2"] },
    ]);

    selectResults = [
      [
        { slug: "cold-email", enrichedLeadsCount: 5 },
        { slug: "cold-email-v2", enrichedLeadsCount: 8 },
      ],
      [
        { slug: "cold-email", searchCount: 2, fetchedPeopleCount: "30", totalMatchingPeople: "100" },
        { slug: "cold-email-v2", searchCount: 3, fetchedPeopleCount: "40", totalMatchingPeople: "150" },
      ],
    ];

    const res = await request(app)
      .post("/stats")
      .set("X-Org-Id", "org_test")
      .send({ groupBy: "workflowDynastySlug" })
      .expect(200);

    expect(res.body.grouped).toBeDefined();
    expect(res.body.grouped.length).toBe(1);
    expect(res.body.grouped[0].key).toBe("cold-email");
    expect(res.body.grouped[0].enrichedLeadsCount).toBe(13); // 5 + 8
    expect(res.body.grouped[0].searchCount).toBe(5); // 2 + 3
    expect(res.body.grouped[0].fetchedPeopleCount).toBe(70); // 30 + 40
    expect(res.body.grouped[0].totalMatchingPeople).toBe(250); // 100 + 150
  });

  it("groups by featureDynastySlug", async () => {
    mockFetchAllFeature.mockResolvedValueOnce([
      { dynastySlug: "feat-a", slugs: ["feat-a", "feat-a-v2"] },
    ]);

    selectResults = [
      [
        { slug: "feat-a", enrichedLeadsCount: 3 },
        { slug: "feat-a-v2", enrichedLeadsCount: 4 },
      ],
      [
        { slug: "feat-a", searchCount: 1, fetchedPeopleCount: "10", totalMatchingPeople: "50" },
        { slug: "feat-a-v2", searchCount: 2, fetchedPeopleCount: "20", totalMatchingPeople: "80" },
      ],
    ];

    const res = await request(app)
      .post("/stats")
      .set("X-Org-Id", "org_test")
      .send({ groupBy: "featureDynastySlug" })
      .expect(200);

    expect(res.body.grouped.length).toBe(1);
    expect(res.body.grouped[0].key).toBe("feat-a");
    expect(res.body.grouped[0].enrichedLeadsCount).toBe(7);
  });

  it("orphan slugs (not in any dynasty) fall back to raw slug", async () => {
    mockFetchAllWorkflow.mockResolvedValueOnce([
      { dynastySlug: "cold-email", slugs: ["cold-email", "cold-email-v2"] },
    ]);

    selectResults = [
      [
        { slug: "cold-email", enrichedLeadsCount: 5 },
        { slug: "orphan-workflow", enrichedLeadsCount: 2 },
      ],
      [
        { slug: "cold-email", searchCount: 2, fetchedPeopleCount: "30", totalMatchingPeople: "100" },
        { slug: "orphan-workflow", searchCount: 1, fetchedPeopleCount: "5", totalMatchingPeople: "20" },
      ],
    ];

    const res = await request(app)
      .post("/stats")
      .set("X-Org-Id", "org_test")
      .send({ groupBy: "workflowDynastySlug" })
      .expect(200);

    expect(res.body.grouped.length).toBe(2);
    const ce = res.body.grouped.find((g: any) => g.key === "cold-email");
    const orphan = res.body.grouped.find((g: any) => g.key === "orphan-workflow");
    expect(ce.enrichedLeadsCount).toBe(5);
    expect(orphan.enrichedLeadsCount).toBe(2);
    expect(orphan.key).toBe("orphan-workflow"); // fallback to raw slug
  });

  it("returns empty grouped array when dynasty filter resolves to empty", async () => {
    mockResolveFeature.mockResolvedValueOnce([]);

    const res = await request(app)
      .post("/stats")
      .set("X-Org-Id", "org_test")
      .send({ featureDynastySlug: "nonexistent", groupBy: "featureDynastySlug" })
      .expect(200);

    expect(res.body.grouped).toEqual([]);
  });
});
