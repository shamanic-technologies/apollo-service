import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests that keys-client sends the required X-Caller-* headers
 * on every decrypt call to key-service.
 */

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function okResponse(key: string) {
  return new Response(JSON.stringify({ key }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("getByokKey caller headers", () => {
  it("should send X-Caller-Service, X-Caller-Method, and X-Caller-Path headers", async () => {
    mockFetch.mockResolvedValueOnce(okResponse("byok-key-123"));

    const { getByokKey } = await import("../../src/lib/keys-client.js");
    await getByokKey("org_test", "apollo", { callerMethod: "POST", callerPath: "/search" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers).toMatchObject({
      "X-Caller-Service": "apollo",
      "X-Caller-Method": "POST",
      "X-Caller-Path": "/search",
    });
  });
});

describe("getAppKey caller headers", () => {
  it("should send X-Caller-Service, X-Caller-Method, and X-Caller-Path headers", async () => {
    mockFetch.mockResolvedValueOnce(okResponse("app-key-456"));

    const { getAppKey } = await import("../../src/lib/keys-client.js");
    await getAppKey("app-1", "apollo", { callerMethod: "POST", callerPath: "/search/params" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers).toMatchObject({
      "X-Caller-Service": "apollo",
      "X-Caller-Method": "POST",
      "X-Caller-Path": "/search/params",
    });
  });
});
