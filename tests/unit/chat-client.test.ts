import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chatComplete, platformChoiceJudgment, type ChatCompleteParams, type ChatTrackingHeaders } from "../../src/lib/chat-client.js";

/**
 * chat-client routes by `billing`:
 *   - "org": POST /complete, with org/run-scoped headers.
 *   - "platform": POST /internal/platform-complete, x-api-key + x-run-id only.
 *
 * Both carry THIS service's own run in x-run-id (PLATFORM-CALLER-RUN-1024):
 * a platform call naming neither a caller run nor a support function is
 * refused by chat-service.
 */

const PARAMS: ChatCompleteParams = {
  message: "build filters",
  systemPrompt: "you are a builder",
  provider: "anthropic",
  model: "sonnet",
  responseFormat: "json",
  temperature: 0.2,
  maxTokens: 2000,
};

const OK_RESPONSE = {
  json: { action: "confirm", filters: {} },
  content: "",
  tokensInput: 1,
  tokensOutput: 1,
  model: "claude-sonnet",
};

function mockFetchOk() {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => OK_RESPONSE,
    text: async () => JSON.stringify(OK_RESPONSE),
  })) as unknown as typeof fetch;
}

describe("chatComplete endpoint routing", () => {
  beforeEach(() => {
    process.env.CHAT_SERVICE_URL = "https://chat.test";
    process.env.CHAT_SERVICE_API_KEY = "chat-key";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("routes run-scoped calls to POST /complete with identity headers and maxTokens", async () => {
    const fetchMock = mockFetchOk();
    vi.stubGlobal("fetch", fetchMock);

    const tracking: ChatTrackingHeaders = { orgId: "org-1", userId: "user-1", runId: "run-1", billing: "org" };
    const res = await chatComplete(PARAMS, tracking);
    expect(res.model).toBe("claude-sonnet");

    const [url, init] = (fetchMock as any).mock.calls[0];
    expect(url).toBe("https://chat.test/complete");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("chat-key");
    expect(headers["x-org-id"]).toBe("org-1");
    expect(headers["x-user-id"]).toBe("user-1");
    expect(headers["x-run-id"]).toBe("run-1");
    const body = JSON.parse(init.body as string);
    expect(body.maxTokens).toBe(2000);
  });

  it("routes platform-billed calls to POST /internal/platform-complete with x-api-key + OUR run only, no maxTokens", async () => {
    const fetchMock = mockFetchOk();
    vi.stubGlobal("fetch", fetchMock);

    const tracking: ChatTrackingHeaders = { orgId: "org-1", userId: "user-1", runId: "our-run-1", billing: "platform" };
    const res = await chatComplete(PARAMS, tracking);
    expect(res.model).toBe("claude-sonnet");

    const [url, init] = (fetchMock as any).mock.calls[0];
    expect(url).toBe("https://chat.test/internal/platform-complete");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("chat-key");
    // The caller run: the platform run chat-service opens becomes its child.
    expect(headers["x-run-id"]).toBe("our-run-1");
    // No org/user identity on the platform path.
    expect(headers["x-org-id"]).toBeUndefined();
    expect(headers["x-user-id"]).toBeUndefined();
    const body = JSON.parse(init.body as string);
    // Never a support mark: this work is done for our run.
    expect(body.support).toBeUndefined();
    // platform-complete has no maxTokens field in chat-service's request schema.
    expect(body.maxTokens).toBeUndefined();
    expect(body.message).toBe("build filters");
    expect(body.responseFormat).toBe("json");
    expect(body.temperature).toBe(0.2);
  });

  it("refuses a call without our run before reaching chat-service", async () => {
    const fetchMock = mockFetchOk();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      chatComplete(PARAMS, { orgId: "org-1", runId: "", billing: "platform" }),
    ).rejects.toThrow(/run id/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates the endpoint path in the error message (fail loud)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => ({}),
      text: async () => "boom",
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    await expect(chatComplete(PARAMS, { orgId: "org-1", runId: "our-run-1", billing: "platform" })).rejects.toThrow(
      /POST \/internal\/platform-complete returned 502: boom/,
    );
  });

  it("retries a transient UND_ERR_SOCKET / 'other side closed' drop, then succeeds", async () => {
    // First call throws the sibling connection-drop transient; retry succeeds.
    const socketDrop = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw socketDrop;
      return {
        ok: true,
        status: 200,
        json: async () => OK_RESPONSE,
        text: async () => JSON.stringify(OK_RESPONSE),
      };
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const res = await chatComplete(PARAMS, { orgId: "org-1", runId: "run-1", billing: "org" });
    expect(res.model).toBe("claude-sonnet");
    expect(calls).toBe(2);
  });

  it("does NOT retry a completed 5xx HTTP response (real answer, fails loud once)", async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return { ok: false, status: 503, json: async () => ({}), text: async () => "unavailable" };
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    await expect(chatComplete(PARAMS, { orgId: "org-1", runId: "run-1", billing: "org" })).rejects.toThrow(
      /returned 503: unavailable/,
    );
    // A returned Response is never retried — exactly one call.
    expect(calls).toBe(1);
  });

  it("propagates a persistent transient failure after exhausting retries (fail loud)", async () => {
    const socketDrop = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      throw socketDrop;
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    await expect(chatComplete(PARAMS, { orgId: "org-1", runId: "run-1", billing: "org" })).rejects.toThrow(
      /fetch failed/,
    );
    // Initial attempt + 3 bounded retries.
    expect(calls).toBe(4);
  });
});

describe("platformChoiceJudgment", () => {
  beforeEach(() => {
    process.env.CHAT_SERVICE_URL = "https://chat.test";
    process.env.CHAT_SERVICE_API_KEY = "chat-key";
  });
  afterEach(() => vi.restoreAllMocks());

  it("names the caller run in x-run-id and sends no support mark", async () => {
    const answer = { type: "choice", choice: "B2B SaaS", confidence: 0.9, probabilities: {} };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ answers: { answer } }),
      text: async () => "",
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const res = await platformChoiceJudgment({ callerRunId: "lookup-run-1", state: "s", instructions: "i", criteria: { a: "b" } });
    expect(res.choice).toBe("B2B SaaS");
    const [url, init] = (fetchMock as any).mock.calls[0];
    expect(url).toBe("https://chat.test/internal/platform-judgments");
    expect((init.headers as Record<string, string>)["x-run-id"]).toBe("lookup-run-1");
    expect(JSON.parse(init.body as string).support).toBeUndefined();
  });

  it("refuses a judgment without a caller run", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      platformChoiceJudgment({ callerRunId: "", state: "s", instructions: "i", criteria: { a: "b" } }),
    ).rejects.toThrow(/run id/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
