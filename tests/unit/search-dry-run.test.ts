import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * Tests for POST /search/dry-run — cheap filter test path.
 *
 * Asserts:
 * - Valid filters: 200, {totalEntries, validationErrors:[]}, Apollo per_page=1
 * - Invalid filter shape: 400, validationErrors populated
 * - Missing identity headers: 400
 * - Zero DB writes (no apolloPeopleSearches/apolloPeopleEnrichments inserts)
 * - Zero runs-service writes (no createRun/updateRun/addCosts)
 */

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
    if (req.headers["x-org-id"]) req.orgId = req.headers["x-org-id"];
    if (req.headers["x-user-id"]) req.userId = req.headers["x-user-id"];
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

const mockDbInsert = vi.fn();
const mockDbUpdate = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: (...args: unknown[]) => {
      mockDbInsert(...args);
      return {
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "should-not-happen" }]),
        }),
      };
    },
    update: (...args: unknown[]) => {
      mockDbUpdate(...args);
      return {
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      };
    },
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
  apolloPeopleEnrichments: { id: { name: "id" } },
  apolloSearchCursors: { id: { name: "id" } },
}));

const mockDecryptKey = vi.fn();
vi.mock("../../src/lib/keys-client.js", () => ({
  decryptKey: (...args: unknown[]) => mockDecryptKey(...args),
}));

vi.mock("../../src/lib/billing-client.js", () => ({
  authorizeCredit: vi.fn(),
}));

const mockSearchPeople = vi.fn();
vi.mock("../../src/lib/apollo-client.js", () => ({
  searchPeople: (...args: unknown[]) => mockSearchPeople(...args),
  enrichPerson: vi.fn(),
  buildWaterfallWebhookUrl: () => undefined,
}));

const HEADERS = {
  "X-Org-Id": "org-1",
  "X-User-Id": "user-1",
};

function createApp() {
  const app = express();
  app.use(express.json());
  return app;
}

describe("POST /search/dry-run", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDecryptKey.mockResolvedValue({ key: "fake-apollo-key", keySource: "platform" });
    mockSearchPeople.mockResolvedValue({ total_entries: 1234, people: [] });

    app = createApp();
    const { default: searchRoutes } = await import("../../src/routes/search.js");
    app.use(searchRoutes);
  });

  it("returns totalEntries with empty validationErrors for valid filters", async () => {
    const res = await request(app)
      .post("/search/dry-run")
      .set(HEADERS)
      .send({ personTitles: ["CEO", "CTO"] })
      .expect(200);

    expect(res.body).toEqual({ totalEntries: 1234, validationErrors: [] });
  });

  it("calls Apollo with per_page=1 to keep the dry-run cheap", async () => {
    await request(app)
      .post("/search/dry-run")
      .set(HEADERS)
      .send({ personTitles: ["CEO"] })
      .expect(200);

    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
    expect(mockSearchPeople).toHaveBeenCalledWith(
      "fake-apollo-key",
      expect.objectContaining({ page: 1, per_page: 1 })
    );
  });

  it("performs ZERO DB writes", async () => {
    await request(app)
      .post("/search/dry-run")
      .set(HEADERS)
      .send({ personTitles: ["CEO"] })
      .expect(200);

    expect(mockDbInsert).not.toHaveBeenCalled();
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it("performs ZERO runs-service writes", async () => {
    await request(app)
      .post("/search/dry-run")
      .set(HEADERS)
      .send({ personTitles: ["CEO"] })
      .expect(200);

    expect(mockCreateRun).not.toHaveBeenCalled();
    expect(mockUpdateRun).not.toHaveBeenCalled();
    expect(mockAddCosts).not.toHaveBeenCalled();
  });

  it("returns 400 with validationErrors populated when filter shape is invalid", async () => {
    const res = await request(app)
      .post("/search/dry-run")
      .set(HEADERS)
      .send({ personTitles: 123 }) // wrong type
      .expect(400);

    expect(res.body.totalEntries).toBe(0);
    expect(res.body.validationErrors).toBeInstanceOf(Array);
    expect(res.body.validationErrors.length).toBeGreaterThan(0);
    expect(res.body.validationErrors.join(" ")).toContain("personTitles");
    // No Apollo call when validation fails
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  it("returns 400 with validationErrors when an enum value is invalid", async () => {
    const res = await request(app)
      .post("/search/dry-run")
      .set(HEADERS)
      .send({ personSeniorities: ["god-emperor"] })
      .expect(400);

    expect(res.body.totalEntries).toBe(0);
    expect(res.body.validationErrors.length).toBeGreaterThan(0);
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  it("returns 400 when x-org-id header is missing", async () => {
    const res = await request(app)
      .post("/search/dry-run")
      .set("X-User-Id", "user-1")
      .send({ personTitles: ["CEO"] })
      .expect(400);

    expect(res.body.validationErrors).toBeInstanceOf(Array);
    expect(mockSearchPeople).not.toHaveBeenCalled();
  });

  it("propagates Apollo errors as 500", async () => {
    mockSearchPeople.mockRejectedValueOnce(new Error("Apollo 401: invalid api key"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app)
      .post("/search/dry-run")
      .set(HEADERS)
      .send({ personTitles: ["CEO"] })
      .expect(500);

    expect(res.body.error).toContain("Apollo 401: invalid api key");
    errorSpy.mockRestore();
  });
});
