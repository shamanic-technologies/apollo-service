import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("instrument", () => {
  const originalEnv = process.env.SENTRY_DSN;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.SENTRY_DSN = originalEnv;
    } else {
      delete process.env.SENTRY_DSN;
    }
    vi.restoreAllMocks();
  });

  it("should not initialize Sentry when SENTRY_DSN is not set", async () => {
    delete process.env.SENTRY_DSN;

    const initSpy = vi.fn();
    const setTagSpy = vi.fn();
    vi.doMock("@sentry/node", () => ({
      init: initSpy,
      setTag: setTagSpy,
    }));

    await import("../../src/instrument.js");

    expect(initSpy).not.toHaveBeenCalled();
    expect(setTagSpy).not.toHaveBeenCalled();
  });

  it("should initialize Sentry with correct config when SENTRY_DSN is set", async () => {
    process.env.SENTRY_DSN = "https://fake@sentry.io/123";

    const initSpy = vi.fn();
    const setTagSpy = vi.fn();
    vi.doMock("@sentry/node", () => ({
      init: initSpy,
      setTag: setTagSpy,
    }));

    await import("../../src/instrument.js");

    expect(initSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: "https://fake@sentry.io/123",
        tracesSampleRate: 0.1,
      })
    );
    expect(setTagSpy).toHaveBeenCalledWith("service", "apollo-service");
  });

  it("should exclude drizzle-orm from ESM loader hooks to prevent named-export breakage", async () => {
    process.env.SENTRY_DSN = "https://fake@sentry.io/123";

    const initSpy = vi.fn();
    const setTagSpy = vi.fn();
    vi.doMock("@sentry/node", () => ({
      init: initSpy,
      setTag: setTagSpy,
    }));

    await import("../../src/instrument.js");

    const config = initSpy.mock.calls[0][0];
    expect(config.registerEsmLoaderHooks).toBeDefined();
    expect(config.registerEsmLoaderHooks.exclude).toBeDefined();

    const excludePatterns: RegExp[] = config.registerEsmLoaderHooks.exclude;
    expect(excludePatterns.some((re: RegExp) => re.test("drizzle-orm"))).toBe(
      true
    );
  });

  it("index.ts should not statically import instrument", async () => {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");

    const indexContent = readFileSync(
      join(process.cwd(), "src/index.ts"),
      "utf-8"
    );

    expect(indexContent).not.toMatch(/import.*instrument/);
  });
});
