/**
 * The free people-source walk (APOLLO-ZERO-COST-1119): Leadsforge, then
 * Dropleads, each on its own columns of the filter set's cursor row, before
 * QuickEnrich and Apollo. Pure rules live in ./free-people-sources.ts.
 *
 * Every call goes through treg and is asserted FREE (`X-Treg-Cost-Micro: 0`):
 * no cost name exists for these searches, so a charge we cannot declare fails
 * loud (bronze-recorded) and the caller falls through to the next source.
 */

import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { apolloSearchCursors, freeSourcePeople, freeSourceSearches } from "../db/schema.js";
import { decryptKey, type TrackingContext } from "./keys-client.js";
import { errorMessage } from "./db-error.js";
import { applyCompanyStock, loadCompanyStock } from "./company-stock.js";
import { normalizeDomain } from "./email-finders.js";
import {
  freeSourceToPerson,
  isServable,
  normalizeDropleadsRow,
  normalizeLeadsforgeRow,
  planDropleads,
  planLeadsforge,
  type FreeSource,
  type FreeSourcePerson,
  type SourcePlan,
} from "./free-people-sources.js";

const TREG_CALL = "https://treg.to/call";
const SEARCH_TIMEOUT_MS = 30_000;
/** Pages per source per /search/next call when every row is unservable (free; bounds latency). */
export const FREE_SOURCE_MAX_PAGES_PER_CALL = 3;
const LEADSFORGE_PAGE = 50;
const DROPLEADS_PAGE = 50;

export class FreeSourceSearchError extends Error {
  constructor(readonly source: FreeSource, message: string) {
    super(`${source} search failed: ${message}`);
    this.name = "FreeSourceSearchError";
  }
}

export function planFreeSources(filters: Record<string, unknown>): SourcePlan[] {
  return [planLeadsforge(filters), planDropleads(filters)];
}

interface Page {
  rows: FreeSourcePerson[];
  rawRows: Array<Record<string, unknown>>;
  next: string | null;
}

async function callSource(
  source: FreeSource,
  token: string,
  tregOrg: string,
  filters: Record<string, unknown>,
  position: { cursor: string | null; page: number },
  bronze: { orgId: string; runId?: string; campaignId?: string; cursorId: string; apolloAudienceId: string | null }
): Promise<Page> {
  const url =
    source === "leadsforge"
      ? `${TREG_CALL}/leadsforge.people.search${position.cursor ? `?cursor=${encodeURIComponent(position.cursor)}` : ""}`
      : `${TREG_CALL}/dropleads.people.search`;
  const body =
    source === "leadsforge"
      ? { ...filters, limit: LEADSFORGE_PAGE }
      : { filters, pagination: { page: position.page, limit: DROPLEADS_PAGE } };
  const started = Date.now();
  let httpStatus: number | null = null;
  let responseBody: unknown = null;
  let chargedMicro: number | null = null;
  let error: string | null = null;
  let page: Page | null = null;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Treg-Token": token, "X-Treg-Org": tregOrg, "Cache-Control": "no-cache" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    httpStatus = response.status;
    const text = await response.text();
    try {
      responseBody = text ? JSON.parse(text) : null;
    } catch {
      responseBody = { _raw: text };
    }
    const costHeader = response.headers.get("x-treg-cost-micro");
    chargedMicro = costHeader === null || costHeader.trim() === "" ? null : Number(costHeader);
    if (response.status !== 200) throw new FreeSourceSearchError(source, `HTTP ${response.status} - ${JSON.stringify(responseBody).slice(0, 400)}`);
    if (chargedMicro === null || !Number.isFinite(chargedMicro)) throw new FreeSourceSearchError(source, `treg reported no X-Treg-Cost-Micro (got ${JSON.stringify(costHeader)})`);
    if (chargedMicro !== 0) throw new FreeSourceSearchError(source, `treg charged ${chargedMicro} micro-USD for a search that must be free`);
    const parsed = responseBody as Record<string, any>;
    if (source === "leadsforge") {
      const leads = Array.isArray(parsed?.leads) ? (parsed.leads as Array<Record<string, unknown>>) : null;
      if (!leads) throw new FreeSourceSearchError(source, `unexpected body: ${JSON.stringify(responseBody).slice(0, 300)}`);
      const cursor = typeof parsed.cursor === "string" && parsed.cursor ? parsed.cursor : null;
      page = { rawRows: leads, rows: leads.map(normalizeLeadsforgeRow).filter((p): p is FreeSourcePerson => p !== null), next: leads.length > 0 ? cursor : null };
    } else {
      const leads = Array.isArray(parsed?.data?.leads) ? (parsed.data.leads as Array<Record<string, unknown>>) : null;
      if (!leads) throw new FreeSourceSearchError(source, `unexpected body: ${JSON.stringify(responseBody).slice(0, 300)}`);
      const totalPages = Number(parsed?.pagination?.totalPages ?? parsed?.data?.pagination?.totalPages ?? 0);
      page = { rawRows: leads, rows: leads.map(normalizeDropleadsRow).filter((p): p is FreeSourcePerson => p !== null), next: leads.length > 0 && position.page < totalPages ? String(position.page + 1) : null };
    }
    return page;
  } catch (err) {
    error = errorMessage(err);
    throw err instanceof FreeSourceSearchError ? err : new FreeSourceSearchError(source, error);
  } finally {
    await db.insert(freeSourceSearches).values({
      orgId: bronze.orgId,
      runId: bronze.runId,
      campaignId: bronze.campaignId,
      cursorId: bronze.cursorId,
      apolloAudienceId: bronze.apolloAudienceId,
      source,
      requestBody: body,
      httpStatus,
      responseBody: responseBody as object | null,
      chargedMicro,
      rowsReturned: page ? page.rawRows.length : null,
      error,
      durationMs: Date.now() - started,
    });
  }
}

async function upsertPeople(rows: Array<{ person: FreeSourcePerson; raw: Record<string, unknown> }>): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(freeSourcePeople)
    .values(
      rows.map(({ person, raw }) => ({
        source: person.source,
        externalId: person.externalId,
        firstName: person.firstName,
        lastName: person.lastName,
        title: person.title,
        linkedinUrl: person.linkedinUrl,
        companyName: person.companyName,
        companyDomain: person.companyDomain,
        raw,
      }))
    )
    .onConflictDoUpdate({
      target: [freeSourcePeople.source, freeSourcePeople.externalId],
      set: {
        firstName: sql`excluded.first_name`,
        lastName: sql`excluded.last_name`,
        title: sql`excluded.title`,
        linkedinUrl: sql`excluded.linkedin_url`,
        companyName: sql`excluded.company_name`,
        companyDomain: sql`excluded.company_domain`,
        raw: sql`excluded.raw`,
        lastSeenAt: new Date(),
      },
    });
}

export interface FreeServeResult {
  people: Array<ReturnType<typeof freeSourceToPerson>>;
  source: FreeSource | null;
  /** Every free source this filter set can use has nobody left (or none applies). */
  exhausted: boolean;
  pagesRead: number;
  /** Sources skipped for this filter set, with why (named, never silent). */
  skipped: Array<{ source: FreeSource; reasons: string[] }>;
  leftToJudge: string[];
  failed: Array<{ source: FreeSource; error: string }>;
}

/**
 * One /search/next call's worth of free people: the first source with a plan
 * that is not walked out yet. A vendor failure skips THAT source for this call
 * (bronze-recorded, returned in `failed`) and the next one answers.
 */
export async function serveFreePeoplePage(args: {
  orgId: string;
  userId: string;
  runId?: string;
  campaignId?: string;
  cursorId: string;
  apolloAudienceId: string | null;
  filters: Record<string, unknown>;
  tracking: TrackingContext;
}): Promise<FreeServeResult> {
  const plans = planFreeSources(args.filters);
  const result: FreeServeResult = { people: [], source: null, exhausted: true, pagesRead: 0, skipped: [], leftToJudge: [], failed: [] };
  for (const p of plans) if (!p.ok) result.skipped.push({ source: p.source, reasons: p.reasons });
  const usable = plans.filter((p): p is Extract<SourcePlan, { ok: true }> => p.ok);
  if (usable.length === 0) return result;

  const [cursor] = await db.select().from(apolloSearchCursors).where(eq(apolloSearchCursors.id, args.cursorId)).limit(1);
  if (!cursor) throw new Error(`search cursor ${args.cursorId} vanished`);

  const caller = { callerMethod: "POST", callerPath: "/search/next" };
  const { key: token } = await decryptKey(args.orgId, args.userId, "treg", caller, args.tracking);
  const { key: tregOrg } = await decryptKey(args.orgId, args.userId, "treg-org", caller, args.tracking);
  const bronze = { orgId: args.orgId, runId: args.runId, campaignId: args.campaignId, cursorId: args.cursorId, apolloAudienceId: args.apolloAudienceId };

  for (const plan of usable) {
    const isLf = plan.source === "leadsforge";
    let exhausted = isLf ? cursor.leadsforgeExhausted : cursor.dropleadsExhausted;
    if (exhausted) continue;
    let lfCursor = cursor.leadsforgeCursor;
    let pages = isLf ? cursor.leadsforgePages : cursor.dropleadsPages;
    if (isLf && pages > 0 && !lfCursor) exhausted = true;
    try {
      for (let i = 0; i < FREE_SOURCE_MAX_PAGES_PER_CALL && !exhausted; i++) {
        const page = await callSource(plan.source, token, tregOrg, plan.filters, { cursor: lfCursor, page: pages + 1 }, bronze);
        result.pagesRead++;
        pages++;
        const servable = page.rows.map((person, idx) => ({ person, raw: page.rawRows[idx] })).filter(({ person }) => isServable(person));
        await upsertPeople(servable);
        if (isLf) lfCursor = page.next;
        exhausted = page.next === null;
        await db
          .update(apolloSearchCursors)
          .set(isLf ? { leadsforgeCursor: lfCursor, leadsforgePages: pages, leadsforgeExhausted: exhausted, updatedAt: new Date() } : { dropleadsPages: pages, dropleadsExhausted: exhausted, updatedAt: new Date() })
          .where(eq(apolloSearchCursors.id, args.cursorId));
        if (servable.length > 0) {
          const stock = await loadCompanyStock(servable.map(({ person }) => person.companyDomain));
          result.people = servable.map(({ person }) => applyCompanyStock(freeSourceToPerson(person), stock.get(normalizeDomain(person.companyDomain ?? "")) ?? null));
          result.source = plan.source;
          result.leftToJudge = plan.leftToJudge;
          result.exhausted = false;
          return result;
        }
      }
    } catch (error) {
      if (!(error instanceof FreeSourceSearchError)) throw error;
      result.failed.push({ source: plan.source, error: error.message });
      // A source that failed this call is not walked out: the caller must not read `done`.
      result.exhausted = false;
      continue;
    }
    if (!exhausted) {
      // Pages read, nobody servable yet, more to read: not done, the next call goes on.
      result.exhausted = false;
      return result;
    }
  }
  return result;
}

/** A free-source person /enrich was asked for, from silver. */
export async function loadFreeSourcePerson(source: FreeSource, externalId: string): Promise<FreeSourcePerson | null> {
  const [row] = await db
    .select({ raw: freeSourcePeople.raw })
    .from(freeSourcePeople)
    .where(sql`${freeSourcePeople.source} = ${source} AND ${freeSourcePeople.externalId} = ${externalId}`)
    .limit(1);
  if (!row) return null;
  const raw = row.raw as Record<string, unknown>;
  return source === "leadsforge" ? normalizeLeadsforgeRow(raw) : normalizeDropleadsRow(raw);
}
