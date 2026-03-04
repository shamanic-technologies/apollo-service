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

function okResponse(key: string, keySource: "org" | "platform" = "platform") {
  return new Response(JSON.stringify({ key, keySource }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("decryptKey caller headers", () => {
  it("should send X-Caller-Service, X-Caller-Method, and X-Caller-Path headers", async () => {
    mockFetch.mockResolvedValueOnce(okResponse("decrypted-key-123"));

    const { decryptKey } = await import("../../src/lib/keys-client.js");
    await decryptKey("org_test", "user_test", "apollo", { callerMethod: "POST", callerPath: "/search" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers).toMatchObject({
      "X-Caller-Service": "apollo",
      "X-Caller-Method": "POST",
      "X-Caller-Path": "/search",
    });
  });

  it("should return key and keySource from response", async () => {
    mockFetch.mockResolvedValueOnce(okResponse("my-key", "org"));

    const { decryptKey } = await import("../../src/lib/keys-client.js");
    const result = await decryptKey("org_test", "user_test", "apollo", { callerMethod: "POST", callerPath: "/search" });

    expect(result).toEqual({ key: "my-key", keySource: "org" });
  });

  it("should pass orgId and userId as x-org-id/x-user-id headers", async () => {
    mockFetch.mockResolvedValueOnce(okResponse("key-abc"));

    const { decryptKey } = await import("../../src/lib/keys-client.js");
    await decryptKey("org-uuid-1", "user-uuid-2", "anthropic", { callerMethod: "POST", callerPath: "/search/params" });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/keys/anthropic/decrypt");
    expect(url).not.toContain("orgId=");
    expect(opts.headers).toMatchObject({
      "x-org-id": "org-uuid-1",
      "x-user-id": "user-uuid-2",
    });
  });
});
