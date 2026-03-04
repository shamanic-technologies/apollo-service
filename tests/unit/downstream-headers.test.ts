import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests that runs-client and keys-client send the required
 * x-org-id, x-user-id, and x-run-id headers on every downstream call.
 */

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function okResponse(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function created(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── runs-client ────────────────────────────────────────────────────────────

describe("runs-client identity headers", () => {
  it("createRun sends x-org-id, x-user-id, x-run-id (parentRunId) as headers", async () => {
    mockFetch.mockResolvedValueOnce(created({ id: "run-new" }));

    const { createRun } = await import("../../src/lib/runs-client.js");
    await createRun({
      orgId: "org-123",
      userId: "user-456",
      serviceName: "apollo-service",
      taskName: "people-search",
      parentRunId: "parent-run-789",
    });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("/v1/runs");
    expect(opts.headers).toMatchObject({
      "x-org-id": "org-123",
      "x-user-id": "user-456",
      "x-run-id": "parent-run-789",
    });

    // orgId, userId, parentRunId should NOT be in the body
    const body = JSON.parse(opts.body);
    expect(body).not.toHaveProperty("orgId");
    expect(body).not.toHaveProperty("userId");
    expect(body).not.toHaveProperty("parentRunId");
    expect(body).toHaveProperty("serviceName", "apollo-service");
    expect(body).toHaveProperty("taskName", "people-search");
  });

  it("updateRun sends x-org-id, x-user-id, x-run-id headers", async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ id: "run-1" }));

    const { updateRun } = await import("../../src/lib/runs-client.js");
    await updateRun("run-1", "completed", { orgId: "org-123", userId: "user-456" });

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers).toMatchObject({
      "x-org-id": "org-123",
      "x-user-id": "user-456",
      "x-run-id": "run-1",
    });
  });

  it("addCosts sends x-org-id, x-user-id, x-run-id headers", async () => {
    mockFetch.mockResolvedValueOnce(created({ costs: [] }));

    const { addCosts } = await import("../../src/lib/runs-client.js");
    await addCosts("run-1", [{ costName: "test", costSource: "platform", quantity: 1 }], {
      orgId: "org-123",
      userId: "user-456",
    });

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers).toMatchObject({
      "x-org-id": "org-123",
      "x-user-id": "user-456",
      "x-run-id": "run-1",
    });
  });

  it("getRun sends x-org-id, x-user-id, x-run-id headers", async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ id: "run-1", costs: [] }));

    const { getRun } = await import("../../src/lib/runs-client.js");
    await getRun("run-1", { orgId: "org-123", userId: "user-456" });

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers).toMatchObject({
      "x-org-id": "org-123",
      "x-user-id": "user-456",
      "x-run-id": "run-1",
    });
  });

  it("listRuns sends x-org-id as header, not as query param", async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ runs: [], limit: 50, offset: 0 }));

    const { listRuns } = await import("../../src/lib/runs-client.js");
    await listRuns({ orgId: "org-123", userId: "user-456" });

    const [url, opts] = mockFetch.mock.calls[0];
    expect(opts.headers).toMatchObject({
      "x-org-id": "org-123",
      "x-user-id": "user-456",
    });
    // orgId should NOT be in query params
    expect(url).not.toContain("orgId=");
  });
});

// ─── keys-client ────────────────────────────────────────────────────────────

describe("keys-client identity headers", () => {
  it("decryptKey sends x-org-id and x-user-id as headers, not query params", async () => {
    mockFetch.mockResolvedValueOnce(okResponse({ key: "decrypted-key", keySource: "platform" }));

    const { decryptKey } = await import("../../src/lib/keys-client.js");
    await decryptKey("org-123", "user-456", "apollo", {
      callerMethod: "POST",
      callerPath: "/search",
    });

    const [url, opts] = mockFetch.mock.calls[0];
    // Should NOT have orgId/userId as query params
    expect(url).not.toContain("orgId=");
    expect(url).not.toContain("userId=");
    // Should have them as headers
    expect(opts.headers).toMatchObject({
      "x-org-id": "org-123",
      "x-user-id": "user-456",
      "X-Caller-Service": "apollo",
      "X-Caller-Method": "POST",
      "X-Caller-Path": "/search",
    });
  });
});
