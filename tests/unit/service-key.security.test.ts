/**
 * SEC-APOLLO-KEY-1120 — replay of the attacker class of call.
 *
 * apollo-service is publicly routed (apollo.distribute.you). Before this gate
 * serviceAuth/orgAuth only checked that x-org-id / x-user-id were PRESENT, so
 * anyone could spend any org's Apollo credits and read its data. Every route
 * except the public allowlist must refuse a call without OUR key with a 401,
 * BEFORE any DB or vendor call.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import express from "express";
import request from "supertest";

const dbTouched = vi.fn();
vi.mock("../../src/db/index.js", () => {
  const trap: any = new Proxy(function () {}, {
    get: (_t, prop) => {
      if (prop === "then") return undefined;
      dbTouched(String(prop));
      return trap;
    },
    apply: () => {
      dbTouched("call");
      return trap;
    },
  });
  return { db: trap, getSql: () => trap };
});

const KEY = "sec-test-apollo-service-key-0123456789";
process.env.APOLLO_SERVICE_API_KEY = KEY;

const fetchSpy = vi.fn(async () => {
  throw new Error("no outbound call may happen for a refused request");
});
const realFetch = globalThis.fetch;
globalThis.fetch = fetchSpy as unknown as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

const { default: app } = await import("../../src/index.js");
const { serviceAuth, orgAuth } = await import("../../src/middleware/auth.js");
const { isPublicRoute, serviceKeyMatches } = await import("../../src/middleware/service-key.js");

const ATTACKER_ORG = "3afacd9a-fe2f-4413-b51f-217f30920830";
const VICTIM_HEADERS = {
  "x-org-id": ATTACKER_ORG,
  "x-user-id": "00000000-0000-4000-8000-000000000001",
  "x-run-id": "00000000-0000-4000-8000-000000000002",
  "x-brand-id": "00000000-0000-4000-8000-000000000003",
  "x-campaign-id": "00000000-0000-4000-8000-000000000004",
};

/** Every route the real app registers, read from Express' own stack (nothing hand-listed). */
function registeredRoutes(): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  const walk = (stack: any[]) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) {
          out.push({ method: m.toUpperCase(), path: layer.route.path });
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack);
      }
    }
  };
  walk((app as any)._router.stack);
  return out;
}

function concrete(path: string): string {
  return path.replace(/:[A-Za-z]+/g, "64a1f2b3c4d5e6f7a8b90001");
}

const ROUTES = registeredRoutes();
const PROTECTED = ROUTES.filter((r) => !isPublicRoute(r.method, r.path));

function send(method: string, path: string) {
  const agent = request(app) as any;
  return agent[method.toLowerCase()](concrete(path));
}

beforeEach(() => {
  dbTouched.mockClear();
  fetchSpy.mockClear();
  process.env.APOLLO_SERVICE_API_KEY = KEY;
});

describe("SEC-APOLLO-KEY-1120: attacker replay", () => {
  it("covers every paid / data route of the service", () => {
    const paths = PROTECTED.map((r) => `${r.method} ${r.path}`);
    for (const p of [
      "POST /enrich",
      "POST /match",
      "POST /search/next",
      "POST /search/dry-run",
      "POST /audiences/suggest-from-segment",
      "GET /audiences/:apolloAudienceId",
      "POST /people/:apolloPersonId/phone-reveal",
      "GET /people/:apolloPersonId/phone-reveal",
      "POST /email-finder/find",
      "POST /email-verifications",
      "POST /internal/transfer-brand",
      "GET /health/debug",
    ]) {
      expect(paths).toContain(p);
    }
    expect(PROTECTED.length).toBeGreaterThan(40);
  });

  for (const variant of [
    { name: "no x-api-key", key: undefined as string | undefined },
    { name: "empty x-api-key", key: "" },
    { name: "wrong x-api-key", key: "attacker-guess" },
    { name: "same-length wrong x-api-key", key: "x".repeat(KEY.length) },
  ]) {
    it(`refuses ${variant.name} with 401 on every protected route, before any DB or vendor call`, async () => {
      for (const r of PROTECTED) {
        let req = send(r.method, r.path).set(VICTIM_HEADERS);
        if (variant.key !== undefined) req = req.set("x-api-key", variant.key);
        const res = await req.send({ email: "a@b.com", apolloPersonId: "p", searchParams: {} });
        expect({ route: `${r.method} ${r.path}`, status: res.status }).toEqual({
          route: `${r.method} ${r.path}`,
          status: 401,
        });
      }
      expect(dbTouched).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  }

  it("refuses an unknown path keyless too (401, not a 404 map of the surface)", async () => {
    const res = await request(app).get("/does-not-exist").set(VICTIM_HEADERS);
    expect(res.status).toBe(401);
  });

  it("fails closed when our key is unset: even the right-looking key is refused", async () => {
    delete process.env.APOLLO_SERVICE_API_KEY;
    const res = await request(app).post("/enrich").set(VICTIM_HEADERS).set("x-api-key", KEY).send({});
    expect(res.status).toBe(500);
    expect(serviceKeyMatches(KEY)).toBe(false);
    expect(dbTouched).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("lets the correct key through the gate", async () => {
    const res = await request(app).get("/search/filters-prompt").set(VICTIM_HEADERS).set("x-api-key", KEY);
    expect(res.status).not.toBe(401);
  });

  it("keeps /health and /openapi.json public", async () => {
    expect((await request(app).get("/health")).status).toBe(200);
    expect((await request(app).get("/openapi.json")).status).not.toBe(401);
  });

  it("keeps the phone-reveal webhook on its own secret (no key, wrong secret = 401 without DB)", async () => {
    process.env.APOLLO_PHONE_REVEAL_WEBHOOK_SECRET = "hook-secret";
    const res = await request(app).post("/webhook/phone-reveal?secret=nope").send({ status: "success" });
    expect(res.status).toBe(401);
    expect(dbTouched).not.toHaveBeenCalled();
  });
});

describe("SEC-APOLLO-KEY-1120: serviceAuth / orgAuth compare the key themselves", () => {
  const bare = express();
  bare.get("/s", serviceAuth, (_req, res) => res.json({ ok: true }));
  bare.get("/o", orgAuth, (_req, res) => res.json({ ok: true }));

  for (const path of ["/s", "/o"]) {
    it(`${path}: a router mounted without the app gate is still keyless-proof`, async () => {
      expect((await request(bare).get(path).set(VICTIM_HEADERS)).status).toBe(401);
      expect((await request(bare).get(path).set(VICTIM_HEADERS).set("x-api-key", "wrong")).status).toBe(401);
      expect((await request(bare).get(path).set(VICTIM_HEADERS).set("x-api-key", KEY)).status).toBe(200);
    });
  }
});
