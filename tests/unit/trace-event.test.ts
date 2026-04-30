import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { traceEvent } from "../../src/lib/trace-event.js";

describe("traceEvent", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should POST event to runs-service", async () => {
    process.env.RUNS_SERVICE_URL = "https://runs.test";
    process.env.RUNS_SERVICE_API_KEY = "test-key";

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    await traceEvent(
      "run-123",
      { service: "apollo-service", event: "test-event", detail: "details here" },
      { "x-org-id": "org-1", "x-user-id": "user-1" },
    );

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://runs.test/v1/runs/run-123/events");
    expect(opts.method).toBe("POST");
    expect(opts.headers["x-api-key"]).toBe("test-key");
    expect(opts.headers["x-org-id"]).toBe("org-1");
    expect(opts.headers["x-user-id"]).toBe("user-1");
    const body = JSON.parse(opts.body);
    expect(body.service).toBe("apollo-service");
    expect(body.event).toBe("test-event");
    expect(body.detail).toBe("details here");
  });

  it("should skip when RUNS_SERVICE_URL is not set", async () => {
    delete process.env.RUNS_SERVICE_URL;
    delete process.env.RUNS_SERVICE_API_KEY;

    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await traceEvent(
      "run-123",
      { service: "apollo-service", event: "test" },
      {},
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not set"),
    );
  });

  it("should not throw on fetch failure", async () => {
    process.env.RUNS_SERVICE_URL = "https://runs.test";
    process.env.RUNS_SERVICE_API_KEY = "test-key";

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      traceEvent(
        "run-123",
        { service: "apollo-service", event: "test" },
        {},
      ),
    ).resolves.toBeUndefined();
  });

  it("should forward all identity headers when present", async () => {
    process.env.RUNS_SERVICE_URL = "https://runs.test";
    process.env.RUNS_SERVICE_API_KEY = "test-key";

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    await traceEvent(
      "run-123",
      { service: "apollo-service", event: "test" },
      {
        "x-org-id": "org-1",
        "x-brand-id": "brand-1,brand-2",
        "x-campaign-id": "camp-1",
        "x-workflow-slug": "wf-slug",
        "x-feature-slug": "feat-slug",
      },
    );

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers["x-brand-id"]).toBe("brand-1,brand-2");
    expect(headers["x-campaign-id"]).toBe("camp-1");
    expect(headers["x-workflow-slug"]).toBe("wf-slug");
    expect(headers["x-feature-slug"]).toBe("feat-slug");
  });

  it("should omit undefined identity headers", async () => {
    process.env.RUNS_SERVICE_URL = "https://runs.test";
    process.env.RUNS_SERVICE_API_KEY = "test-key";

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    await traceEvent(
      "run-123",
      { service: "apollo-service", event: "test" },
      { "x-org-id": "org-1" },
    );

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers).not.toHaveProperty("x-user-id");
    expect(headers).not.toHaveProperty("x-brand-id");
    expect(headers).not.toHaveProperty("x-campaign-id");
  });

  it("should include level and data in payload", async () => {
    process.env.RUNS_SERVICE_URL = "https://runs.test";
    process.env.RUNS_SERVICE_API_KEY = "test-key";

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    await traceEvent(
      "run-123",
      {
        service: "apollo-service",
        event: "error-event",
        level: "error",
        data: { count: 42 },
      },
      {},
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.level).toBe("error");
    expect(body.data).toEqual({ count: 42 });
  });
});
