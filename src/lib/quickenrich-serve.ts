/**
 * The QuickEnrich serve path: the per-audience switch, the free search walk
 * (bronze + silver), and the identity lookup /enrich uses before it pays for
 * an email find. Pure rules live in ./quickenrich.ts.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { apolloAudiences, apolloSearchCursors, quickenrichPeople, quickenrichSearches } from "../db/schema.js";
import { decryptKey, type TrackingContext } from "./keys-client.js";
import {
  QUICKENRICH_PAGE_SIZE,
  QUICKENRICH_SEARCH_URL,
  quickenrichToPerson,
  rowMatchesPlan,
  type QuickenrichPlan,
  type QuickenrichRow,
} from "./quickenrich.js";

/**
 * Pages walked per /search/next call when every row on a page is filtered out
 * (wrong state, wrong title). Free, but QuickEnrich allows 120 requests/min;
 * the caller keeps paging while `done` is false, so the bound only caps one
 * request's latency (~60ms per page).
 */
export const QUICKENRICH_MAX_PAGES_PER_CALL = 5;

const SEARCH_TIMEOUT_MS = 30_000;

export class QuickenrichSearchError extends Error {
  constructor(message: string) {
    super(`quickenrich search failed: ${message}`);
    this.name = "QuickenrichSearchError";
  }
}

/**
 * The audience switched to QuickEnrich whose filters are EXACTLY this filter
 * set, or null. human-service forwards an audience's stored filters verbatim
 * as /search/next's searchParams (they are the apollo_audiences row's filters),
 * so jsonb equality is the audience's identity on this route.
 */
export async function findQuickenrichAudience(orgId: string, params: Record<string, unknown>): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: apolloAudiences.id })
    .from(apolloAudiences)
    .where(
      and(
        eq(apolloAudiences.orgId, orgId),
        eq(apolloAudiences.serveSource, "quickenrich"),
        sql`${apolloAudiences.filters} = ${JSON.stringify(params)}::jsonb`
      )
    )
    .limit(1);
  return row ?? null;
}

interface SearchPage {
  rows: QuickenrichRow[];
  nextCursor: string | null;
  hasMore: boolean;
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/**
 * One QuickEnrich page through treg. Written to bronze whatever happens. Fails
 * loud on a non-200 AND on any charge other than 0: the search is free, no
 * cost name exists for it, and a charge we cannot declare must not pass.
 */
async function searchPage(
  token: string,
  tregOrg: string,
  body: Record<string, unknown>,
  bronze: { orgId: string; runId?: string; campaignId?: string; cursorId: string; apolloAudienceId: string }
): Promise<SearchPage> {
  const started = Date.now();
  let httpStatus: number | null = null;
  let responseHeaders: Record<string, string> | null = null;
  let responseBody: unknown = null;
  let chargedMicro: number | null = null;
  let error: string | null = null;
  let page: SearchPage | null = null;
  try {
    const response = await fetch(QUICKENRICH_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Treg-Token": token,
        "X-Treg-Org": tregOrg,
        // A cursor is a position in a live result set; never replay an archived page.
        "Cache-Control": "no-cache",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    httpStatus = response.status;
    responseHeaders = headersToObject(response.headers);
    const text = await response.text();
    try {
      responseBody = text ? JSON.parse(text) : null;
    } catch {
      responseBody = { _raw: text };
    }
    const costHeader = responseHeaders["x-treg-cost-micro"];
    chargedMicro = costHeader === undefined || costHeader.trim() === "" ? null : Number(costHeader);
    if (response.status !== 200) {
      throw new QuickenrichSearchError(`HTTP ${response.status} - ${JSON.stringify(responseBody).slice(0, 500)}`);
    }
    if (chargedMicro === null || !Number.isFinite(chargedMicro)) {
      throw new QuickenrichSearchError(`treg reported no X-Treg-Cost-Micro for a search that must be free (got ${JSON.stringify(costHeader)})`);
    }
    if (chargedMicro !== 0) {
      throw new QuickenrichSearchError(`treg charged ${chargedMicro} micro-USD for a search that must be free; no cost name exists to declare it`);
    }
    const parsed = responseBody as { data?: unknown; meta?: { next_cursor?: unknown; has_more?: unknown } } | null;
    if (!parsed || !Array.isArray(parsed.data)) {
      throw new QuickenrichSearchError(`unexpected body shape: ${JSON.stringify(responseBody).slice(0, 300)}`);
    }
    const nextCursor = typeof parsed.meta?.next_cursor === "string" && parsed.meta.next_cursor ? parsed.meta.next_cursor : null;
    page = { rows: parsed.data as QuickenrichRow[], nextCursor, hasMore: parsed.meta?.has_more === true && nextCursor !== null };
    return page;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    throw err instanceof QuickenrichSearchError ? err : new QuickenrichSearchError(error);
  } finally {
    await db.insert(quickenrichSearches).values({
      orgId: bronze.orgId,
      runId: bronze.runId,
      campaignId: bronze.campaignId,
      cursorId: bronze.cursorId,
      apolloAudienceId: bronze.apolloAudienceId,
      requestBody: body,
      httpStatus,
      responseHeaders,
      responseBody: responseBody as object | null,
      chargedMicro,
      rowsReturned: page ? page.rows.length : null,
      error,
      durationMs: Date.now() - started,
    });
  }
}

async function upsertPeople(rows: QuickenrichRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(quickenrichPeople)
    .values(
      rows.map((r) => ({
        empId: String(r.emp_id),
        firstName: r.first_name ?? null,
        lastName: r.last_name ?? null,
        title: r.title ?? null,
        linkedinUrl: r.employee_linkedin ?? null,
        companyDomain: r.company_url ?? null,
        companyName: r.company_name ?? null,
        locality: r.locality ?? null,
        raw: r as object,
      }))
    )
    .onConflictDoUpdate({
      target: quickenrichPeople.empId,
      set: {
        firstName: sql`excluded.first_name`,
        lastName: sql`excluded.last_name`,
        title: sql`excluded.title`,
        linkedinUrl: sql`excluded.linkedin_url`,
        companyDomain: sql`excluded.company_domain`,
        companyName: sql`excluded.company_name`,
        locality: sql`excluded.locality`,
        raw: sql`excluded.raw`,
        lastSeenAt: new Date(),
      },
    });
}

export type QuickenrichPerson = ReturnType<typeof quickenrichToPerson>;

export interface QuickenrichServeResult {
  people: QuickenrichPerson[];
  /** True once QuickEnrich has nobody left for this filter set. */
  exhausted: boolean;
  pagesRead: number;
  rowsSeen: number;
  rejected: Record<string, number>;
}

/**
 * Walk the QuickEnrich cursor stored on the Apollo cursor row until a page
 * yields people who satisfy every constraint, or QuickEnrich runs dry, or the
 * per-call page bound is hit. Free. The kept rows go to silver so /enrich can
 * resolve `qe:<emp_id>` without searching again.
 */
export async function serveQuickenrichPage(args: {
  orgId: string;
  userId: string;
  runId?: string;
  campaignId?: string;
  cursorId: string;
  apolloAudienceId: string;
  plan: QuickenrichPlan;
  tracking: TrackingContext;
}): Promise<QuickenrichServeResult> {
  const [cursor] = await db
    .select({
      quickenrichCursor: apolloSearchCursors.quickenrichCursor,
      quickenrichPages: apolloSearchCursors.quickenrichPages,
      quickenrichExhausted: apolloSearchCursors.quickenrichExhausted,
    })
    .from(apolloSearchCursors)
    .where(eq(apolloSearchCursors.id, args.cursorId))
    .limit(1);
  if (!cursor) throw new Error(`search cursor ${args.cursorId} vanished`);
  const result: QuickenrichServeResult = { people: [], exhausted: cursor.quickenrichExhausted, pagesRead: 0, rowsSeen: 0, rejected: {} };
  if (cursor.quickenrichExhausted) return result;

  const caller = { callerMethod: "POST", callerPath: "/search/next" };
  const { key: token } = await decryptKey(args.orgId, args.userId, "treg", caller, args.tracking);
  const { key: tregOrg } = await decryptKey(args.orgId, args.userId, "treg-org", caller, args.tracking);

  let nextCursor = cursor.quickenrichCursor;
  let pages = cursor.quickenrichPages;
  // A walk with pages behind it and no cursor has nothing left.
  if (pages > 0 && !nextCursor) {
    await db.update(apolloSearchCursors).set({ quickenrichExhausted: true, updatedAt: new Date() }).where(eq(apolloSearchCursors.id, args.cursorId));
    return { ...result, exhausted: true };
  }

  for (let i = 0; i < QUICKENRICH_MAX_PAGES_PER_CALL; i++) {
    const body = { ...args.plan.body, per_page: QUICKENRICH_PAGE_SIZE, ...(nextCursor ? { cursor: nextCursor } : { page: 1 }) };
    const page = await searchPage(token, tregOrg, body, {
      orgId: args.orgId,
      runId: args.runId,
      campaignId: args.campaignId,
      cursorId: args.cursorId,
      apolloAudienceId: args.apolloAudienceId,
    });
    result.pagesRead++;
    result.rowsSeen += page.rows.length;
    const kept: QuickenrichRow[] = [];
    for (const row of page.rows) {
      const verdict = rowMatchesPlan(row, args.plan);
      if (verdict.keep) kept.push(row);
      else result.rejected[verdict.reason] = (result.rejected[verdict.reason] ?? 0) + 1;
    }
    await upsertPeople(kept);
    result.people.push(...kept.map((r) => quickenrichToPerson(r)));

    pages++;
    nextCursor = page.hasMore ? page.nextCursor : null;
    const exhausted = nextCursor === null;
    await db
      .update(apolloSearchCursors)
      .set({ quickenrichCursor: nextCursor, quickenrichPages: pages, quickenrichExhausted: exhausted, updatedAt: new Date() })
      .where(eq(apolloSearchCursors.id, args.cursorId));
    if (exhausted) {
      result.exhausted = true;
      return result;
    }
    if (kept.length > 0) return result;
  }
  return result;
}

/** The QuickEnrich person /enrich was asked for, from silver. */
export async function loadQuickenrichPerson(empId: string): Promise<QuickenrichRow | null> {
  const [row] = await db.select({ raw: quickenrichPeople.raw }).from(quickenrichPeople).where(eq(quickenrichPeople.empId, empId)).limit(1);
  return row ? (row.raw as QuickenrichRow) : null;
}
