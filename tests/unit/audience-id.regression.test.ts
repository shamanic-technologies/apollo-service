import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Response as ExpressResponse } from "express";
import { serviceAuth, type AuthenticatedRequest } from "../../src/middleware/auth.js";

/**
 * Regression: per-audience cost attribution (x-audience-id).
 *
 * Guards the two ends of the chain that the unit tests in
 * tracking-headers.test.ts / downstream-headers.test.ts don't exercise with the
 * REAL implementations:
 *   1. INGRESS — the real serviceAuth middleware reads x-audience-id onto
 *      req.audienceId (optional: absent → undefined, never throws).
 *   2. EGRESS — the real Apollo client never leaks internal tracking headers
 *      (incl. x-audience-id) to the third-party Apollo API. Only X-Api-Key goes
 *      out. (DoorDash/OTel egress rule: drop everything but the vendor's own auth.)
 */

function mockRes(): ExpressResponse {
  const res = {} as ExpressResponse;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe("x-audience-id ingress (serviceAuth middleware)", () => {
  it("reads x-audience-id onto req.audienceId", async () => {
    const req = {
      headers: { "x-org-id": "org-1", "x-user-id": "user-1", "x-audience-id": "audience-789" },
    } as unknown as AuthenticatedRequest;
    const next = vi.fn();

    await serviceAuth(req, mockRes(), next);

    expect(next).toHaveBeenCalled();
    expect(req.audienceId).toBe("audience-789");
  });

  it("leaves req.audienceId undefined when header absent (no throw)", async () => {
    const req = {
      headers: { "x-org-id": "org-1", "x-user-id": "user-1" },
    } as unknown as AuthenticatedRequest;
    const next = vi.fn();

    await serviceAuth(req, mockRes(), next);

    expect(next).toHaveBeenCalled();
    expect(req.audienceId).toBeUndefined();
  });
});

describe("x-audience-id egress strip (apollo-client → third-party Apollo API)", () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ people: [], pagination: { total_entries: 0 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not forward x-audience-id (or any internal tracking header) to Apollo", async () => {
    const { searchPeople } = await import("../../src/lib/apollo-client.js");
    await searchPeople("apollo-secret-key", { page: 1, per_page: 25 } as never);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("api_search");

    const sentHeaders = Object.fromEntries(
      Object.entries(opts.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])
    );
    // Vendor auth goes out…
    expect(sentHeaders["x-api-key"]).toBe("apollo-secret-key");
    // …internal tracking headers must NOT.
    expect(sentHeaders).not.toHaveProperty("x-audience-id");
    expect(sentHeaders).not.toHaveProperty("x-campaign-id");
    expect(sentHeaders).not.toHaveProperty("x-run-id");
    expect(sentHeaders).not.toHaveProperty("x-brand-id");
    expect(sentHeaders).not.toHaveProperty("x-org-id");
    expect(sentHeaders).not.toHaveProperty("x-feature-slug");
  });
});
