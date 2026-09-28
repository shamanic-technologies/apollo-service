import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

/**
 * GET /audiences/:id/preview — a free, read-only sample of a persisted audience.
 * Apollo (searchPeople) and key-service are mocked; the db mock records every
 * write so the test can assert there are none.
 */

const state: { selectRow: any; writes: string[] } = { selectRow: undefined, writes: [] };

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: () => {
      state.writes.push("insert");
      return { values: () => ({ returning: async () => [] }) };
    },
    update: () => {
      state.writes.push("update");
      return { set: () => ({ where: async () => undefined }) };
    },
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (state.selectRow ? [state.selectRow] : []) }),
      }),
    }),
  },
}));

vi.mock("../../src/db/schema.js", () => ({
  apolloAudiences: { id: { name: "id" }, orgId: { name: "org_id" } },
}));

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, res: any, next: any) => {
    if (!req.headers["x-org-id"]) return res.status(400).json({ type: "validation", error: "x-org-id header required" });
    if (!req.headers["x-user-id"]) return res.status(400).json({ type: "validation", error: "x-user-id header required" });
    req.orgId = req.headers["x-org-id"];
    req.userId = req.headers["x-user-id"];
    next();
  },
  orgAuth: (req: any, _res: any, next: any) => {
    req.orgId = req.headers["x-org-id"];
    next();
  },
}));

const mockDecryptKey = vi.fn();
vi.mock("../../src/lib/keys-client.js", () => ({
  decryptKey: (...a: unknown[]) => mockDecryptKey(...a),
}));

const mockSearchPeople = vi.fn();
vi.mock("../../src/lib/apollo-client.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  searchPeople: (...a: unknown[]) => mockSearchPeople(...a),
}));

const { default: audienceRoutes } = await import("../../src/routes/audiences.js");
const { buildPreview, PREVIEW_MAX_COMPANIES, PREVIEW_MAX_PEOPLE } = await import("../../src/lib/audience-preview.js");

const app = express();
app.use(express.json());
app.use(audienceRoutes);

const HEADERS = { "X-Org-Id": "org-1", "X-User-Id": "user-1" };
const ROW = {
  id: "11111111-1111-1111-1111-111111111111",
  orgId: "org-1",
  brandId: "brand-1",
  filters: { person_titles: ["Owner"], organization_locations: ["United Kingdom"] },
  count: 270,
};

/** Exactly what Apollo's free teaser serves (verified live 2026-09-28). */
const teaser = (first: string, last: string, title: string, company: string | null) => ({
  id: `id-${first}`,
  first_name: first,
  last_name_obfuscated: last,
  title,
  has_email: true,
  has_city: true,
  organization: company ? { name: company, has_industry: true } : undefined,
});

beforeEach(() => {
  state.selectRow = { ...ROW };
  state.writes = [];
  mockDecryptKey.mockReset().mockResolvedValue({ key: "apollo-key", keySource: "platform" });
  mockSearchPeople.mockReset();
});

describe("GET /audiences/:id/preview", () => {
  it("returns real employers and people from ONE free teaser call, with no email and no writes", async () => {
    mockSearchPeople.mockResolvedValue({
      total_entries: 270,
      people: [
        teaser("Melissa", "Ni***s", "Co Founder", "Experience Travel Group"),
        teaser("Tom", "Sm***h", "Owner", "Experience Travel Group"),
        teaser("Ana", "Li***a", "Managing Director", "Inside Asia Tours"),
      ],
    });

    const res = await request(app).get(`/audiences/${ROW.id}/preview`).set(HEADERS).expect(200);

    expect(res.body).toEqual({
      apolloAudienceId: ROW.id,
      count: 270,
      companies: [
        { name: "Experience Travel Group", peopleInSample: 2 },
        { name: "Inside Asia Tours", peopleInSample: 1 },
      ],
      people: [
        { apolloPersonId: "id-Melissa", firstName: "Melissa", lastNameObfuscated: "Ni***s", title: "Co Founder", company: "Experience Travel Group" },
        { apolloPersonId: "id-Ana", firstName: "Ana", lastNameObfuscated: "Li***a", title: "Managing Director", company: "Inside Asia Tours" },
        { apolloPersonId: "id-Tom", firstName: "Tom", lastNameObfuscated: "Sm***h", title: "Owner", company: "Experience Travel Group" },
      ],
    });

    // One people-search, page 1, over the stored filters (Apollo-native params).
    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
    const [key, params] = mockSearchPeople.mock.calls[0];
    expect(key).toBe("apollo-key");
    expect(params).toMatchObject({ page: 1, per_page: 100, person_titles: ["Owner"], organization_locations: ["United Kingdom"] });

    // Read-only: no row inserted / updated (no cursor, no count refresh).
    expect(state.writes).toEqual([]);
    expect(JSON.stringify(res.body)).not.toMatch(/email|phone/i);
  });

  it("each person carries the teaser's Apollo id as `apolloPersonId` — the handle POST /enrich accepts", async () => {
    mockSearchPeople.mockResolvedValue({
      total_entries: 2,
      people: [teaser("Melissa", "Ni***s", "Co Founder", "Acme"), { ...teaser("Tom", "Sm***h", "Owner", "Acme"), id: undefined }],
    });
    const res = await request(app).get(`/audiences/${ROW.id}/preview`).set(HEADERS).expect(200);
    expect(res.body.people.map((p: any) => p.apolloPersonId)).toEqual(["id-Melissa", null]);
    // Still one free search, still no write: the handle rides the same teaser page.
    expect(mockSearchPeople).toHaveBeenCalledTimes(1);
    expect(state.writes).toEqual([]);
  });

  it("an audience with no match answers an empty sample, not an error", async () => {
    mockSearchPeople.mockResolvedValue({ total_entries: 0, people: [] });
    const res = await request(app).get(`/audiences/${ROW.id}/preview`).set(HEADERS).expect(200);
    expect(res.body).toEqual({ apolloAudienceId: ROW.id, count: 0, companies: [], people: [] });
  });

  it("404 for an unknown / another org's audience, before any Apollo call", async () => {
    state.selectRow = null;
    await request(app).get(`/audiences/${ROW.id}/preview`).set(HEADERS).expect(404);
    expect(mockSearchPeople).not.toHaveBeenCalled();
    expect(mockDecryptKey).not.toHaveBeenCalled();
  });

  it("400 without x-user-id (key resolution needs it); x-run-id is not required", async () => {
    await request(app).get(`/audiences/${ROW.id}/preview`).set({ "X-Org-Id": "org-1" }).expect(400);
  });

  it("an Apollo failure surfaces as 500, never an invented sample", async () => {
    mockSearchPeople.mockRejectedValue(new Error("Apollo search failed: 500 - boom"));
    const res = await request(app).get(`/audiences/${ROW.id}/preview`).set(HEADERS).expect(500);
    expect(res.body.error).toContain("Apollo search failed");
  });
});

describe("buildPreview", () => {
  it("caps companies at 10 and people at 20, round-robin across employers", () => {
    const raw: any[] = [];
    // Big Co holds 30 rows first, then 15 other employers with one row each.
    for (let i = 0; i < 30; i++) raw.push(teaser(`Big${i}`, "X***", "Owner", "Big Co"));
    for (let i = 0; i < 15; i++) raw.push(teaser(`S${i}`, "Y***", "Founder", `Small ${i}`));
    const p = buildPreview(5000, raw);
    expect(p.companies).toHaveLength(PREVIEW_MAX_COMPANIES);
    expect(p.companies[0]).toEqual({ name: "Big Co", peopleInSample: 30 });
    expect(p.people).toHaveLength(PREVIEW_MAX_PEOPLE);
    // Every person works at a LISTED company, and the first pass is one per company.
    const listed = new Set(p.companies.map((c) => c.name));
    expect(p.people.every((x) => listed.has(x.company!))).toBe(true);
    expect(new Set(p.people.slice(0, PREVIEW_MAX_COMPANIES).map((x) => x.company)).size).toBe(PREVIEW_MAX_COMPANIES);
  });

  it("groups employers case-insensitively and skips rows with no employer", () => {
    const p = buildPreview(3, [
      teaser("A", "a***", "Owner", "Acme"),
      teaser("B", "b***", "Owner", "ACME"),
      teaser("C", "c***", "Owner", null),
    ]);
    expect(p.companies).toEqual([{ name: "Acme", peopleInSample: 2 }]);
    expect(p.people.map((x) => x.firstName)).toEqual(["A", "B"]);
  });
});
