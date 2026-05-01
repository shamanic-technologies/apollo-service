import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests that Apollo API request_id values (large integers exceeding
 * Number.MAX_SAFE_INTEGER) are preserved as exact strings, not truncated
 * by JavaScript's JSON.parse float64 precision loss.
 */

// A request_id that exceeds MAX_SAFE_INTEGER — same scale as production values
const LARGE_REQUEST_ID = "8077309953735459564";
const NEGATIVE_LARGE_REQUEST_ID = "-6622021357417469002";

const MOCK_PERSON = {
  id: "person-1",
  first_name: "Jane",
  last_name: "Doe",
  name: "Jane Doe",
  email: "",
  email_status: "unavailable",
  title: "CEO",
  linkedin_url: "https://linkedin.com/in/janedoe",
};

/** Create a mock fetch that returns raw JSON with a numeric request_id */
function mockFetchWithNumericRequestId(requestId: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    // Return raw text with numeric request_id (not quoted) — this is what Apollo does
    text: () =>
      Promise.resolve(
        `{"person":${JSON.stringify(MOCK_PERSON)},"matches":[${JSON.stringify(MOCK_PERSON)}],"waterfall":{"status":"accepted"},"request_id":${requestId}}`
      ),
    json: () => {
      // Standard JSON.parse loses precision on large integers
      const raw = `{"person":${JSON.stringify(MOCK_PERSON)},"matches":[${JSON.stringify(MOCK_PERSON)}],"waterfall":{"status":"accepted"},"request_id":${requestId}}`;
      return Promise.resolve(JSON.parse(raw));
    },
  });
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.resetModules();
});

describe("request_id precision preservation", () => {
  it("enrichPerson preserves large positive request_id", async () => {
    global.fetch = mockFetchWithNumericRequestId(LARGE_REQUEST_ID);
    const { enrichPerson } = await import("../../src/lib/apollo-client.js");
    const result = await enrichPerson("test-key", "person-1", "https://webhook.test");

    expect(String(result.request_id)).toBe(LARGE_REQUEST_ID);
  });

  it("matchPersonByName preserves large positive request_id", async () => {
    global.fetch = mockFetchWithNumericRequestId(LARGE_REQUEST_ID);
    const { matchPersonByName } = await import("../../src/lib/apollo-client.js");
    const result = await matchPersonByName("test-key", "Jane", "Doe", "example.com", "https://webhook.test");

    expect(String(result.request_id)).toBe(LARGE_REQUEST_ID);
  });

  it("bulkEnrichPeople preserves large negative request_id", async () => {
    global.fetch = mockFetchWithNumericRequestId(NEGATIVE_LARGE_REQUEST_ID);
    const { bulkEnrichPeople } = await import("../../src/lib/apollo-client.js");
    const result = await bulkEnrichPeople("test-key", ["person-1"], "https://webhook.test");

    expect(String(result.request_id)).toBe(NEGATIVE_LARGE_REQUEST_ID);
  });

  it("standard JSON.parse loses precision (proving the bug exists)", () => {
    const raw = `{"request_id":${LARGE_REQUEST_ID}}`;
    const parsed = JSON.parse(raw);
    // Without the fix, JS truncates the number
    expect(String(parsed.request_id)).not.toBe(LARGE_REQUEST_ID);
  });
});
