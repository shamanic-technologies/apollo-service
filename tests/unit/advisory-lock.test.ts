import { describe, it, expect, vi, afterEach } from "vitest";
import { advisoryXactLock, enrichLockKey, matchLockKey, singleFlight } from "../../src/lib/advisory-lock.js";
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

describe("singleFlight (BOX-DB-LOAD-1028)", () => {
  it("concurrent callers for one key share ONE run of the work", async () => {
    let runs = 0;
    let release!: (v: string) => void;
    const work = () => {
      runs++;
      return new Promise<string>((r) => (release = r));
    };
    const a = singleFlight("k", work);
    const b = singleFlight("k", work);
    release("answer");
    expect(await Promise.all([a, b])).toEqual(["answer", "answer"]);
    expect(runs).toBe(1);
  });

  it("different keys run independently, and a later call after settle runs again", async () => {
    let runs = 0;
    const work = async () => ++runs;
    await Promise.all([singleFlight("x", work), singleFlight("y", work)]);
    expect(runs).toBe(2);
    await singleFlight("x", work);
    expect(runs).toBe(3);
  });

  it("a follower whose leader threw runs the work itself", async () => {
    let reject!: (e: Error) => void;
    const leader = singleFlight("z", () => new Promise<string>((_, r) => (reject = r)));
    const follower = singleFlight("z", async () => "own");
    reject(new Error("leader's org has no credit"));
    await expect(leader).rejects.toThrow("no credit");
    expect(await follower).toBe("own");
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
