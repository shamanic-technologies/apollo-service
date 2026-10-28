import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * LI-ENGAGEMENT-NEVER-DONE-1029: a competitor page no provider can read
 * (not_found / unreadable, remembered a day) never keeps a harvest incomplete;
 * a transient failure still does. Beyond Logic's diffco-us (scrapecreators 404,
 * tikhub 400 on every page, harvestapi "Company not found") kept its audience
 * answering "nothing yet, not done" to ~18k serves an hour.
 */

// Page rows answered in the order harvest asks for them (one per page), then the due-posts query.
const pageRows: Array<Record<string, unknown> | undefined> = [];
const fetchMock = vi.fn();
vi.mock("../../src/db/index.js", () => ({
  db: {
    select: vi.fn().mockImplementation(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(pageRows.length ? [pageRows.shift()].filter(Boolean) : []),
          orderBy: () => Promise.resolve([]),
        }),
      }),
    })),
  },
}));

import { harvest, blocksCompletion, freshPostsOutcome, LinkedinCompetitorPagesUnreadableError, type EngagementMeter } from "../../src/lib/linkedin-engagement.js";
import { parseCompetitorPage } from "../../src/lib/linkedin-engagement-spec.js";

const now = new Date("2026-10-28T20:30:00Z");
const fetchedAt = new Date("2026-10-28T12:00:00Z");
const spec = { type: "linkedin_engagement", window_days: 30, competitor_pages: [] } as never;
const meter = { call: (...a: unknown[]) => fetchMock(...a) } as unknown as EngagementMeter;
const page = (slug: string) => parseCompetitorPage(`https://www.linkedin.com/company/${slug}/`)!;

const readable = (slug: string) => ({ slug, postsFetchedAt: fetchedAt, postsStatus: "ok", postsFailedAt: null });
const unreadable = (slug: string) => ({ slug, postsFetchedAt: fetchedAt, postsStatus: "unreadable", postsError: "scrapecreators 404 | tikhub 400 | harvestapi not found", postsFailedAt: null });
const failedAnHourAgo = (slug: string) => ({ slug, postsFetchedAt: null, postsStatus: null, postsFailedAt: new Date(now.getTime() - 10 * 60_000), postsFailure: "tikhub 503" });

describe("harvest completeness", () => {
  beforeEach(() => {
    pageRows.length = 0;
    fetchMock.mockReset();
  });

  it("an unreadable page beside readable ones: complete (the serve can end), no provider called", async () => {
    pageRows.push(readable("rapidops-inc"), readable("airdev"), unreadable("diffco-us"));
    const out = await harvest(meter, [page("rapidops-inc"), page("airdev"), page("diffco-us")], spec, now, Date.now() + 60_000);
    expect(out.complete).toBe(true);
    expect(out.skipped).toEqual([{ page: "https://www.linkedin.com/company/diffco-us/", state: "unreadable", reason: expect.stringContaining("tikhub 400") }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a page that failed transiently keeps the harvest incomplete (retried later)", async () => {
    pageRows.push(readable("rapidops-inc"), readable("airdev"), failedAnHourAgo("diffco-us"));
    const out = await harvest(meter, [page("rapidops-inc"), page("airdev"), page("diffco-us")], spec, now, Date.now() + 60_000);
    expect(out.complete).toBe(false);
    expect(out.skipped[0].state).toBe("failed");
  });

  it("every page unreadable: a PERMANENT refusal (422), never a retryable one", async () => {
    pageRows.push(unreadable("diffco-us"));
    const err = await harvest(meter, [page("diffco-us")], spec, now, Date.now() + 60_000).catch((e) => e);
    expect(err).toBeInstanceOf(LinkedinCompetitorPagesUnreadableError);
    expect(err.permanent).toBe(true);
  });

  it("an unreadable page is remembered for the refresh day, then read again", () => {
    const p = page("diffco-us");
    expect(freshPostsOutcome(unreadable("diffco-us") as never, p, now)).toMatchObject({ state: "unreadable" });
    expect(freshPostsOutcome(unreadable("diffco-us") as never, p, new Date(fetchedAt.getTime() + 25 * 3_600_000))).toBeNull();
    expect(blocksCompletion({ page: p, state: "unreadable", reason: "x" })).toBe(false);
    expect(blocksCompletion({ page: p, state: "not_found", reason: "x" })).toBe(false);
    expect(blocksCompletion({ page: p, state: "failed", reason: "x" })).toBe(true);
  });
});
