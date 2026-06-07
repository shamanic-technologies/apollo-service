import { describe, it, expect, vi, afterEach } from "vitest";
import { advisoryXactLock, enrichLockKey, matchLockKey } from "../../src/lib/advisory-lock.js";
import { enrichPerson, matchPersonByName } from "../../src/lib/apollo-client.js";

/**
 * Tests for the advisory-lock helpers + the Apollo fetch timeout that bounds how
 * long the lock can be held.
 */

describe("lock keys", () => {
  it("enrichLockKey namespaces on the person id", () => {
    expect(enrichLockKey("ap-123")).toBe("apollo-enrich:ap-123");
  });

  it("matchLockKey namespaces on a case-folded name+domain tuple", () => {
    expect(matchLockKey("John", "Doe", "Acme.COM")).toBe("apollo-match:john|doe|acme.com");
  });
});

describe("advisoryXactLock", () => {
  it("issues a single pg_advisory_xact_lock on the executor", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    await advisoryXactLock({ execute }, "apollo-enrich:ap-1");

    expect(execute).toHaveBeenCalledTimes(1);
    // The SQL passed to drizzle carries the lock function in its query chunks.
    const sqlArg = execute.mock.calls[0][0] as { queryChunks: unknown[] };
    const flattened = JSON.stringify(sqlArg.queryChunks);
    expect(flattened).toContain("pg_advisory_xact_lock");
    expect(flattened).toContain("hashtext");
  });
});

describe("Apollo fetch timeout", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function fakeOk(body: unknown): Response {
    return { ok: true, text: async () => JSON.stringify(body) } as unknown as Response;
  }

  it("enrichPerson passes an AbortSignal to fetch (bounds lock hold)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeOk({ person: { id: "p-1" } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await enrichPerson("key", "p-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("matchPersonByName passes an AbortSignal to fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(fakeOk({ person: { id: "p-1" } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await matchPersonByName("key", "John", "Doe", "acme.com");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
