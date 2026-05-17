import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { authorizeCredit } from "../../src/lib/billing-client.js";

describe("billing-client authorizeCredit", () => {
  const originalFetch = global.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("posts to /v1/customer_balance/authorize", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sufficient: true, balance_cents: "100", required_cents: "10" }),
    });

    await authorizeCredit({
      items: [{ costName: "apollo_people_search", quantity: 1 }],
      description: "test",
      orgId: "org-1",
      userId: "user-1",
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("/v1/customer_balance/authorize");
    expect(String(url)).not.toContain("/v1/credits/authorize");
  });

  it("throws with new path in error message on non-2xx", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 402,
      text: async () => "insufficient",
    });

    await expect(
      authorizeCredit({
        items: [{ costName: "apollo_people_search", quantity: 1 }],
        description: "test",
        orgId: "org-1",
        userId: "user-1",
      })
    ).rejects.toThrow(/\/v1\/customer_balance\/authorize/);
  });
});
