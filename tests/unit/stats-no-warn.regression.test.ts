import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Regression test: POST /stats should not emit console.warn when
 * searches exist but enrichments are 0.
 *
 * This is a normal workflow state (e.g. /search/next doesn't store
 * enrichment records, or stats is queried between search and enrich phases).
 * The previous console.warn rendered as red in Railway logs, making it
 * look like an error.
 */

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn().mockResolvedValue({ id: "run-1" }),
  updateRun: vi.fn().mockResolvedValue({}),
  addCosts: vi.fn().mockResolvedValue({ costs: [] }),
}));

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = "org-internal-123";
    req.clerkOrgId = req.headers["x-clerk-org-id"] || "org_test";
    next();
  },
}));

// Stats makes two db.select() calls:
// 1st: enrichment count → { enrichedLeadsCount: 0 }
// 2nd: search stats → { searchCount: 3, fetchedPeopleCount: "75", totalMatchingPeople: "500" }
let selectCallCount = 0;

const enrichmentResult = [{ enrichedLeadsCount: 0 }];
const searchResult = [{ searchCount: 3, fetchedPeopleCount: "75", totalMatchingPeople: "500" }];

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: vi.fn().mockImplementation(() => {
      const callIndex = selectCallCount++;
      const result = callIndex % 2 === 0 ? enrichmentResult : searchResult;
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(result),
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
    appId: "appId",
    brandId: "brandId",
    campaignId: "campaignId",
    peopleCount: "peopleCount",
    totalEntries: "totalEntries",
  },
  apolloPeopleEnrichments: {
    orgId: "orgId",
    runId: "runId",
    appId: "appId",
    brandId: "brandId",
    campaignId: "campaignId",
    apolloPersonId: "apolloPersonId",
    email: "email",
    emailStatus: "emailStatus",
    createdAt: "createdAt",
  },
}));

vi.mock("../../src/lib/keys-client.js", () => ({
  getByokKey: vi.fn().mockResolvedValue("fake-apollo-key"),
}));

vi.mock("../../src/lib/apollo-client.js", () => ({
  searchPeople: vi.fn().mockResolvedValue({ people: [], total_entries: 0 }),
  enrichPerson: vi.fn().mockResolvedValue({ person: null }),
}));

describe("POST /stats - no spurious warnings", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    selectCallCount = 0;

    app = express();
    app.use(express.json());
    const { default: searchRoutes } = await import("../../src/routes/search.js");
    app.use(searchRoutes);
  });

  it("should NOT emit console.warn when searches > 0 but enrichments === 0", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await request(app)
      .post("/stats")
      .set("X-API-Key", "test-service-secret")
      .set("X-Clerk-Org-Id", "org_test")
      .send({ campaignId: "campaign-1" })
      .expect(200);

    expect(res.body.stats).toEqual({
      enrichedLeadsCount: 0,
      searchCount: 3,
      fetchedPeopleCount: 75,
      totalMatchingPeople: 500,
    });

    // The regression: console.warn should NOT be called for this normal state
    const statsWarns = warnSpy.mock.calls.filter(([msg]) =>
      typeof msg === "string" && msg.includes("[POST /stats]")
    );
    expect(statsWarns).toHaveLength(0);

    warnSpy.mockRestore();
  });

  it("should return correct stats when both searches and enrichments exist", async () => {
    // Override for this test: enrichments > 0
    selectCallCount = 0;
    const { db } = await import("../../src/db/index.js");
    const selectMock = vi.mocked(db.select);

    selectMock
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ enrichedLeadsCount: 10 }]),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ searchCount: 2, fetchedPeopleCount: "50", totalMatchingPeople: "200" }]),
        }),
      } as any);

    const res = await request(app)
      .post("/stats")
      .set("X-API-Key", "test-service-secret")
      .set("X-Clerk-Org-Id", "org_test")
      .send({ campaignId: "campaign-1" })
      .expect(200);

    expect(res.body.stats).toEqual({
      enrichedLeadsCount: 10,
      searchCount: 2,
      fetchedPeopleCount: 50,
      totalMatchingPeople: 200,
    });
  });
});
