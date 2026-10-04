/**
 * The linkedin_engagement buying signal: people who recently reacted to or
 * commented on a competitor's LinkedIn company posts (the "Gojiberry"
 * signal). Pure rules and the wire facts live in ./linkedin-engagement-spec.ts.
 *
 * Flow, all through treg (one token, one cost name):
 *   /search/next  harvest  → each competitor page's posts from the first
 *                            provider of POSTS_PROVIDERS that answers
 *                            (./linkedin-company-posts.ts; re-listed at most
 *                            once a day; a page no provider knows is skipped),
 *                            then
 *                            `fetchinio.linkedin.post.engagement` per post in
 *                            the window (re-read at most once a day, paged)
 *                 serve    → each unconsidered engager is CLAIMED for the
 *                            audience (unique row: never twice), its profile
 *                            resolved (`treg.linkedin.user.profile`, cached 30
 *                            days) and competitor employees dropped; the rest
 *                            come back as teasers (name, title, headline,
 *                            employer) for the consumer's screen
 *   /enrich li:<id>       → treg email find on the public profile URL (+ name
 *                            and company domain when known), then the
 *                            verifier, exactly like the QuickEnrich branch
 *
 * Layering:
 *   bronze → `linkedin_treg_calls` (every call verbatim, with its charge)
 *   silver → `linkedin_company_pages`, `linkedin_company_posts`,
 *            `linkedin_post_engagements`, `linkedin_profiles` (global facts)
 *   gold   → `linkedin_engagement_serves` (org data: who an audience got)
 *
 * Money: every treg call is metered on a `linkedin-engagement` child run of
 * the caller's run: PROVISION the call's ceiling → AUTHORIZE it (platform key)
 * → EXECUTE → post treg's own `X-Treg-Cost-Micro` as `actual` → cancel the
 * hold. Cost name `treg-micro-usd` (quantity = micro-USD), the same as the
 * email find. Silver is global, so a page or post already read today, or a
 * profile resolved in the last 30 days, is never paid again, whoever asks.
 */
import { and, desc, eq, gte, inArray, isNotNull, lt, max, notExists, or, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  linkedinCompanyPages,
  linkedinCompanyPosts,
  linkedinEngagementServes,
  linkedinPostEngagements,
  linkedinProfiles,
  linkedinTregCalls,
} from "../db/schema.js";
import { advisoryXactLock } from "./advisory-lock.js";
import { authorizeCredit } from "./billing-client.js";
import { decryptKey, type TrackingContext } from "./keys-client.js";
import { addCosts, createRun, updateCostStatus, updateRun, type IdentityHeaders } from "./runs-client.js";
import { assertKeySource } from "./validators.js";
import { TREG_COST_NAME, isTregRoutedMiss } from "./email-finders.js";
import { canonicalLinkedinUrl } from "./quickenrich.js";
import type { BuyingSignalSpec } from "./buying-signal-spec.js";
import {
  MAX_COMPETITOR_PAGES,
  engagementEvidence,
  engagementRows,
  isPublicProfileUrl,
  linkedinEngagerToPerson,
  parseCompetitorPage,
  prospectRejection,
  toResolvedProfile,
  type CompetitorPage,
  type ResolvedProfile,
  type WireEngagement,
  type WirePost,
} from "./linkedin-engagement-spec.js";
import { POSTS_PROVIDERS, postsVerdict, type PostsProvider } from "./linkedin-company-posts.js";

const TREG_BASE = "https://treg.to/call/";
export const ENGAGEMENT_ENDPOINT = "fetchinio.linkedin.post.engagement";
export const PROFILE_ENDPOINT = "treg.linkedin.user.profile";

/** Ceilings per call, micro-USD (posts: per provider, in POSTS_PROVIDERS). Engagement: Fetchin $0.003 flat. Profile: $0.0012-0.004 children. */
export const ENGAGEMENT_MAX_MICRO = 3_000;
export const PROFILE_MAX_MICRO = 5_000;

export const POSTS_REFRESH_MS = 24 * 3_600_000;
export const ENGAGEMENT_REFRESH_MS = 24 * 3_600_000;
export const PROFILE_CACHE_MS = 30 * 86_400_000;
/** 100 reactions + 100 comments per page; 5 pages = up to 500 of each per post per day. */
export const MAX_ENGAGEMENT_PAGES_PER_POST = 5;
export const ENGAGEMENT_PAGE_SIZE = 100;
/**
 * Engagers claimed and resolved per /search/next call; every one that passes
 * comes back (the consumer buffers a page and screens it teaser by teaser, so
 * a fuller page means fewer round trips). Resolved PROFILE_CONCURRENCY at a time.
 */
export const MAX_PROFILE_LOOKUPS_PER_CALL = 20;
export const PROFILE_CONCURRENCY = 5;
/** Posts whose engagement is read at once (each holds a DB transaction: the pool is 10). */
export const HARVEST_CONCURRENCY = 3;
/**
 * treg routes a profile lookup cheapest first and tried anyapi before
 * fetchinio on every call: anyapi missed 62 of 62 in prod (2026-10-03) and the
 * miss cost 8-10s, so a lookup took ~10s instead of ~2s for the same answer
 * and the same price. Re-measure before removing (a 2-call A/B is enough).
 */
export const PROFILE_ROUTE_EXCLUDE = "anyapi";
/** Harvest stops starting new calls past this; the next serve resumes (done stays false). */
export const HARVEST_BUDGET_MS = 25_000;
const CALL_TIMEOUT_MS = 60_000;
/**
 * A profile lookup answers in ~2s; the slow ones are treg walking past a
 * rate-limited child (up to ~28s). Past this the lookup is a transient failure
 * for THAT engager, not for the page.
 */
export const PROFILE_CALL_TIMEOUT_MS = 30_000;

/** Run `fn` over `items`, at most `limit` at once; stops starting new ones after a failure and rethrows the first. */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * A failure that says nothing about the engager (timeout, network, rate limit,
 * provider 5xx): the person is released for a later serve, never recorded as
 * unreadable. 10 concurrent lookups drew fetchinio 429s on 2026-10-03.
 */
export class LinkedinTregTransientError extends Error {
  constructor(message: string) {
    super(`linkedin engagement: ${message}`);
    this.name = "LinkedinTregTransientError";
  }
}

export class LinkedinEngagementInsufficientCreditError extends Error {
  constructor(public readonly balanceCents: number, public readonly requiredCents: number) {
    super("Insufficient credits to read LinkedIn engagement");
    this.name = "LinkedinEngagementInsufficientCreditError";
  }
}

/**
 * No competitor page of the signal could be read this serve. `permanent` when
 * every page is one the providers say does not exist (the audience is
 * misconfigured: 422); otherwise some page failed transiently (502, retry).
 */
export class LinkedinCompetitorPagesUnreadableError extends Error {
  constructor(public readonly pages: Array<{ page: string; reason: string }>, public readonly permanent: boolean) {
    super(`linkedin engagement: no competitor page could be read: ${pages.map((p) => `${p.page} (${p.reason})`).join("; ")}`);
    this.name = "LinkedinCompetitorPagesUnreadableError";
  }
}

export class LinkedinTregError extends Error {
  constructor(message: string) {
    super(`linkedin engagement: ${message}`);
    this.name = "LinkedinTregError";
  }
}

// ─── Spec ────────────────────────────────────────────────────────────────────

/** Fields a linkedin_engagement filter set may carry besides the signal (verified email is forced anyway). */
const ALLOWED_BESIDE_SIGNAL = new Set(["buying_signal", "contact_email_status", "contactEmailStatus"]);

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined || v === "" || v === false) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).every(isEmpty);
  return false;
}

/**
 * Apollo targeting filters set beside a linkedin_engagement signal. They
 * cannot be enforced on LinkedIn engagers (they are not an Apollo search), so
 * a set carrying any is refused by name rather than silently ignored: the
 * consumer's screen against the audience description is the targeting.
 */
export function filtersBesideEngagement(filters: Record<string, unknown>): string[] {
  return Object.keys(filters).filter((k) => !ALLOWED_BESIDE_SIGNAL.has(k) && !isEmpty(filters[k]));
}

export function competitorPagesOf(spec: BuyingSignalSpec): CompetitorPage[] {
  const pages = (spec.competitor_pages ?? []).map((u) => parseCompetitorPage(u));
  if (pages.length === 0 || pages.length > MAX_COMPETITOR_PAGES || pages.some((p) => !p)) {
    throw new LinkedinTregError(`competitor_pages must be 1-${MAX_COMPETITOR_PAGES} LinkedIn company page URLs`);
  }
  const bySlug = new Map((pages as CompetitorPage[]).map((p) => [p.slug, p]));
  return [...bySlug.values()];
}

// ─── Metering ────────────────────────────────────────────────────────────────

export interface EngagementContext {
  identity: IdentityHeaders;
  userId: string;
  runId: string;
  tracking: TrackingContext;
  callerPath: string;
}

interface TregAnswer {
  status: number;
  body: Record<string, unknown> | null;
  chargedMicro: number;
}

/**
 * Postgres jsonb and text reject the NUL character, and LinkedIn text carries
 * it (a profile description "Stajyerl\u0000..." failed every serve of an
 * audience, 2026-10-04). It means nothing, so it is dropped from every string
 * a provider relays before anything is stored.
 */
export function stripNul<T>(value: T): T {
  if (typeof value === "string") return value.replace(/\u0000/g, "") as T;
  if (Array.isArray(value)) return value.map(stripNul) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [stripNul(k), stripNul(v)])) as T;
  }
  return value;
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/** A routed call where every child missed (none billed): a real "nobody has this", not a failure. */
export function isRoutedMiss(answer: TregAnswer): boolean {
  return answer.chargedMicro === 0 && isTregRoutedMiss(answer.status, answer.body);
}

/**
 * A child that ERRORED (429, 5xx, timeout) never answered for this person, so a
 * route_failed carrying one is not "nobody has this" even when the others
 * missed: fetchinio, the only child that reads opaque reactor URLs, was
 * rate-limited and the rest missed (2026-10-03).
 */
export function routeHadChildError(answer: TregAnswer): boolean {
  const detail = (answer.body as { detail?: { tried?: Array<{ outcome?: unknown }> } } | null)?.detail;
  return Array.isArray(detail?.tried) && detail!.tried!.some((t) => t?.outcome === "error");
}

/**
 * One child run per request, created on the first paid call. Every call:
 * provision its ceiling, authorize it (platform key), call, write bronze,
 * post the real charge, cancel the hold.
 */
export class EngagementMeter {
  // Promises, not values: calls run concurrently and must share ONE run and one key read.
  private run: Promise<{ id: string }> | null = null;
  private keys: Promise<{ token: string; org: string; keySource: "org" | "platform" }> | null = null;
  calls = 0;
  chargedMicro = 0;

  constructor(private readonly ctx: EngagementContext) {}

  private resolveKeys() {
    if (!this.keys) {
      this.keys = this.readKeys();
      this.keys.catch(() => {
        this.keys = null;
      });
    }
    return this.keys;
  }

  private async readKeys() {
    const caller = { callerMethod: "POST", callerPath: this.ctx.callerPath };
    const { key: token, keySource } = await decryptKey(this.ctx.identity.orgId, this.ctx.userId, "treg", caller, this.ctx.tracking);
    assertKeySource(keySource);
    const { key: org } = await decryptKey(this.ctx.identity.orgId, this.ctx.userId, "treg-org", caller, this.ctx.tracking);
    return { token, org, keySource };
  }

  private async ensureRun(): Promise<string> {
    if (!this.run) {
      this.run = this.createChildRun();
      this.run.catch(() => {
        this.run = null;
      });
    }
    return (await this.run).id;
  }

  private createChildRun() {
    const { identity } = this.ctx;
    return createRun({
      orgId: identity.orgId,
      userId: identity.userId,
      brandIds: identity.brandIds,
      campaignId: identity.campaignId,
      audienceId: identity.audienceId,
      featureSlug: identity.featureSlug,
      workflowSlug: identity.workflowSlug,
      serviceName: "apollo-service",
      taskName: "linkedin-engagement",
      parentRunId: this.ctx.runId,
    });
  }

  async call(endpoint: string, req: { method: "GET" | "POST"; body?: Record<string, unknown>; query?: Record<string, string>; maxMicro: number; routed: boolean; exclude?: string; timeoutMs?: number }): Promise<TregAnswer> {
    const { identity } = this.ctx;
    const keys = await this.resolveKeys();
    const runId = await this.ensureRun();

    const provisioned = await addCosts(runId, [{ costName: TREG_COST_NAME, costSource: keys.keySource, quantity: req.maxMicro, status: "provisioned" }], identity);
    const holdId = provisioned.costs?.[0]?.id ?? null;
    if (!holdId) throw new Error(`runs-service returned no cost id for the ${TREG_COST_NAME} hold`);
    if (keys.keySource === "platform") {
      const auth = await authorizeCredit({
        items: [{ costName: TREG_COST_NAME, quantity: req.maxMicro }],
        description: `linkedin engagement: ${endpoint}`,
        orgId: identity.orgId,
        userId: this.ctx.userId,
        runId: this.ctx.runId,
        ...this.ctx.tracking,
      });
      if (!auth.sufficient) {
        await updateCostStatus(runId, holdId, "cancelled", identity);
        throw new LinkedinEngagementInsufficientCreditError(auth.balance_cents, auth.required_cents);
      }
    }

    const url = `${TREG_BASE}${endpoint}${req.query ? `?${new URLSearchParams(req.query).toString()}` : ""}`;
    const headers: Record<string, string> = {
      "X-Treg-Token": keys.token,
      "X-Treg-Org": keys.org,
      // Our silver tables are the cache; a re-read is a deliberate refresh.
      "Cache-Control": "no-cache",
    };
    if (req.body) headers["Content-Type"] = "application/json";
    if (req.routed) headers["X-Treg-Route-Max-Cost"] = (req.maxMicro / 1_000_000).toFixed(6);
    if (req.routed && req.exclude) headers["X-Treg-Route-Exclude"] = req.exclude;

    const started = Date.now();
    let status: number | null = null;
    let responseHeaders: Record<string, string> | null = null;
    let body: Record<string, unknown> | null = null;
    let charged: number | null = null;
    let error: string | null = null;
    try {
      let response: Response;
      try {
        response = await fetch(url, { method: req.method, headers, body: req.body ? JSON.stringify(req.body) : undefined, signal: AbortSignal.timeout(req.timeoutMs ?? CALL_TIMEOUT_MS) });
      } catch (err) {
        // The call may have reached treg and been billed: the hold stays for the reconciler.
        error = err instanceof Error ? err.message : String(err);
        throw new LinkedinTregTransientError(`${endpoint} call failed: ${error}`);
      }
      status = response.status;
      responseHeaders = headersToObject(response.headers);
      const text = await response.text();
      try {
        body = text ? stripNul(JSON.parse(text) as Record<string, unknown>) : null;
      } catch {
        body = { _raw: stripNul(text.slice(0, 2000)) };
      }
      const costHeader = responseHeaders["x-treg-cost-micro"];
      charged = costHeader === undefined || costHeader.trim() === "" ? null : Number(costHeader);
      if (charged !== null && !Number.isFinite(charged)) charged = null;
      if (charged === null) {
        if (status === 200) {
          error = "treg answered 200 without X-Treg-Cost-Micro: the charge cannot be declared";
          throw new LinkedinTregError(`${endpoint}: ${error}`);
        }
        charged = 0; // treg bills nothing for a relayed failure
      }
      if (charged > 0) await addCosts(runId, [{ costName: TREG_COST_NAME, costSource: keys.keySource, quantity: charged }], identity);
      await updateCostStatus(runId, holdId, "cancelled", identity);
      this.calls++;
      this.chargedMicro += charged;
      return { status, body, chargedMicro: charged };
    } finally {
      await db.insert(linkedinTregCalls).values({
        endpoint,
        request: { method: req.method, query: req.query ?? null, body: req.body ?? null },
        runId,
        httpStatus: status,
        responseHeaders,
        responseBody: body,
        chargedMicro: charged,
        error,
        durationMs: Date.now() - started,
      });
    }
  }

  async finish(status: "completed" | "failed"): Promise<void> {
    if (this.run) await updateRun((await this.run).id, status, this.ctx.identity);
  }
}

function failure(endpoint: string, answer: TregAnswer): LinkedinTregError {
  return new LinkedinTregError(`${endpoint} HTTP ${answer.status}: ${JSON.stringify(answer.body).slice(0, 400)}`);
}

// ─── Harvest (posts + engagement → silver) ───────────────────────────────────

/** A page's state after the posts step of one serve. */
export type PageOutcome = { page: CompetitorPage; state: "readable" } | { page: CompetitorPage; state: "not_found" | "failed"; reason: string };

/**
 * Ask the providers in order until one returns the page's posts. A provider
 * that is gone, throttled, broken or slow passes to the next, and so does one
 * that does not know the page: coverage differs per provider (scrapecreators
 * said "Company not found" for oxblue-corporation while tikhub listed 50 of its
 * posts, 2026-10-04). The page is not_found only when EVERY provider said so; a
 * mix of not-found and failures is a failure (retried, never remembered).
 */
async function readPosts(meter: EngagementMeter, page: CompetitorPage, providers: PostsProvider[]): Promise<{ kind: "posts"; posts: WirePost[] } | { kind: "not_found"; reason: string } | { kind: "failed"; reason: string }> {
  const skipped: string[] = [];
  const notFound: string[] = [];
  for (const provider of providers) {
    let answer: TregAnswer;
    try {
      answer = await meter.call(provider.endpoint, { method: "GET", query: provider.query(page), maxMicro: provider.maxMicro, routed: false });
    } catch (err) {
      if (!(err instanceof LinkedinTregTransientError)) throw err;
      skipped.push(err.message);
      continue;
    }
    const verdict = postsVerdict(provider, answer.status, answer.body);
    if (verdict.kind === "next") {
      skipped.push(verdict.reason);
      console.warn(`[Apollo Service][linkedin-engagement] posts provider skipped for ${page.url}: ${verdict.reason}`);
      continue;
    }
    if (verdict.kind === "not_found") {
      notFound.push(verdict.reason);
      continue;
    }
    if (verdict.kind === "fail") throw new LinkedinTregError(verdict.reason);
    return verdict;
  }
  if (notFound.length === providers.length) return { kind: "not_found", reason: `no posts provider knows the page: ${notFound.join(" | ")}` };
  return { kind: "failed", reason: `no posts provider could read the page: ${[...notFound, ...skipped].join(" | ")}` };
}

async function ensurePosts(meter: EngagementMeter, page: CompetitorPage, now: Date): Promise<PageOutcome> {
  return db.transaction(async (tx) => {
    await advisoryXactLock(tx, `linkedin-page:${page.slug}`);
    const [row] = await tx.select().from(linkedinCompanyPages).where(eq(linkedinCompanyPages.slug, page.slug)).limit(1);
    if (row?.postsFetchedAt && now.getTime() - row.postsFetchedAt.getTime() < POSTS_REFRESH_MS) {
      return row.postsStatus === "not_found" ? { page, state: "not_found", reason: row.postsError ?? "not found" } : { page, state: "readable" };
    }

    const read = await readPosts(meter, page, POSTS_PROVIDERS);
    if (read.kind === "failed") return { page, state: "failed", reason: read.reason };
    if (read.kind === "not_found") {
      // A permanent answer: remembered for the refresh period so no serve pays to re-learn it.
      const set = { postsFetchedAt: now, postsCount: 0, postsStatus: "not_found", postsError: read.reason.slice(0, 1000) };
      await tx.insert(linkedinCompanyPages).values({ slug: page.slug, url: page.url, ...set }).onConflictDoUpdate({ target: linkedinCompanyPages.slug, set });
      return { page, state: "not_found", reason: read.reason };
    }

    for (const p of read.posts) {
      const postId = typeof p.id === "string" && /^\d+$/.test(p.id) ? p.id : null;
      if (!postId) continue;
      const published = p.datePublished ? new Date(p.datePublished) : null;
      await tx
        .insert(linkedinCompanyPosts)
        .values({ postId, pageSlug: page.slug, postUrl: p.url ?? null, text: p.text ?? null, publishedAt: published && !Number.isNaN(published.getTime()) ? published : null })
        .onConflictDoUpdate({ target: linkedinCompanyPosts.postId, set: { postUrl: sql`excluded.post_url`, text: sql`excluded.text`, lastSeenAt: now } });
    }
    const set = { postsFetchedAt: now, postsCount: read.posts.length, postsStatus: "ok", postsError: null };
    await tx.insert(linkedinCompanyPages).values({ slug: page.slug, url: page.url, ...set }).onConflictDoUpdate({ target: linkedinCompanyPages.slug, set });
    return { page, state: "readable" };
  });
}

async function ensureEngagement(meter: EngagementMeter, postId: string, pageSlug: string, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    await advisoryXactLock(tx, `linkedin-post:${postId}`);
    const [post] = await tx.select().from(linkedinCompanyPosts).where(eq(linkedinCompanyPosts.postId, postId)).limit(1);
    if (post?.engagementFetchedAt && now.getTime() - post.engagementFetchedAt.getTime() < ENGAGEMENT_REFRESH_MS) return;

    let reactionStart = 0;
    let commentToken: string | null = null;
    let reactions = 0;
    let comments = 0;
    for (let i = 0; i < MAX_ENGAGEMENT_PAGES_PER_POST; i++) {
      const query: Record<string, string> = {
        postUrlOrUrn: `urn:li:activity:${postId}`,
        reactionCount: String(ENGAGEMENT_PAGE_SIZE),
        commentCount: String(ENGAGEMENT_PAGE_SIZE),
        reactionStart: String(reactionStart),
        ...(commentToken ? { commentPaginationToken: commentToken } : { commentStart: "0" }),
      };
      const answer = await meter.call(ENGAGEMENT_ENDPOINT, { method: "GET", query, maxMicro: ENGAGEMENT_MAX_MICRO, routed: false });
      if (answer.status === 404) break; // the post is gone: nothing to read
      if (answer.status !== 200 || !answer.body) throw failure(ENGAGEMENT_ENDPOINT, answer);
      const page = answer.body as WireEngagement;
      const rows = engagementRows(postId, pageSlug, page);
      for (const r of rows) {
        await tx
          .insert(linkedinPostEngagements)
          .values(r)
          .onConflictDoUpdate({
            target: [linkedinPostEngagements.postId, linkedinPostEngagements.profileId, linkedinPostEngagements.kind, linkedinPostEngagements.ref],
            set: { actorName: sql`excluded.actor_name`, actorHeadline: sql`excluded.actor_headline`, actorProfileUrl: sql`excluded.actor_profile_url`, lastSeenAt: now },
          });
      }
      reactions += page.reactions?.length ?? 0;
      comments += page.comments?.length ?? 0;
      reactionStart += page.reactions?.length ?? 0;
      commentToken = page.commentsPaginationToken ?? null;
      const moreReactions = page.reactionsHasMore === true && (page.reactions?.length ?? 0) > 0;
      const moreComments = page.commentsHasMore === true && !!commentToken;
      if (!moreReactions && !moreComments) break;
    }
    await tx
      .update(linkedinCompanyPosts)
      .set({ engagementFetchedAt: now, reactionsSeen: reactions, commentsSeen: comments })
      .where(eq(linkedinCompanyPosts.postId, postId));
  });
}

function windowStart(spec: BuyingSignalSpec, now: Date): Date {
  return new Date(now.getTime() - spec.window_days * 86_400_000);
}

/**
 * Bring silver up to date for these pages: posts listed today, engagement of
 * every post in the window read today. `complete` says whether it got through
 * all of it (false = the next serve continues). A page no provider knows, or
 * one every provider failed on, is SKIPPED (logged, returned in `skipped`) and
 * the others are served; only when no page at all is readable does it throw.
 */
export async function harvest(meter: EngagementMeter, pages: CompetitorPage[], spec: BuyingSignalSpec, now: Date, deadline: number): Promise<{ complete: boolean; skipped: Array<{ page: string; state: string; reason: string }> }> {
  if (Date.now() > deadline) return { complete: false, skipped: [] };
  const settled = await Promise.allSettled(pages.map((page) => ensurePosts(meter, page, now)));
  const outcomes: PageOutcome[] = settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    if (r.reason instanceof LinkedinEngagementInsufficientCreditError) throw r.reason;
    return { page: pages[i], state: "failed", reason: r.reason instanceof Error ? r.reason.message : String(r.reason) };
  });
  const skipped = outcomes.flatMap((o) => (o.state === "readable" ? [] : [{ page: o.page.url, state: o.state, reason: o.reason }]));
  for (const s of skipped) console.warn(`[Apollo Service][linkedin-engagement] competitor page SKIPPED (${s.state}) ${s.page}: ${s.reason}`);
  if (skipped.length === pages.length) {
    throw new LinkedinCompetitorPagesUnreadableError(skipped.map((s) => ({ page: s.page, reason: s.reason })), skipped.every((s) => s.state === "not_found"));
  }
  const stale = new Date(now.getTime() - ENGAGEMENT_REFRESH_MS);
  const due = await db
    .select({ postId: linkedinCompanyPosts.postId, pageSlug: linkedinCompanyPosts.pageSlug })
    .from(linkedinCompanyPosts)
    .where(
      and(
        inArray(linkedinCompanyPosts.pageSlug, pages.map((p) => p.slug)),
        gte(linkedinCompanyPosts.publishedAt, windowStart(spec, now)),
        or(isNull(linkedinCompanyPosts.engagementFetchedAt), lt(linkedinCompanyPosts.engagementFetchedAt, stale)),
      ),
    )
    .orderBy(desc(linkedinCompanyPosts.publishedAt));
  let complete = true;
  const read = await mapPool(due, HARVEST_CONCURRENCY, async (post) => {
    if (Date.now() > deadline) {
      complete = false;
      return;
    }
    await ensureEngagement(meter, post.postId, post.pageSlug, now);
  });
  const failed = read.find((r) => r?.status === "rejected") as PromiseRejectedResult | undefined;
  if (failed) throw failed.reason;
  // A page that failed transiently may still hold engagers: not exhausted yet.
  return { complete: complete && !skipped.some((s) => s.state === "failed"), skipped };
}

// ─── Serve ───────────────────────────────────────────────────────────────────

/** Never-twice is per audience; an audience-less serve falls back to the campaign. */
export function audienceKeyOf(audienceId: string | undefined, campaignId: string): string {
  return audienceId ? `audience:${audienceId}` : `campaign:${campaignId}`;
}

function servedAlready(orgId: string, audienceKey: string) {
  return notExists(
    db
      .select({ one: sql`1` })
      .from(linkedinEngagementServes)
      .where(
        and(
          eq(linkedinEngagementServes.orgId, orgId),
          eq(linkedinEngagementServes.audienceKey, audienceKey),
          eq(linkedinEngagementServes.profileId, linkedinPostEngagements.profileId),
        ),
      ),
  );
}

/** Engagers of these pages' in-window posts this audience has not considered yet, most recent first. */
async function candidates(orgId: string, audienceKey: string, pages: CompetitorPage[], spec: BuyingSignalSpec, now: Date, limit: number) {
  const last = max(sql`coalesce(${linkedinPostEngagements.commentedAt}, ${linkedinCompanyPosts.publishedAt})`);
  return db
    .select({ profileId: linkedinPostEngagements.profileId, last })
    .from(linkedinPostEngagements)
    .innerJoin(linkedinCompanyPosts, eq(linkedinCompanyPosts.postId, linkedinPostEngagements.postId))
    .where(
      and(
        inArray(linkedinPostEngagements.pageSlug, pages.map((p) => p.slug)),
        gte(linkedinCompanyPosts.publishedAt, windowStart(spec, now)),
        servedAlready(orgId, audienceKey),
      ),
    )
    .groupBy(linkedinPostEngagements.profileId)
    .orderBy(desc(last))
    .limit(limit);
}

/** Distinct engagers of these pages' in-window posts (the pool, for totalEntries). */
export async function poolSize(pages: CompetitorPage[], spec: BuyingSignalSpec, now: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(DISTINCT ${linkedinPostEngagements.profileId})::int` })
    .from(linkedinPostEngagements)
    .innerJoin(linkedinCompanyPosts, eq(linkedinCompanyPosts.postId, linkedinPostEngagements.postId))
    .where(and(inArray(linkedinPostEngagements.pageSlug, pages.map((p) => p.slug)), gte(linkedinCompanyPosts.publishedAt, windowStart(spec, now))));
  return row?.n ?? 0;
}

function rowToProfile(row: typeof linkedinProfiles.$inferSelect): ResolvedProfile {
  return {
    profileId: row.profileId,
    publicIdentifier: row.publicIdentifier,
    linkedinUrl: row.linkedinUrl,
    firstName: row.firstName,
    lastName: row.lastName,
    headline: row.headline,
    jobTitle: row.jobTitle,
    companyName: row.companyName,
    companySlug: row.companySlug,
    companyLinkedinUrl: row.companyLinkedinUrl,
    companyWebsite: row.companyWebsite,
    country: row.country,
    location: row.location,
  };
}

export async function loadProfile(profileId: string): Promise<ResolvedProfile | null> {
  const [row] = await db.select().from(linkedinProfiles).where(and(eq(linkedinProfiles.profileId, profileId), eq(linkedinProfiles.status, "found"))).limit(1);
  return row ? rowToProfile(row) : null;
}

/** The profile from silver (30 days), else bought. null = no provider could read it. */
async function resolveProfile(meter: EngagementMeter, profileId: string, now: Date): Promise<ResolvedProfile | null> {
  const [cached] = await db.select().from(linkedinProfiles).where(eq(linkedinProfiles.profileId, profileId)).limit(1);
  if (cached && now.getTime() - cached.fetchedAt.getTime() < PROFILE_CACHE_MS) return cached.status === "found" ? rowToProfile(cached) : null;

  // A commenter's URL carries the public slug; a reactor's only the opaque id.
  const urls = await db
    .select({ url: linkedinPostEngagements.actorProfileUrl })
    .from(linkedinPostEngagements)
    .where(and(eq(linkedinPostEngagements.profileId, profileId), isNotNull(linkedinPostEngagements.actorProfileUrl)));
  const candidatesUrls = urls.map((u) => u.url!).filter(Boolean);
  const url = candidatesUrls.find((u) => isPublicProfileUrl(u)) ?? candidatesUrls[0] ?? `https://www.linkedin.com/in/${profileId}`;

  const answer = await meter.call(PROFILE_ENDPOINT, { method: "POST", body: { linkedin_url: url }, maxMicro: PROFILE_MAX_MICRO, routed: true, exclude: PROFILE_ROUTE_EXCLUDE, timeoutMs: PROFILE_CALL_TIMEOUT_MS });
  let profile: ResolvedProfile | null = null;
  let raw: unknown = null;
  if (answer.status === 200) {
    const output = (answer.body?.output ?? null) as Record<string, unknown> | null;
    raw = answer.body?.raw ?? null;
    profile = toResolvedProfile(profileId, output, raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null);
  } else if (isRoutedMiss(answer) && !routeHadChildError(answer)) {
    // every child answered and none has this person: a real not_found
  } else if (answer.status === 429 || answer.status >= 500) {
    throw new LinkedinTregTransientError(`${PROFILE_ENDPOINT} HTTP ${answer.status}: ${JSON.stringify(answer.body).slice(0, 400)}`);
  } else {
    throw failure(PROFILE_ENDPOINT, answer);
  }
  const { profileId: _id, ...facts } = profile ?? { profileId };
  const set = profile
    ? { ...facts, status: "found", raw: raw as object | null, fetchedAt: now }
    : { status: "not_found", raw: answer.body as object | null, fetchedAt: now };
  await db
    .insert(linkedinProfiles)
    .values({ profileId, ...set })
    .onConflictDoUpdate({ target: linkedinProfiles.profileId, set });
  return profile;
}

export type LinkedinTeaser = ReturnType<typeof linkedinEngagerToPerson>;

export interface EngagementServeResult {
  people: LinkedinTeaser[];
  /** True only when silver is current AND no engager is left for this audience. */
  done: boolean;
  poolSize: number;
  considered: number;
  excluded: number;
  unresolvable: number;
  /** Lookups that failed transiently: released, retried by a later serve. */
  deferred: number;
  /** Competitor pages not read this serve: `not_found` (no provider knows the page) or `failed` (every provider failed). */
  skippedPages: Array<{ page: string; state: string; reason: string }>;
  calls: number;
  chargedMicro: number;
}

/**
 * One serve for a linkedin_engagement audience: harvest what is due, then
 * claim up to MAX_PROFILE_LOOKUPS_PER_CALL engagers and resolve and screen them
 * PROFILE_CONCURRENCY at a time; every prospect among them comes back. Each
 * engager is claimed for the audience BEFORE any spend on them (the unique
 * row), so two concurrent serves never pay for, or return, the same person.
 * When any lookup fails the call fails, and every claim this call cannot hand
 * back (the failed, the never started, AND the prospects already resolved) is
 * released: nobody is marked served without being returned, and the profiles
 * already bought sit in silver, so the retry pays nothing again for them.
 */
export async function serveLinkedinEngagers(args: {
  ctx: EngagementContext;
  campaignId: string;
  spec: BuyingSignalSpec;
  now?: Date;
}): Promise<EngagementServeResult> {
  const now = args.now ?? new Date();
  const { identity } = args.ctx;
  const pages = competitorPagesOf(args.spec);
  const audienceKey = audienceKeyOf(identity.audienceId, args.campaignId);
  const meter = new EngagementMeter(args.ctx);
  const result: EngagementServeResult = { people: [], done: false, poolSize: 0, considered: 0, excluded: 0, unresolvable: 0, deferred: 0, skippedPages: [], calls: 0, chargedMicro: 0 };
  let ok = false;
  try {
    const { complete: harvested, skipped } = await harvest(meter, pages, args.spec, now, Date.now() + HARVEST_BUDGET_MS);
    result.skippedPages = skipped;
    const queue = await candidates(identity.orgId, audienceKey, pages, args.spec, now, MAX_PROFILE_LOOKUPS_PER_CALL);
    const claims: Array<{ id: string; profileId: string }> = [];
    for (const c of queue) {
      const [claim] = await db
        .insert(linkedinEngagementServes)
        .values({
          orgId: identity.orgId,
          brandIds: identity.brandIds ?? [],
          campaignId: args.campaignId,
          audienceKey,
          profileId: c.profileId,
          status: "pending",
          signal: args.spec,
        })
        .onConflictDoNothing()
        .returning({ id: linkedinEngagementServes.id });
      if (claim) claims.push({ id: claim.id, profileId: c.profileId }); // else a concurrent serve took this person
    }
    result.considered = claims.length;

    const transient: Error[] = [];
    const screened = await mapPool(claims, PROFILE_CONCURRENCY, async (claim) => {
      let profile: ResolvedProfile | null;
      try {
        profile = await resolveProfile(meter, claim.profileId, now);
      } catch (err) {
        if (!(err instanceof LinkedinTregTransientError)) throw err;
        // Nothing learned about this person: release the claim so a later serve retries them.
        await db.delete(linkedinEngagementServes).where(eq(linkedinEngagementServes.id, claim.id));
        console.warn(`[Apollo Service][linkedin-engagement] deferred profile=${claim.profileId} audience=${audienceKey}: ${err.message}`);
        transient.push(err);
        return { verdict: "deferred", profile: null };
      }
      const verdict = !profile || !isPublicProfileUrl(profile.linkedinUrl) ? "unresolvable" : prospectRejection(profile, pages) ? "excluded" : "served";
      if (verdict !== "served") {
        await db
          .update(linkedinEngagementServes)
          .set({ status: verdict, reason: verdict === "excluded" ? "competitor_employee" : "profile_not_readable", servedAt: new Date() })
          .where(eq(linkedinEngagementServes.id, claim.id));
      }
      return { verdict, profile };
    });

    const failed = screened.find((r) => r?.status === "rejected") as PromiseRejectedResult | undefined;
    if (failed) {
      // "deferred" claims are already gone.
      const release = claims.filter((_, i) => screened[i]?.status !== "fulfilled" || (screened[i] as PromiseFulfilledResult<{ verdict: string }>).value.verdict === "served");
      if (release.length > 0) await db.delete(linkedinEngagementServes).where(inArray(linkedinEngagementServes.id, release.map((c) => c.id)));
      throw failed.reason;
    }

    const servedIds: string[] = [];
    screened.forEach((r, i) => {
      const { verdict, profile } = (r as PromiseFulfilledResult<{ verdict: string; profile: ResolvedProfile | null }>).value;
      if (verdict === "served") {
        servedIds.push(claims[i].id);
        result.people.push(linkedinEngagerToPerson(profile!, canonicalLinkedinUrl));
      } else if (verdict === "excluded") result.excluded++;
      else if (verdict === "deferred") result.deferred++;
      else result.unresolvable++;
    });
    // A page that could serve nobody BECAUSE lookups failed is a failure, not an empty page.
    if (result.people.length === 0 && transient.length > 0) throw transient[0];
    if (servedIds.length > 0) {
      await db.update(linkedinEngagementServes).set({ status: "served", reason: null, servedAt: new Date() }).where(inArray(linkedinEngagementServes.id, servedIds));
    }

    const left = await candidates(identity.orgId, audienceKey, pages, args.spec, now, 1);
    result.done = harvested && left.length === 0 && result.people.length === 0;
    result.poolSize = await poolSize(pages, args.spec, now);
    ok = true;
    return result;
  } finally {
    result.calls = meter.calls;
    result.chargedMicro = meter.chargedMicro;
    await meter.finish(ok ? "completed" : "failed");
  }
}

// ─── Enrich ──────────────────────────────────────────────────────────────────

/** The serve row that gave this org this engager (latest), or null when it never did. */
export async function findServed(orgId: string, profileId: string) {
  const [row] = await db
    .select()
    .from(linkedinEngagementServes)
    .where(and(eq(linkedinEngagementServes.orgId, orgId), eq(linkedinEngagementServes.profileId, profileId), eq(linkedinEngagementServes.status, "served")))
    .orderBy(desc(linkedinEngagementServes.servedAt))
    .limit(1);
  return row ?? null;
}

/** The engagement that qualified this person for the serve's signal: the most recent in its window. */
export async function evidenceFor(profileId: string, spec: BuyingSignalSpec, servedAt: Date) {
  const pages = competitorPagesOf(spec);
  const [row] = await db
    .select({
      pageSlug: linkedinPostEngagements.pageSlug,
      kind: linkedinPostEngagements.kind,
      reactionType: linkedinPostEngagements.reactionType,
      commentText: linkedinPostEngagements.commentText,
      commentedAt: linkedinPostEngagements.commentedAt,
      postUrl: linkedinCompanyPosts.postUrl,
      postPublishedAt: linkedinCompanyPosts.publishedAt,
    })
    .from(linkedinPostEngagements)
    .innerJoin(linkedinCompanyPosts, eq(linkedinCompanyPosts.postId, linkedinPostEngagements.postId))
    .where(
      and(
        eq(linkedinPostEngagements.profileId, profileId),
        inArray(linkedinPostEngagements.pageSlug, pages.map((p) => p.slug)),
        gte(linkedinCompanyPosts.publishedAt, windowStart(spec, servedAt)),
      ),
    )
    .orderBy(desc(sql`coalesce(${linkedinPostEngagements.commentedAt}, ${linkedinCompanyPosts.publishedAt})`))
    .limit(1);
  if (!row) return null;
  return engagementEvidence({ ...row, kind: row.kind === "comment" ? "comment" : "reaction" });
}
