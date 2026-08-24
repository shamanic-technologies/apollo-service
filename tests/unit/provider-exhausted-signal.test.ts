import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import {
  ApolloCreditsExhaustedError,
  providerErrorFields,
  PROVIDER_CREDITS_EXHAUSTED,
} from "../../src/lib/provider-error.js";

/**
 * The provider-cannot-serve signal.
 *
 * Apollo's credit exhaustion used to reach callers as a generic upstream
 * failure — byte-identical to a transient blip — so downstream services had to
 * guess, and a campaign retried the same dead call 621 times without telling
 * anyone. These tests pin BOTH directions of the contract:
 *
 *   exhausted → error body carries `providerError`
 *   ordinary  → error body carries NO `providerError`, unchanged from before
 */

/** Apollo's literal out-of-credits answer, verbatim from the 2026-08-22 prod failures. */
const APOLLO_INSUFFICIENT_CREDITS_BODY =
  '{"error":"You have insufficient credits! <a href=\'https://app.apollo.io/#/settings/plans/upgrade\' aria-onclick=\'close_alert\'>Upgrade your plan</a> to increase your number of lead credits."}';

/** An ORDINARY Apollo 422 — same status, no credit wording (issue #131 shape). */
const APOLLO_ORDINARY_422_BODY = '{"error":"Page * per page number is over threshold."}';

// ─────────────────────────────────────────────────────────────────────────────
// Route mocks — mirrors tests/unit/search-dry-run.test.ts
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn(),
  updateRun: vi.fn().mockResolvedValue({}),
  addCosts: vi.fn().mockResolvedValue({ costs: [] }),
}));

vi.mock("../../src/middleware/auth.js", () => ({
  serviceAuth: (req: any, _res: any, next: any) => {
    if (req.headers["x-org-id"]) req.orgId = req.headers["x-org-id"];
    if (req.headers["x-user-id"]) req.userId = req.headers["x-user-id"];
    if (req.headers["x-run-id"]) req.runId = req.headers["x-run-id"];
    next();
  },
}));

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: () => ({
      values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: "x" }]) }),
    }),
    update: () => ({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
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

vi.mock("../../src/lib/billing-client.js", () => ({ authorizeCredit: vi.fn() }));

const mockSearchPeople = vi.fn();
vi.mock("../../src/lib/apollo-client.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  searchPeople: (...args: unknown[]) => mockSearchPeople(...args),
  enrichPerson: vi.fn(),
  buildWaterfallWebhookUrl: () => undefined,
}));

const HEADERS = { "X-Org-Id": "org-1", "X-User-Id": "user-1" };

/**
 * The route half of this file mocks the Apollo client; the classification half
 * must exercise the REAL one.
 */
function realApolloClient() {
  return vi.importActual<typeof import("../../src/lib/apollo-client.js")>(
    "../../src/lib/apollo-client.js",
  );
}

describe("provider-cannot-serve signal — Apollo client classification", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // No transactional-email env: the staff alert no-ops, which must not affect
    // what the Apollo call throws.
    delete process.env.TRANSACTIONAL_EMAIL_SERVICE_URL;
    delete process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function apolloRejects(status: number, body: string) {
    fetchMock.mockResolvedValue({ ok: false, status, text: async () => body });
  }

  it("throws the typed exhaustion error on Apollo's 422 out-of-credits body", async () => {
    const { searchPeople } = await realApolloClient();
    apolloRejects(422, APOLLO_INSUFFICIENT_CREDITS_BODY);

    const error = await searchPeople("key", { person_titles: ["CEO"] }).catch((e) => e);

    expect(error).toBeInstanceOf(ApolloCreditsExhaustedError);
    expect(error.providerError).toEqual({
      provider: "apollo",
      code: PROVIDER_CREDITS_EXHAUSTED,
      retryable: false,
      message: expect.any(String),
    });
    // Existing message shape is untouched — nothing reading err.message changes.
    expect(error.message).toContain("Apollo search failed: 422 - ");
  });

  it("throws the typed exhaustion error on a credit-denied status (402)", async () => {
    const { enrichPerson } = await realApolloClient();
    apolloRejects(402, "payment required");

    const error = await enrichPerson("key", "person-1").catch((e) => e);

    expect(error).toBeInstanceOf(ApolloCreditsExhaustedError);
    expect(error.message).toContain("Apollo enrich failed: 402");
  });

  it("throws a PLAIN error on an ordinary 422 — no exhaustion signal", async () => {
    const { searchPeople } = await realApolloClient();
    apolloRejects(422, APOLLO_ORDINARY_422_BODY);

    const error = await searchPeople("key", { person_titles: ["CEO"] }).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ApolloCreditsExhaustedError);
    expect(providerErrorFields(error)).toEqual({});
  });

  it("throws a PLAIN error on a transient 500 — no exhaustion signal", async () => {
    const { matchPersonByName } = await realApolloClient();
    apolloRejects(500, "Internal Server Error");

    const error = await matchPersonByName("key", "Ada", "Lovelace", "example.com").catch((e) => e);

    expect(error).not.toBeInstanceOf(ApolloCreditsExhaustedError);
    expect(providerErrorFields(error)).toEqual({});
  });

  it("emits no providerError for a non-Apollo failure (network drop)", () => {
    expect(providerErrorFields(new TypeError("fetch failed"))).toEqual({});
    expect(providerErrorFields(undefined)).toEqual({});
  });
});

describe("provider-cannot-serve signal — HTTP contract", () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockDecryptKey.mockResolvedValue({ key: "fake-apollo-key", keySource: "platform" });
    vi.spyOn(console, "error").mockImplementation(() => {});

    app = express();
    app.use(express.json());
    const { default: searchRoutes } = await import("../../src/routes/search.js");
    app.use(searchRoutes);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("carries providerError when Apollo cannot serve — one response, no repeats, no prose parsing", async () => {
    mockSearchPeople.mockRejectedValue(
      new ApolloCreditsExhaustedError(`Apollo search failed: 422 - ${APOLLO_INSUFFICIENT_CREDITS_BODY}`, 422),
    );

    const res = await request(app)
      .post("/search/dry-run")
      .set(HEADERS)
      .send({ personTitles: ["CEO"] })
      .expect(500);

    expect(res.body.providerError).toEqual({
      provider: "apollo",
      code: "provider_credits_exhausted",
      retryable: false,
      message: expect.any(String),
    });
    // Additive only: the pre-existing fields are exactly what they were.
    expect(res.body.type).toBe("internal");
    expect(res.body.error).toContain("Apollo search failed: 422");
  });

  it("carries NO providerError on an ordinary failure — body unchanged from today", async () => {
    mockSearchPeople.mockRejectedValue(
      new Error(`Apollo search failed: 422 - ${APOLLO_ORDINARY_422_BODY}`),
    );

    const res = await request(app)
      .post("/search/dry-run")
      .set(HEADERS)
      .send({ personTitles: ["CEO"] })
      .expect(500);

    expect(res.body.providerError).toBeUndefined();
    expect(res.body).toEqual({
      type: "internal",
      error: `Apollo search failed: 422 - ${APOLLO_ORDINARY_422_BODY}`,
    });
  });
});
