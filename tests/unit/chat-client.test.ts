import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { chatComplete, type ChatCompleteParams, type ChatTrackingHeaders } from "../../src/lib/chat-client.js";

/**
 * chat-client routes by inbound run id:
 *   - WITH runId: POST /complete, with org/run-scoped headers.
 *   - WITHOUT runId: POST /internal/platform-complete, with x-api-key only.
 *
 * This is the run-less migration/backfill fix: chat-service rejects /complete
 * without x-run-id, so run-less callers must use the platform endpoint.
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

    const tracking: ChatTrackingHeaders = { orgId: "org-1", userId: "user-1", runId: "run-1" };
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

  it("routes run-less calls to POST /internal/platform-complete with x-api-key only and no maxTokens", async () => {
    const fetchMock = mockFetchOk();
    vi.stubGlobal("fetch", fetchMock);

    // Backfill/migration caller: org is known but there is no inbound run id.
    const tracking: ChatTrackingHeaders = { orgId: "org-1", userId: "user-1" };
    const res = await chatComplete(PARAMS, tracking);
    expect(res.model).toBe("claude-sonnet");

    const [url, init] = (fetchMock as any).mock.calls[0];
    expect(url).toBe("https://chat.test/internal/platform-complete");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("chat-key");
    // No org/user/run identity is sent on the platform path.
    expect(headers["x-org-id"]).toBeUndefined();
    expect(headers["x-user-id"]).toBeUndefined();
    expect(headers["x-run-id"]).toBeUndefined();
    const body = JSON.parse(init.body as string);
    // platform-complete has no maxTokens field in chat-service's request schema.
    expect(body.maxTokens).toBeUndefined();
    // The actual completion params still travel.
    expect(body.message).toBe("build filters");
    expect(body.responseFormat).toBe("json");
    expect(body.temperature).toBe(0.2);
  });

  it("propagates the endpoint path in the error message (fail loud)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => ({}),
      text: async () => "boom",
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    await expect(chatComplete(PARAMS, { orgId: "org-1" })).rejects.toThrow(
      /POST \/internal\/platform-complete returned 502: boom/,
    );
  });
});
