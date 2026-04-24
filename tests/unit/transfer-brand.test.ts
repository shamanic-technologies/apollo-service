import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const mockExecute = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    execute: (...args: unknown[]) => mockExecute(...args),
  },
}));

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
    brandId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    sourceOrgId: "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
    targetOrgId: "c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue(rowList(0));
  });

  it("returns 400 when brandId is missing", async () => {
    const res = await request(createApp())
      .post("/internal/transfer-brand")
      .send({ sourceOrgId: validBody.sourceOrgId, targetOrgId: validBody.targetOrgId });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("returns 400 when brandId is not a valid UUID", async () => {
    const res = await request(createApp())
      .post("/internal/transfer-brand")
      .send({ ...validBody, brandId: "not-a-uuid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("returns 400 when sourceOrgId is missing", async () => {
    const res = await request(createApp())
      .post("/internal/transfer-brand")
      .send({ brandId: validBody.brandId, targetOrgId: validBody.targetOrgId });

    expect(res.status).toBe(400);
  });

  it("returns 400 when targetOrgId is missing", async () => {
    const res = await request(createApp())
      .post("/internal/transfer-brand")
      .send({ brandId: validBody.brandId, sourceOrgId: validBody.sourceOrgId });

    expect(res.status).toBe(400);
  });

  it("executes UPDATE for all 4 tables and returns counts", async () => {
    mockExecute
      .mockResolvedValueOnce(rowList(3))
      .mockResolvedValueOnce(rowList(10))
      .mockResolvedValueOnce(rowList(1))
      .mockResolvedValueOnce(rowList(0));

    const res = await request(createApp())
      .post("/internal/transfer-brand")
      .send(validBody);

    expect(res.status).toBe(200);
    expect(mockExecute).toHaveBeenCalledTimes(4);
    expect(res.body.updatedTables).toEqual([
      { tableName: "apollo_people_searches", count: 3 },
      { tableName: "apollo_people_enrichments", count: 10 },
      { tableName: "apollo_search_cursors", count: 1 },
      { tableName: "apollo_search_params_cache", count: 0 },
    ]);
  });

  it("is idempotent — returns 0 counts when already transferred", async () => {
    mockExecute.mockResolvedValue(rowList(0));

    const res = await request(createApp())
      .post("/internal/transfer-brand")
      .send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.updatedTables.every((t: { count: number }) => t.count === 0)).toBe(true);
  });

  it("returns 500 when db fails", async () => {
    mockExecute.mockRejectedValueOnce(new Error("connection refused"));

    const res = await request(createApp())
      .post("/internal/transfer-brand")
      .send(validBody);

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
  });
});
