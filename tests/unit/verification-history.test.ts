import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const mockExecute = vi.fn();
vi.mock("../../src/db/index.js", () => ({
  db: { execute: (...args: unknown[]) => mockExecute(...args) },
}));

const KEY = "unit-test-apollo-key";
process.env.APOLLO_SERVICE_API_KEY = KEY;

import historyRoutes from "../../src/routes/verification-history.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(historyRoutes);
  return app;
}

function row(seq: number, verdict: string | null) {
  return {
    seq: String(seq), // postgres-js returns bigint as a string
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    email: `p${seq}@acme.com`,
    verifier: "bounceverify",
    verdict,
    verified_at: new Date(Date.UTC(2026, 9, 1, 0, 0, seq)),
  };
}

/** Flattens a drizzle sql`` object into its text + params for assertions. */
function sqlText(q: unknown): { text: string; params: unknown[] } {
  const chunks = (q as { queryChunks: unknown[] }).queryChunks;
  let text = "";
  const params: unknown[] = [];
  for (const c of chunks) {
    if (c && typeof c === "object" && "value" in (c as object) && Array.isArray((c as { value: unknown }).value)) {
      text += ((c as { value: string[] }).value).join("");
    } else {
      text += "$";
      params.push(c);
    }
  }
  return { text, params };
}

const URL = "/internal/email-verifications/history";

describe("GET /internal/email-verifications/history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue([]);
  });

  it("401 without the service key", async () => {
    const res = await request(createApp()).get(URL);
    expect(res.status).toBe(401);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("400 on a non-numeric cursor or a limit over 5000", async () => {
    expect((await request(createApp()).get(URL).query({ after: "abc" }).set("x-api-key", KEY)).status).toBe(400);
    expect((await request(createApp()).get(URL).query({ limit: "5001" }).set("x-api-key", KEY)).status).toBe(400);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("starts from 0, maps rows, keeps a failed call as verdict null", async () => {
    mockExecute.mockResolvedValue([row(1, "valid"), row(2, null), row(3, "catch_all")]);
    const res = await request(createApp()).get(URL).set("x-api-key", KEY);
    expect(res.status).toBe(200);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.nextCursor).toBe("3");
    expect(res.body.verifications).toEqual([
      { id: row(1, null).id, email: "p1@acme.com", verifier: "bounceverify", verdict: "valid", verifiedAt: "2026-10-01T00:00:01.000Z", cursor: "1" },
      { id: row(2, null).id, email: "p2@acme.com", verifier: "bounceverify", verdict: null, verifiedAt: "2026-10-01T00:00:02.000Z", cursor: "2" },
      { id: row(3, null).id, email: "p3@acme.com", verifier: "bounceverify", verdict: "catch_all", verifiedAt: "2026-10-01T00:00:03.000Z", cursor: "3" },
    ]);
    const { params } = sqlText(mockExecute.mock.calls[0][0]);
    expect(params).toContain("0");
    expect(params).toContain(1001); // default 1000, +1 to detect hasMore
  });

  it("asks for limit+1 rows, serves limit, and says hasMore", async () => {
    mockExecute.mockResolvedValue([row(11, "valid"), row(12, "invalid"), row(13, "risky")]);
    const res = await request(createApp()).get(URL).query({ after: "10", limit: "2" }).set("x-api-key", KEY);
    expect(res.status).toBe(200);
    expect(res.body.verifications.map((v: { cursor: string }) => v.cursor)).toEqual(["11", "12"]);
    expect(res.body.nextCursor).toBe("12");
    expect(res.body.hasMore).toBe(true);
    const { params } = sqlText(mockExecute.mock.calls[0][0]);
    expect(params).toContain("10");
    expect(params).toContain(3);
  });

  it("an empty page keeps the caller's cursor", async () => {
    const res = await request(createApp()).get(URL).query({ after: "42" }).set("x-api-key", KEY);
    expect(res.body).toEqual({ verifications: [], nextCursor: "42", hasMore: false });
  });

  it("pages on the insertion key and stops before the first unsettled row (no row skipped)", async () => {
    await request(createApp()).get(URL).set("x-api-key", KEY);
    const { text } = sqlText(mockExecute.mock.calls[0][0]);
    expect(text).toMatch(/ORDER BY seq ASC/);
    expect(text).toMatch(/seq < COALESCE\(\s*\(SELECT min\(f\.seq\)/);
    expect(text).toMatch(/f\.verified_at >= now\(\)/);
    expect(text).not.toMatch(/ORDER BY verified_at/);
  });

  it("500 when the read fails", async () => {
    mockExecute.mockRejectedValue(new Error("db down"));
    const res = await request(createApp()).get(URL).set("x-api-key", KEY);
    expect(res.status).toBe(500);
  });
});
