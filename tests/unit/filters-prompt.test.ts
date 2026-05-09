import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { z } from "zod";
import {
  buildFiltersPrompt,
  computeFiltersPromptVersion,
} from "../../src/lib/filters-prompt.js";
import { SearchFiltersSchema } from "../../src/schemas.js";

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    if (req.headers["x-org-id"]) req.orgId = req.headers["x-org-id"];
    if (req.headers["x-user-id"]) req.userId = req.headers["x-user-id"];
    if (!req.orgId) return _res.status(400).json({ type: "validation", error: "x-org-id header required" });
    if (!req.userId) return _res.status(400).json({ type: "validation", error: "x-user-id header required" });
    next();
  },
}));

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: vi.fn(),
    update: vi.fn(),
    select: vi.fn(),
    query: {
      apolloPeopleSearches: { findMany: vi.fn() },
      apolloPeopleEnrichments: { findMany: vi.fn() },
    },
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  apolloPeopleSearches: { id: { name: "id" } },
  apolloPeopleEnrichments: { id: { name: "id" } },
  apolloSearchCursors: { id: { name: "id" } },
}));

vi.mock("../../src/lib/keys-client.js", () => ({ decryptKey: vi.fn() }));
vi.mock("../../src/lib/billing-client.js", () => ({ authorizeCredit: vi.fn() }));
vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn(), updateRun: vi.fn(), addCosts: vi.fn(),
}));
vi.mock("../../src/lib/apollo-client.js", () => ({
  searchPeople: vi.fn(), enrichPerson: vi.fn(), buildWaterfallWebhookUrl: vi.fn(),
}));

const HEADERS = { "X-Org-Id": "org-1", "X-User-Id": "user-1" };

describe("buildFiltersPrompt(SearchFiltersSchema)", () => {
  const prompt = buildFiltersPrompt(SearchFiltersSchema);

  it("renders qKeywords as string (NOT string[])", () => {
    expect(prompt).toMatch(/^- qKeywords: string$/m);
    expect(prompt).not.toMatch(/^- qKeywords: string\[\]$/m);
  });

  it("renders qKeywords example as OR-joined free text", () => {
    // Match the example line under qKeywords
    const block = prompt.split(/\n(?=- )/).find((b) => b.startsWith("- qKeywords:"));
    expect(block).toBeDefined();
    expect(block).toMatch(/ex:\s*"[^"]*\bOR\b[^"]*"/);
  });

  it("renders personSeniorities as string[] with full enum list", () => {
    const block = prompt.split(/\n(?=- )/).find((b) => b.startsWith("- personSeniorities:"));
    expect(block).toMatch(/^- personSeniorities: string\[\]$/m);
    expect(block).toMatch(
      /enum: entry \| senior \| manager \| director \| vp \| c_suite \| owner \| founder \| partner/
    );
  });

  it("renders contactEmailStatus enum line with all four values", () => {
    const block = prompt.split(/\n(?=- )/).find((b) => b.startsWith("- contactEmailStatus:"));
    expect(block).toMatch(/enum: verified \| unverified \| likely to engage \| unavailable/);
  });

  it("renders organizationNumEmployeesRanges enum line with all 11 ranges", () => {
    const block = prompt.split(/\n(?=- )/).find((b) => b.startsWith("- organizationNumEmployeesRanges:"));
    expect(block).toMatch(/enum: 1,10 \| 11,20 \| 21,50 \| 51,100 \| 101,200 \| 201,500 \| 501,1000 \| 1001,2000 \| 2001,5000 \| 5001,10000 \| 10001,/);
  });

  it("does NOT render an enum line for plain string[] fields like personTitles", () => {
    const block = prompt.split(/\n(?=- )/).find((b) => b.startsWith("- personTitles:"));
    expect(block).toBeDefined();
    expect(block).not.toMatch(/enum:/);
  });

  it("contains every field from SearchFiltersSchema", () => {
    for (const fieldName of Object.keys(SearchFiltersSchema.shape)) {
      expect(prompt).toMatch(new RegExp(`^- ${fieldName}:`, "m"));
    }
  });

  it("includes description and ex line for every field", () => {
    for (const fieldName of Object.keys(SearchFiltersSchema.shape)) {
      const blocks = prompt.split(/\n(?=- )/).filter((b) => b.startsWith(`- ${fieldName}:`));
      expect(blocks.length).toBe(1);
      expect(blocks[0]).toMatch(/^\s+ex:/m);
    }
  });
});

describe("buildFiltersPrompt — fail-loud on missing metadata", () => {
  it("throws when a field is missing description metadata", () => {
    const Bad = z.object({
      lonely: z.array(z.string()).optional(),
    });
    expect(() => buildFiltersPrompt(Bad)).toThrow(/lonely/);
  });

  it("throws when a field has description but no example", () => {
    const Bad = z.object({
      almost: z.array(z.string()).optional().openapi({ description: "hi" }),
    });
    expect(() => buildFiltersPrompt(Bad)).toThrow(/almost/);
  });
});

describe("computeFiltersPromptVersion", () => {
  it("is deterministic for the same input string", () => {
    const a = computeFiltersPromptVersion("hello world");
    const b = computeFiltersPromptVersion("hello world");
    expect(a).toBe(b);
    expect(a).toHaveLength(12);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  it("differs when input differs", () => {
    expect(computeFiltersPromptVersion("a")).not.toBe(computeFiltersPromptVersion("b"));
  });
});

describe("GET /search/filters-prompt", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = express();
    app.use(express.json());
    const { default: searchRoutes } = await import("../../src/routes/search.js");
    app.use(searchRoutes);
  });

  it("returns 200 with {prompt, schemaVersion} both non-empty", async () => {
    const res = await request(app)
      .get("/search/filters-prompt")
      .set(HEADERS)
      .expect(200);

    expect(typeof res.body.prompt).toBe("string");
    expect(res.body.prompt.length).toBeGreaterThan(0);
    expect(typeof res.body.schemaVersion).toBe("string");
    expect(res.body.schemaVersion).toMatch(/^[0-9a-f]{12}$/);
  });

  it("response prompt contains qKeywords as string and full seniority enum", async () => {
    const res = await request(app)
      .get("/search/filters-prompt")
      .set(HEADERS)
      .expect(200);

    expect(res.body.prompt).toMatch(/^- qKeywords: string$/m);
    expect(res.body.prompt).toMatch(
      /enum: entry \| senior \| manager \| director \| vp \| c_suite \| owner \| founder \| partner/
    );
  });

  it("schemaVersion stable across requests (same content → same hash)", async () => {
    const a = await request(app).get("/search/filters-prompt").set(HEADERS).expect(200);
    const b = await request(app).get("/search/filters-prompt").set(HEADERS).expect(200);
    expect(a.body.schemaVersion).toBe(b.body.schemaVersion);
  });

  it("returns 400 when x-org-id header is missing", async () => {
    await request(app)
      .get("/search/filters-prompt")
      .set("X-User-Id", "user-1")
      .expect(400);
  });
});
