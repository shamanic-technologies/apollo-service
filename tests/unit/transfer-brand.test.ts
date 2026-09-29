import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockExecute = vi.fn();
const mockTransaction = vi.fn(async (fn: (tx: unknown) => unknown) =>
  fn({ execute: (...args: unknown[]) => mockExecute(...args) })
);

vi.mock("../../src/db/index.js", () => ({
  db: {
    transaction: (fn: (tx: unknown) => unknown) => mockTransaction(fn),
  },
}));

const KEY = "unit-test-apollo-key";
process.env.APOLLO_SERVICE_API_KEY = KEY;

// ─── App setup ──────────────────────────────────────────────────────────────

import transferBrandRoutes from "../../src/routes/transfer-brand.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(transferBrandRoutes);
  return app;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Mimics postgres-js RowList with a `.count` property */
function rowList(count: number) {
  return Object.assign([], { count });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("POST /internal/transfer-brand", () => {
  const validBody = {
    sourceBrandId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    sourceOrgId: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
    targetOrgId: "c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue(rowList(0));
  });

  it("returns 400 when sourceBrandId is missing", async () => {
    const res = await request(createApp())
      .post("/internal/transfer-brand")
      .set("x-api-key", KEY)
      .send({ sourceOrgId: validBody.sourceOrgId, targetOrgId: validBody.targetOrgId });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("returns 400 when sourceBrandId is not a valid UUID", async () => {
    const res = await request(createApp())
      .post("/internal/transfer-brand")
      .set("x-api-key", KEY)
      .send({ ...validBody, sourceBrandId: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("returns 400 when sourceOrgId is missing", async () => {
    const res = await request(createApp())
      .post("/internal/transfer-brand")
      .set("x-api-key", KEY)
      .send({ sourceBrandId: validBody.sourceBrandId, targetOrgId: validBody.targetOrgId });

    expect(res.status).toBe(400);
  });

  it("returns 400 when targetOrgId is missing", async () => {
    const res = await request(createApp())
      .post("/internal/transfer-brand")
      .set("x-api-key", KEY)
      .send({ sourceBrandId: validBody.sourceBrandId, sourceOrgId: validBody.sourceOrgId });

    expect(res.status).toBe(400);
  });

  it("returns 400 when targetBrandId is not a valid UUID", async () => {
    const res = await request(createApp())
      .post("/internal/transfer-brand")
      .set("x-api-key", KEY)
      .send({ ...validBody, targetBrandId: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  const TABLES = [
    "email_verifications",
    "email_finder_calls",
    "quickenrich_searches",
    "apollo_phone_reveals",
    "email_findings",
    "reveal_skips",
    "cost_holds",
    "apollo_people_searches",
    "apollo_people_enrichments",
    "apollo_search_cursors",
    "apollo_audiences",
  ];

  /** Flattens a drizzle SQL object into its text, params inlined as $?. */
  function sqlText(q: { queryChunks: unknown[] }): string {
    return q.queryChunks
      .map((c: any) => {
        if (c && Array.isArray(c.value)) return c.value.join("");
        if (c && c.queryChunks) return sqlText(c);
        if (c && typeof c.value === "string" && c.constructor?.name === "Name") return `"${c.value}"`;
        return "$?";
      })
      .join("");
  }

  it("moves every table of the current schema, in one transaction, in dependency order", async () => {
    mockExecute.mockResolvedValue(rowList(2));

    const res = await request(createApp()).post("/internal/transfer-brand").set("x-api-key", KEY).send(validBody);

    expect(res.status).toBe(200);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledTimes(TABLES.length);
    expect(res.body.updatedTables).toEqual(TABLES.map((tableName) => ({ tableName, count: 2 })));
    const texts = mockExecute.mock.calls.map(([q]) => sqlText(q));
    TABLES.forEach((t, i) => {
      expect(texts[i]).toMatch(new RegExp(`^UPDATE "${t}" SET org_id = `));
    });
    // The dropped cache table must never be touched again (it 500'd the route).
    expect(texts.join("\n")).not.toContain("apollo_search_params_cache");
  });

  it("rewrites the brand when targetBrandId is present (move + catch-up rewrite per branded table)", async () => {
    mockExecute.mockResolvedValue(rowList(1));
    const targetBrandId = "d4e5f6a7-b8c9-4d0e-af1f-2a3b4c5d6e7f";

    const res = await request(createApp())
      .post("/internal/transfer-brand")
      .set("x-api-key", KEY)
      .send({ ...validBody, targetBrandId });

    expect(res.status).toBe(200);
    // 3 brandless tables: 1 query; 8 branded tables: 2 queries
    expect(mockExecute).toHaveBeenCalledTimes(3 + 8 * 2);
    const counts = Object.fromEntries(res.body.updatedTables.map((t: any) => [t.tableName, t.count]));
    expect(counts.email_verifications).toBe(1);
    expect(counts.apollo_people_enrichments).toBe(2);
    expect(counts.apollo_audiences).toBe(2);
  });

  it("returns 401 without the service api key and touches nothing", async () => {
    const res = await request(createApp()).post("/internal/transfer-brand").send(validBody);
    expect(res.status).toBe(401);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("returns 401 with a wrong service api key", async () => {
    const res = await request(createApp()).post("/internal/transfer-brand").set("x-api-key", "nope").send(validBody);
    expect(res.status).toBe(401);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("is idempotent — returns 0 counts when already transferred", async () => {
    mockExecute.mockResolvedValue(rowList(0));

    const res = await request(createApp())
      .post("/internal/transfer-brand")
      .set("x-api-key", KEY)
      .send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.updatedTables.every((t: { count: number }) => t.count === 0)).toBe(true);
  });

  it("returns 500 when db fails", async () => {
    mockExecute.mockRejectedValueOnce(new Error("connection refused"));

    const res = await request(createApp())
      .post("/internal/transfer-brand")
      .set("x-api-key", KEY)
      .send(validBody);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
  });
});
