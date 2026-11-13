import { describe, it, expect, vi, afterEach } from "vitest";
import { decideWithScript, emailFoundContent, toRecordedDecision } from "../../src/lib/email-verify-script.js";

/**
 * EMAIL-VERIFY-PROBE-FLAG-1113: the script must know a reveal-gate PROBE (a random address nobody owns) from a real
 * address. A probe's material says `domainProbe: true`; a real address's material is byte-identical to before (no key,
 * never `false`). The recorded-decisions feed states the same fact on a probe's row.
 */
const HELD = { verificationId: "ver-1", verifier: "bounceverify", verdict: "unknown" };

describe("emailFoundContent", () => {
  it("a real address: exactly the old material, no probe key", () => {
    expect(JSON.stringify(emailFoundContent({ email: "ada@example.com", held: null }))).toBe('{"email":"ada@example.com","held":null}');
    expect(JSON.stringify(emailFoundContent({ email: "ada@example.com", held: HELD, domainProbe: false }))).toBe(JSON.stringify({ email: "ada@example.com", held: HELD }));
  });
  it("a probe: says so", () => {
    expect(emailFoundContent({ email: "zz-probe-1@example.com", held: null, domainProbe: true })).toEqual({ email: "zz-probe-1@example.com", held: null, domainProbe: true });
  });
});

describe("decideWithScript sends the material", () => {
  afterEach(() => vi.unstubAllGlobals());
  async function sentContent(domainProbe?: boolean) {
    process.env.WORKFLOW_SERVICE_URL = "http://workflow";
    process.env.WORKFLOW_SERVICE_API_KEY = "k";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "made", runId: "r", scriptSlug: "s", unit: { content: { verificationId: "ver-9" } } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await decideWithScript({ dynasty: "dy", orgId: "o", userId: "u", callerRunId: "run-1", tracking: {}, email: "a@b.co", held: null, ...(domainProbe === undefined ? {} : { domainProbe }) });
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    return body.units.email_found.content;
  }
  it("real address (flag absent or false): no key", async () => {
    expect(await sentContent()).toEqual({ email: "a@b.co", held: null });
    expect(await sentContent(false)).toEqual({ email: "a@b.co", held: null });
  });
  it("probe: domainProbe true", async () => {
    expect(await sentContent(true)).toEqual({ email: "a@b.co", held: null, domainProbe: true });
  });
});

describe("toRecordedDecision (the recorded feed)", () => {
  const at = new Date("2026-11-13T10:00:00Z");
  it("a probe decision carries domainProbe: true", () => {
    expect(toRecordedDecision({ seq: 1, source: "reveal-domain-probe", createdAt: at })).toEqual({ seq: 1, source: "reveal-domain-probe", createdAt: "2026-11-13T10:00:00.000Z", domainProbe: true });
  });
  it("any other decision is served as before, no key", () => {
    expect(toRecordedDecision({ seq: 2, source: "enrich", createdAt: at })).toEqual({ seq: 2, source: "enrich", createdAt: "2026-11-13T10:00:00.000Z" });
    expect(toRecordedDecision({ seq: 3, source: null, createdAt: at })).toEqual({ seq: 3, source: null, createdAt: "2026-11-13T10:00:00.000Z" });
  });
});
