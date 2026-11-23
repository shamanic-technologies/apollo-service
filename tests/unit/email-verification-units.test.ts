import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";

/** ENGINE-GET-ASK-1123: GET /email-verifications/units, the Provider read of outcome email_found. */

const mockExecute = vi.fn();
vi.mock("../../src/db/index.js", () => ({
  db: { execute: (...args: unknown[]) => mockExecute(...args) },
}));

const KEY = "unit-test-apollo-key";
process.env.APOLLO_SERVICE_API_KEY = KEY;

import unitRoutes from "../../src/routes/email-verification-units.js";
import { isDecisive, toUnit, type RawUnitRow } from "../../src/lib/email-verification-units.js";

const HEADERS = { "x-api-key": KEY, "x-org-id": "11111111-1111-4111-8111-111111111111", "x-user-id": "user-1", "x-run-id": "run-1" };
const ROUTE = "/email-verifications/units";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(unitRoutes);
  return app;
}

function sqlText(q: unknown): { text: string; params: unknown[] } {
  let text = "";
  const params: unknown[] = [];
  const walk = (node: unknown) => {
    const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
    if (!chunks) {
      text += "$";
      params.push(node);
      return;
    }
    for (const c of chunks) {
      if (c && typeof c === "object" && "value" in (c as object) && Array.isArray((c as { value: unknown }).value)) text += (c as { value: string[] }).value.join("");
      else if (c && typeof c === "object" && "queryChunks" in (c as object)) walk(c);
      else {
        text += "$";
        params.push(c);
      }
    }
  };
  walk(q);
  return { text, params };
}

function raw(seq: number, over: Partial<RawUnitRow> = {}): RawUnitRow {
  return {
    seq: String(seq),
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    email: "k.lourd@distribute.you",
    verifier: "bounceverify",
    verdict: "valid",
    source: "verify:instantly",
    verified_at: new Date("2026-11-20T00:00:00Z"),
    subject_service: null,
    lead_id: null,
    od_status: null,
    ...over,
  };
}

describe("isDecisive / toUnit", () => {
  it("a step-1 catch_all/unknown is undecided, BounceBan's verdict and step-1 valid/invalid/risky are final", () => {
    expect(isDecisive("bounceverify", "catch_all")).toBe(false);
    expect(isDecisive("trykitt", "unknown")).toBe(false);
    expect(isDecisive("bounceban", "unknown")).toBe(true);
    expect(isDecisive("contactout", "invalid")).toBe(true);
    expect(isDecisive("bounceverify", "risky")).toBe(true);
    expect(isDecisive("bounceverify", null)).toBe(false);
  });

  it("shapes a unit: age, step, deliverable, ledger subject", () => {
    const now = new Date("2026-11-24T12:00:00Z");
    expect(toUnit(raw(7, { subject_service: null, lead_id: "lead-9", od_status: "declared" }), now)).toEqual({
      verificationId: raw(7).id,
      email: "k.lourd@distribute.you",
      verdict: "valid",
      decisive: true,
      deliverable: true,
      step: "first",
      verifier: "bounceverify",
      verifiedAt: "2026-11-20T00:00:00.000Z",
      ageDays: 4.5,
      source: "verify:instantly",
      subject: { subjectService: "lead-service", subjectId: "lead-9", declared: true },
    });
    const bb = toUnit(raw(8, { verifier: "bounceban", verdict: "catch_all", subject_service: "transactional-email-service", lead_id: "sub-1", od_status: "pending" }), now);
    expect(bb).toMatchObject({ step: "second", decisive: true, deliverable: false, subject: { subjectService: "transactional-email-service", subjectId: "sub-1", declared: false } });
    // undecided step-1 catch_all: never deliverable; parked row not resolved yet = no subject
    expect(toUnit(raw(9, { verdict: "catch_all", od_status: "pending" }), now)).toMatchObject({ decisive: false, deliverable: false, subject: null });
  });
});

describe("GET /email-verifications/units", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue([]);
  });

  it("401 without the service key; 400 without emails or with a bad filter", async () => {
    expect((await request(createApp()).get(ROUTE).query({ emails: "a@b.com" })).status).toBe(401);
    expect((await request(createApp()).get(ROUTE).set(HEADERS)).status).toBe(400);
    expect((await request(createApp()).get(ROUTE).set(HEADERS).query({ emails: "a@b.com", verdicts: "maybe" })).status).toBe(400);
    expect((await request(createApp()).get(ROUTE).set(HEADERS).query({ emails: "a@b.com", since: "yesterday" })).status).toBe(400);
    expect((await request(createApp()).get(ROUTE).set(HEADERS).query({ emails: "a@b.com", limit: "501" })).status).toBe(400);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("an address never verified answers 200 with no units, never 404", async () => {
    const res = await request(createApp()).get(ROUTE).set(HEADERS).query({ emails: "never@distribute.you" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ units: [], nextBefore: null, hasMore: false });
  });

  it("normalizes comma-separated and repeated emails, binds filters, pages on seq", async () => {
    mockExecute.mockResolvedValue([raw(30), raw(20), raw(10)]);
    const res = await request(createApp())
      .get(`${ROUTE}?emails=K.Lourd@Distribute.you,%20b@x.com&emails=b@x.com&since=2026-10-01T00:00:00Z&decisive=true&verdicts=valid,invalid&limit=2&before=99`)
      .set(HEADERS);
    expect(res.status).toBe(200);
    expect(res.body.units).toHaveLength(2);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.nextBefore).toBe("20");
    const { text, params } = sqlText(mockExecute.mock.calls[0][0]);
    expect(params).toContain('{"k.lourd@distribute.you","b@x.com"}');
    expect(params).toContain("2026-10-01T00:00:00.000Z");
    expect(params).toContain('{"valid","invalid"}');
    expect(params).toContain("99");
    expect(params).toContain(3); // limit + 1
    expect(text).toContain("ev.verdict IS NOT NULL");
    expect(text).toContain("ORDER BY ev.seq DESC");
    expect(text).toContain("outcome_key = 'email_checked'");
  });

  it("includeFailed=true drops the not-null filter", async () => {
    await request(createApp()).get(ROUTE).set(HEADERS).query({ emails: "a@b.com", includeFailed: "true" });
    expect(sqlText(mockExecute.mock.calls[0][0]).text).not.toContain("ev.verdict IS NOT NULL");
  });
});

describe("served OpenAPI", () => {
  it("tags the read provider:email_found with a stable operationId, and documents the ask input", () => {
    const spec = JSON.parse(readFileSync(new URL("../../openapi.json", import.meta.url), "utf8"));
    const op = spec.paths["/email-verifications/units"].get;
    expect(op.operationId).toBe("listEmailFoundUnits");
    expect(op.tags).toEqual(["provider:email_found"]);
    const names = op.parameters.map((p: { name: string }) => p.name);
    for (const n of ["emails", "since", "decisive", "verdicts", "includeFailed", "limit", "before"]) expect(names).toContain(n);
    const body = spec.paths["/email-verifications"].post.requestBody.content["application/json"].schema;
    const props = body.properties ?? spec.components.schemas[body.$ref.split("/").pop()].properties;
    expect(props.maxVerdictAgeDays).toMatchObject({ type: "integer", minimum: 0, maximum: 3650 });
  });
});
