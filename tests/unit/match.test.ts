import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Tests for POST /match and POST /match/bulk endpoints.
 *
 * Covers: validation, cache hits/misses, cost tracking, error handling.
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockCreateRun = vi.fn();
const mockUpdateRun = vi.fn().mockResolvedValue({});
const mockAddCosts = vi.fn().mockResolvedValue({ costs: [] });

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: (...args: unknown[]) => mockCreateRun(...args),
  updateRun: (...args: unknown[]) => mockUpdateRun(...args),
  addCosts: (...args: unknown[]) => mockAddCosts(...args),
}));

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    req.orgId = "org-internal-123";
    req.clerkOrgId = req.headers["x-clerk-org-id"] || "org_test";
    next();
  },
}));

const mockInsertReturning = vi.fn().mockResolvedValue([{ id: "record-1" }]);
vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: (...args: unknown[]) => mockInsertReturning(...args),
      }),
    }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }),
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  apolloPeopleEnrichments: {
    id: { name: "id" },
    firstName: { name: "first_name" },
    lastName: { name: "last_name" },
    organizationDomain: { name: "organization_domain" },
    email: { name: "email" },
    createdAt: { name: "created_at" },
    apolloPersonId: { name: "apollo_person_id" },
  },
}));

const mockGetByokKey = vi.fn().mockResolvedValue("fake-apollo-key");
vi.mock("../../src/lib/keys-client.js", () => ({
  getByokKey: (...args: unknown[]) => mockGetByokKey(...args),
}));

const MOCK_PERSON = {
  id: "person-match-1",
  first_name: "John",
  last_name: "Doe",
  name: "John Doe",
  email: "john@acme.com",
  email_status: "verified",
  title: "CTO",
  linkedin_url: "https://linkedin.com/in/johndoe",
  photo_url: "https://img.apollo.io/johndoe.jpg",
  headline: "CTO at Acme",
  seniority: "c_suite",
  organization: {
    id: "org-acme",
    name: "Acme Inc",
    website_url: "https://acme.com",
    primary_domain: "acme.com",
    industry: "tech",
    estimated_num_employees: 200,
    annual_revenue: null,
  },
};

const mockMatchPersonByName = vi.fn().mockResolvedValue({ person: MOCK_PERSON });
const mockBulkMatchPeopleByName = vi.fn().mockResolvedValue({ matches: [MOCK_PERSON] });

vi.mock("../../src/lib/apollo-client.js", () => ({
  matchPersonByName: (...args: unknown[]) => mockMatchPersonByName(...args),
  bulkMatchPeopleByName: (...args: unknown[]) => mockBulkMatchPeopleByName(...args),
}));

function createTestApp() {
  const app = express();
  app.use(express.json());
  return app;
}

const BASE_BODY = {
  runId: "run-abc",
  appId: "app-1",
  brandId: "brand-1",
  campaignId: "campaign-1",
};

// ─── POST /match ────────────────────────────────────────────────────────────

describe("POST /match", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockUpdateRun.mockResolvedValue({});
    mockAddCosts.mockResolvedValue({ costs: [] });
    mockInsertReturning.mockResolvedValue([{ id: "record-1" }]);
    mockMatchPersonByName.mockResolvedValue({ person: MOCK_PERSON });

    let callCount = 0;
    mockCreateRun.mockImplementation(() => {
      callCount++;
      return Promise.resolve({ id: `run-${callCount}` });
    });

    app = createTestApp();
    const { default: matchRoutes } = await import("../../src/routes/match.js");
    app.use(matchRoutes);
  });

  // ─── Validation ──────────────────────────────────────────────────────────

  it("should return 400 when firstName is missing", async () => {
    const res = await request(app)
      .post("/match")
      .set("X-Clerk-Org-Id", "org_test")
      .send({ lastName: "Doe", organizationDomain: "acme.com", ...BASE_BODY })
      .expect(400);

    expect(res.body.error).toBe("Invalid request");
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it("should return 400 when runId is missing", async () => {
    await request(app)
      .post("/match")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        firstName: "John",
        lastName: "Doe",
        organizationDomain: "acme.com",
        appId: "app-1",
        brandId: "brand-1",
        campaignId: "campaign-1",
      })
      .expect(400);
  });

  // ─── Cache miss happy path ────────────────────────────────────────────────

  it("should call Apollo and return person on cache miss", async () => {
    const res = await request(app)
      .post("/match")
      .set("X-Clerk-Org-Id", "org_test")
      .send({ firstName: "John", lastName: "Doe", organizationDomain: "acme.com", ...BASE_BODY })
      .expect(200);

    expect(mockMatchPersonByName).toHaveBeenCalledWith("fake-apollo-key", "John", "Doe", "acme.com");
    expect(res.body.person).toBeDefined();
    expect(res.body.person.firstName).toBe("John");
    expect(res.body.person.email).toBe("john@acme.com");
    expect(res.body.cached).toBe(false);
    expect(res.body.enrichmentId).toBe("record-1");
  });

  // ─── Cost tracking ───────────────────────────────────────────────────────

  it("should charge apollo-person-match-credit when email is found", async () => {
    await request(app)
      .post("/match")
      .set("X-Clerk-Org-Id", "org_test")
      .send({ firstName: "John", lastName: "Doe", organizationDomain: "acme.com", ...BASE_BODY })
      .expect(200);

    const matchCalls = mockAddCosts.mock.calls.filter(([, items]) =>
      items.some((i: { costName: string }) => i.costName === "apollo-person-match-credit")
    );
    expect(matchCalls).toHaveLength(1);
    expect(matchCalls[0][1][0].quantity).toBe(1);
  });

  it("should NOT charge when person has no email", async () => {
    mockMatchPersonByName.mockResolvedValueOnce({
      person: { ...MOCK_PERSON, email: null, email_status: null },
    });

    await request(app)
      .post("/match")
      .set("X-Clerk-Org-Id", "org_test")
      .send({ firstName: "John", lastName: "Doe", organizationDomain: "acme.com", ...BASE_BODY })
      .expect(200);

    expect(mockAddCosts).not.toHaveBeenCalled();
  });

  it("should NOT charge when Apollo returns no match", async () => {
    mockMatchPersonByName.mockResolvedValueOnce({ person: null });

    const res = await request(app)
      .post("/match")
      .set("X-Clerk-Org-Id", "org_test")
      .send({ firstName: "Nobody", lastName: "Exists", organizationDomain: "none.com", ...BASE_BODY })
      .expect(200);

    expect(res.body.person).toBeNull();
    expect(res.body.enrichmentId).toBeNull();
    expect(res.body.cached).toBe(false);
    expect(mockAddCosts).not.toHaveBeenCalled();
  });

  // ─── Cache hit ────────────────────────────────────────────────────────────

  it("should return cached result and skip Apollo on cache hit", async () => {
    const { db } = await import("../../src/db/index.js");
    const selectMock = vi.mocked(db.select);
    selectMock.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: "cached-1",
              apolloPersonId: "person-match-1",
              firstName: "John",
              lastName: "Doe",
              email: "john@acme.com",
              emailStatus: "verified",
              title: "CTO",
              linkedinUrl: "https://linkedin.com/in/johndoe",
              organizationName: "Acme Inc",
              organizationDomain: "acme.com",
              createdAt: new Date(),
            }]),
          }),
        }),
      }),
    } as any);

    const res = await request(app)
      .post("/match")
      .set("X-Clerk-Org-Id", "org_test")
      .send({ firstName: "John", lastName: "Doe", organizationDomain: "acme.com", ...BASE_BODY })
      .expect(200);

    expect(res.body.cached).toBe(true);
    expect(res.body.enrichmentId).toBeNull();
    expect(res.body.person.email).toBe("john@acme.com");
    expect(mockMatchPersonByName).not.toHaveBeenCalled();
    expect(mockAddCosts).not.toHaveBeenCalled();
  });

  // ─── workflowName propagation ─────────────────────────────────────────────

  it("should pass workflowName to createRun", async () => {
    await request(app)
      .post("/match")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        firstName: "John",
        lastName: "Doe",
        organizationDomain: "acme.com",
        ...BASE_BODY,
        workflowName: "fetch-lead",
      })
      .expect(200);

    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({ workflowName: "fetch-lead", taskName: "person-match" })
    );
  });

  // ─── Error handling ───────────────────────────────────────────────────────

  it("should return 500 when Apollo API fails", async () => {
    mockMatchPersonByName.mockRejectedValueOnce(new Error("Apollo match failed: 429"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app)
      .post("/match")
      .set("X-Clerk-Org-Id", "org_test")
      .send({ firstName: "John", lastName: "Doe", organizationDomain: "acme.com", ...BASE_BODY })
      .expect(500);

    expect(res.body.error).toContain("Apollo match failed: 429");
    errorSpy.mockRestore();
  });

  it("should return 500 when createRun fails", async () => {
    mockCreateRun.mockRejectedValue(new Error("runs-service down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await request(app)
      .post("/match")
      .set("X-Clerk-Org-Id", "org_test")
      .send({ firstName: "John", lastName: "Doe", organizationDomain: "acme.com", ...BASE_BODY })
      .expect(500);

    errorSpy.mockRestore();
  });
});

// ─── POST /match/bulk ───────────────────────────────────────────────────────

describe("POST /match/bulk", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockUpdateRun.mockResolvedValue({});
    mockAddCosts.mockResolvedValue({ costs: [] });
    mockInsertReturning.mockResolvedValue([{ id: "record-1" }]);
    mockBulkMatchPeopleByName.mockResolvedValue({ matches: [MOCK_PERSON] });

    let callCount = 0;
    mockCreateRun.mockImplementation(() => {
      callCount++;
      return Promise.resolve({ id: `run-${callCount}` });
    });

    app = createTestApp();
    const { default: matchRoutes } = await import("../../src/routes/match.js");
    app.use(matchRoutes);
  });

  // ─── Validation ──────────────────────────────────────────────────────────

  it("should return 400 when items array is empty", async () => {
    await request(app)
      .post("/match/bulk")
      .set("X-Clerk-Org-Id", "org_test")
      .send({ items: [], ...BASE_BODY })
      .expect(400);
  });

  it("should return 400 when items exceed max 10", async () => {
    const items = Array.from({ length: 11 }, (_, i) => ({
      firstName: `First${i}`,
      lastName: `Last${i}`,
      organizationDomain: `company${i}.com`,
    }));

    await request(app)
      .post("/match/bulk")
      .set("X-Clerk-Org-Id", "org_test")
      .send({ items, ...BASE_BODY })
      .expect(400);
  });

  // ─── Happy path ──────────────────────────────────────────────────────────

  it("should create a single run for the batch", async () => {
    mockBulkMatchPeopleByName.mockResolvedValueOnce({
      matches: [MOCK_PERSON, { ...MOCK_PERSON, id: "person-2", email: "p2@acme.com" }],
    });

    await request(app)
      .post("/match/bulk")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        items: [
          { firstName: "John", lastName: "Doe", organizationDomain: "acme.com" },
          { firstName: "Jane", lastName: "Smith", organizationDomain: "acme.com" },
        ],
        ...BASE_BODY,
      })
      .expect(200);

    expect(mockCreateRun).toHaveBeenCalledTimes(1);
    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({ taskName: "person-match-bulk" })
    );
  });

  it("should aggregate costs for items with emails", async () => {
    mockBulkMatchPeopleByName.mockResolvedValueOnce({
      matches: [
        MOCK_PERSON,
        { ...MOCK_PERSON, id: "p2", email: "p2@acme.com" },
        { ...MOCK_PERSON, id: "p3", email: null },
      ],
    });

    await request(app)
      .post("/match/bulk")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        items: [
          { firstName: "A", lastName: "B", organizationDomain: "acme.com" },
          { firstName: "C", lastName: "D", organizationDomain: "acme.com" },
          { firstName: "E", lastName: "F", organizationDomain: "acme.com" },
        ],
        ...BASE_BODY,
      })
      .expect(200);

    expect(mockAddCosts).toHaveBeenCalledTimes(1);
    expect(mockAddCosts).toHaveBeenCalledWith("run-1", [
      { costName: "apollo-person-match-credit", quantity: 2 },
    ]);
  });

  it("should return results in same order as input", async () => {
    mockBulkMatchPeopleByName.mockResolvedValueOnce({
      matches: [MOCK_PERSON, null],
    });

    const res = await request(app)
      .post("/match/bulk")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        items: [
          { firstName: "John", lastName: "Doe", organizationDomain: "acme.com" },
          { firstName: "Nobody", lastName: "Exists", organizationDomain: "none.com" },
        ],
        ...BASE_BODY,
      })
      .expect(200);

    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0].person).not.toBeNull();
    expect(res.body.results[0].person.firstName).toBe("John");
    expect(res.body.results[1].person).toBeNull();
  });

  it("should NOT call Apollo when all items are cached", async () => {
    const { db } = await import("../../src/db/index.js");
    const selectMock = vi.mocked(db.select);

    // Mock cache hit for the single item
    selectMock.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: "cached-1",
              apolloPersonId: "person-match-1",
              firstName: "John",
              lastName: "Doe",
              email: "john@acme.com",
              emailStatus: "verified",
              title: "CTO",
              organizationName: "Acme Inc",
              organizationDomain: "acme.com",
              createdAt: new Date(),
            }]),
          }),
        }),
      }),
    } as any);

    const res = await request(app)
      .post("/match/bulk")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        items: [{ firstName: "John", lastName: "Doe", organizationDomain: "acme.com" }],
        ...BASE_BODY,
      })
      .expect(200);

    expect(mockBulkMatchPeopleByName).not.toHaveBeenCalled();
    expect(res.body.results[0].cached).toBe(true);
    expect(mockAddCosts).not.toHaveBeenCalled();
  });

  it("should NOT add costs when no items have emails", async () => {
    mockBulkMatchPeopleByName.mockResolvedValueOnce({
      matches: [{ ...MOCK_PERSON, email: null }],
    });

    await request(app)
      .post("/match/bulk")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        items: [{ firstName: "A", lastName: "B", organizationDomain: "acme.com" }],
        ...BASE_BODY,
      })
      .expect(200);

    expect(mockAddCosts).not.toHaveBeenCalled();
  });

  // ─── Error handling ───────────────────────────────────────────────────────

  it("should return 500 when Apollo bulk API fails", async () => {
    mockBulkMatchPeopleByName.mockRejectedValueOnce(new Error("Apollo bulk match failed: 500"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await request(app)
      .post("/match/bulk")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        items: [{ firstName: "John", lastName: "Doe", organizationDomain: "acme.com" }],
        ...BASE_BODY,
      })
      .expect(500);

    errorSpy.mockRestore();
  });

  it("should pass workflowName to createRun", async () => {
    await request(app)
      .post("/match/bulk")
      .set("X-Clerk-Org-Id", "org_test")
      .send({
        items: [{ firstName: "John", lastName: "Doe", organizationDomain: "acme.com" }],
        ...BASE_BODY,
        workflowName: "fetch-lead",
      })
      .expect(200);

    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({ workflowName: "fetch-lead", taskName: "person-match-bulk" })
    );
  });
});
