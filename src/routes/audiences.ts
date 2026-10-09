import { Router, type Response } from "express";
import { eq, and, inArray, gt } from "drizzle-orm";
import { db } from "../db/index.js";
import { apolloAudiences } from "../db/schema.js";
import { serviceAuth, orgAuth, AuthenticatedRequest } from "../middleware/auth.js";
import { decryptKey } from "../lib/keys-client.js";
import { buildFiltersPrompt, APOLLO_UNDOCUMENTED_FILTERS_ENCART } from "../lib/filters-prompt.js";
import { refineAudience, dryRunCount } from "../lib/audience-refine.js";
import { previewAudience } from "../lib/audience-preview.js";
import {
  collectEmployers,
  resolveOrganization,
  mapConcurrent,
  toFirmographics,
  MAX_COMPANIES,
  DEFAULT_COMPANIES_LIMIT,
  LOOKUP_CONCURRENCY,
  ORG_CACHE_DAYS,
  COMPANY_FIRMOGRAPHICS_COST_NAME,
  normalizeCompanyName,
} from "../lib/audience-companies.js";
import { getOrganizationById, searchPeople, type ApolloOrganization } from "../lib/apollo-client.js";
import { withTregFallback, tregCostItems, ownKeyExhausted } from "../lib/apollo-reveal-route.js";
import { normalizeDomain } from "../lib/teaser-employer-domains.js";
import { toApolloSearchParams } from "../lib/transform.js";
import { apolloOrganizations } from "../db/schema.js";
import { advisoryXactLock } from "../lib/advisory-lock.js";
import { createRun, updateRun, addCosts, updateCostStatus, type IdentityHeaders } from "../lib/runs-client.js";
import { authorizeCredit } from "../lib/billing-client.js";
import { assertKeySource } from "../lib/validators.js";
import { toCreditAlertIdentity } from "../lib/credit-alert.js";
import { SuggestFromSegmentRequestSchema, ApolloNativeSearchFiltersSchema, AudienceCompaniesQuerySchema } from "../schemas.js";
import { providerErrorFields } from "../lib/provider-error.js";
import { planQuickenrich } from "../lib/quickenrich.js";
import { ServeSourceRequestSchema, SignalCoverageRequestSchema, CreateSignalAudienceRequestSchema, SearchFiltersSchema, APOLLO_BUYING_SIGNAL_TYPES } from "../schemas.js";
import { signalConflicts, signalWindow, utcDay, SignalNotApolloSearchableError, type BuyingSignalSpec, type BuyingSignalType } from "../lib/buying-signal-spec.js";
import { filtersBesideEngagement } from "../lib/linkedin-engagement.js";
import { parseCompetitorPage } from "../lib/linkedin-engagement-spec.js";

const router = Router();

// Apollo-native catalog, computed once at module load. Fed to the refine loop's
// LLM so it builds only valid canonical Apollo filters. The UNDOCUMENTED-but-
// verified rules encart (funding filters + stage code map + "unknown params are
// silently dropped") is appended so the LLM can use them and they survive a
// future doc re-sync of the schema.
const FILTERS_PROMPT = `${buildFiltersPrompt(ApolloNativeSearchFiltersSchema)}\n\n${APOLLO_UNDOCUMENTED_FILTERS_ENCART}`;

/**
 * POST /audiences/suggest-from-segment — run the agentic NL→faithful-Apollo-
 * filters refine loop (LLM via chat-service, free dry-runs for live counts) and
 * persist EVERY round it explored, each as its own apollo_audiences row.
 *
 * Returns `candidates`: one entry per round, in round order, carrying that
 * round's persisted apolloAudienceId, its filters, its live count, its 10
 * random-page sample rows and the model's three notes. This service explores and
 * reports; WHICH audience serves the customer is a product decision made by
 * human-service, which did not author the sets. Nothing here ranks or sorts.
 *
 * The single-result fields (apolloAudienceId / filters / count / degraded) are
 * kept ADDITIVELY, behaving as before (largest non-empty round, degraded false),
 * so human-service can migrate to `candidates` on its own schedule. A later PR
 * removes them.
 */
router.post("/audiences/suggest-from-segment", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = SuggestFromSegmentRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ type: "validation", error: "Invalid request", details: parsed.error.flatten() });
    }
    const { name, description, brandId } = parsed.data;

    const brandIds = brandId ? [brandId] : req.brandIds;
    const tracking = {
      brandIds,
      campaignId: req.campaignId,
      audienceId: req.audienceId,
      featureSlug: req.featureSlug,
      workflowSlug: req.workflowSlug,
    };

    const { key: apolloApiKey } = await decryptKey(
      req.orgId!,
      req.userId!,
      "apollo",
      { callerMethod: "POST", callerPath: "/audiences/suggest-from-segment" },
      tracking,
    );

    const refined = await refineAudience({
      name,
      description,
      filtersPromptCatalog: FILTERS_PROMPT,
      apolloApiKey,
      tracking: {
        orgId: req.orgId!,
        userId: req.userId,
        runId: req.runId,
        brandIds,
        campaignId: req.campaignId,
        featureSlug: req.featureSlug,
        workflowSlug: req.workflowSlug,
      },
    });

    // One row per explored round. Rows are cheap and the ones nobody picks are a
    // useful record of what the loop tried. Every row carries the WHOLE run's
    // trace as its bronze — that is the run that produced it.
    const rows = await db
      .insert(apolloAudiences)
      .values(
        refined.candidates.map((c) => ({
          orgId: req.orgId!,
          userId: req.userId,
          brandId: brandId ?? null,
          name,
          description,
          filters: c.filters,
          count: c.count,
          refineTrace: refined.trace,
          status: refined.status,
        })),
      )
      .returning();

    const candidates = refined.candidates.map((c, i) => ({
      apolloAudienceId: rows[i].id,
      round: c.round,
      filters: c.filters,
      count: c.count,
      sample: c.sample,
      notes: c.notes,
    }));

    // The legacy single result points at the row of the largest non-empty round.
    const legacy = candidates.find((c) => c.filters === refined.filters) ?? candidates[candidates.length - 1];

    res.json({
      apolloAudienceId: legacy.apolloAudienceId,
      filters: refined.filters,
      count: refined.count,
      degraded: refined.degraded,
      stoppedReason: refined.stoppedReason,
      candidates,
    });
  } catch (error) {
    console.error("[Apollo Service][POST /audiences/suggest-from-segment] ERROR:", error);
    if (error instanceof SignalNotApolloSearchableError) return res.status(400).json({ type: "validation", error: error.message });
    res.status(500).json({ type: "internal", error: error instanceof Error ? error.message : "Internal server error", ...providerErrorFields(error) });
  }
});

/**
 * GET /audiences/:apolloAudienceId — fetch a persisted audience (org-scoped).
 */
router.get("/audiences/:apolloAudienceId", orgAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { apolloAudienceId } = req.params;

    const [row] = await db
      .select()
      .from(apolloAudiences)
      .where(and(eq(apolloAudiences.id, apolloAudienceId), eq(apolloAudiences.orgId, req.orgId!)))
      .limit(1);

    if (!row) {
      return res.status(404).json({ type: "not_found", error: "Audience not found" });
    }

    res.json({
      apolloAudienceId: row.id,
      filters: row.filters,
      count: row.count,
      status: row.status,
      createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
      ...serveSourceFields(row.serveSource, row.filters as Record<string, unknown>),
    });
  } catch (error) {
    console.error("[Apollo Service][GET /audiences/:id] ERROR:", error);
    if (error instanceof SignalNotApolloSearchableError) return res.status(400).json({ type: "validation", error: error.message });
    res.status(500).json({ type: "internal", error: "Internal server error" });
  }
});

function serveSourceFields(serveSource: string, filters: Record<string, unknown>) {
  const planned = planQuickenrich(filters);
  return {
    serveSource,
    quickenrich: { expressible: planned.ok, reasons: planned.ok ? [] : planned.reasons },
  };
}

/**
 * PATCH /audiences/:apolloAudienceId/serve-source — switch where /search/next
 * sources this audience's people. `quickenrich` = free QuickEnrich search +
 * treg email find, falling back to Apollo once QuickEnrich has nobody left;
 * `apollo` = the default Apollo teaser + reveal. Switching ON an audience
 * whose filters QuickEnrich cannot enforce faithfully is refused (422, with
 * every reason), so an inexpressible audience is never served from it.
 */
router.patch("/audiences/:apolloAudienceId/serve-source", orgAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = ServeSourceRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ type: "validation", error: "Invalid request", details: parsed.error.flatten() });
    }
    const { apolloAudienceId } = req.params;
    const [row] = await db
      .select()
      .from(apolloAudiences)
      .where(and(eq(apolloAudiences.id, apolloAudienceId), eq(apolloAudiences.orgId, req.orgId!)))
      .limit(1);
    if (!row) {
      return res.status(404).json({ type: "not_found", error: "Audience not found" });
    }
    const filters = row.filters as Record<string, unknown>;
    const { serveSource } = parsed.data;
    if (serveSource === "quickenrich") {
      const planned = planQuickenrich(filters);
      if (!planned.ok) {
        return res.status(422).json({ type: "not_expressible", error: "QuickEnrich cannot enforce this audience's filters faithfully", reasons: planned.reasons });
      }
    }
    await db.update(apolloAudiences).set({ serveSource, updatedAt: new Date() }).where(eq(apolloAudiences.id, row.id));
    res.json({ apolloAudienceId: row.id, ...serveSourceFields(serveSource, filters) });
  } catch (error) {
    console.error("[Apollo Service][PATCH /audiences/:id/serve-source] ERROR:", error);
    if (error instanceof SignalNotApolloSearchableError) return res.status(400).json({ type: "validation", error: error.message });
    res.status(500).json({ type: "internal", error: error instanceof Error ? error.message : "Internal server error" });
  }
});

/**
 * GET /audiences/:apolloAudienceId/preview — a FREE, read-only sample of who is
 * in a persisted audience: up to 10 real employers and up to 20 real people, as
 * Apollo's free people-search teaser serves them (no email, no phone, no full
 * last name). One teaser call, zero credits. Writes nothing and never touches
 * the serve cursor. An audience with no match answers an empty sample.
 * See src/lib/audience-preview.ts for why company descriptors are omitted.
 */
router.get("/audiences/:apolloAudienceId/preview", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { apolloAudienceId } = req.params;

    const [row] = await db
      .select()
      .from(apolloAudiences)
      .where(and(eq(apolloAudiences.id, apolloAudienceId), eq(apolloAudiences.orgId, req.orgId!)))
      .limit(1);

    if (!row) {
      return res.status(404).json({ type: "not_found", error: "Audience not found" });
    }

    const { key: apolloApiKey } = await decryptKey(
      req.orgId!,
      req.userId!,
      "apollo",
      { callerMethod: "GET", callerPath: "/audiences/:apolloAudienceId/preview" },
      { brandIds: row.brandId ? [row.brandId] : req.brandIds, featureSlug: req.featureSlug, workflowSlug: req.workflowSlug },
    );

    const preview = await previewAudience(apolloApiKey, row.filters as Record<string, unknown>, toCreditAlertIdentity(req));

    res.json({ apolloAudienceId: row.id, ...preview });
  } catch (error) {
    console.error("[Apollo Service][GET /audiences/:id/preview] ERROR:", error);
    if (error instanceof SignalNotApolloSearchableError) return res.status(400).json({ type: "validation", error: error.message });
    res.status(500).json({ type: "internal", error: error instanceof Error ? error.message : "Internal server error", ...providerErrorFields(error) });
  }
});

type EnrichOutcome =
  | { kind: "ok"; orgs: Map<string, ApolloOrganization>; creditsCharged: number }
  | { kind: "insufficient"; balance_cents: number; required_cents: number };

/**
 * The full organization record for each id: served from the global cache when
 * fresher than ORG_CACHE_DAYS, otherwise bought from Apollo (1 credit each)
 * under provision → authorize → execute → actualize against the CALLER's org.
 * An advisory lock per audience keeps two concurrent calls for the same chunk
 * from paying twice. A fetched record is cached even when a sibling fetch
 * fails, so the retry only pays for what is still missing.
 */
async function enrichOrganizations(args: {
  ids: string[];
  /** id → the domain the free lookup gave it: how treg is asked while our Apollo credits are out. */
  domains: Map<string, string>;
  audienceRowId: string;
  apolloApiKey: string;
  keySource: "org" | "platform";
  identity: IdentityHeaders;
  runId: string;
  req: AuthenticatedRequest;
}): Promise<EnrichOutcome> {
  const { ids, apolloApiKey, keySource, identity, runId, req } = args;
  const orgs = new Map<string, ApolloOrganization>();
  if (ids.length === 0) return { kind: "ok", orgs, creditsCharged: 0 };

  return db.transaction(async (tx) => {
    await advisoryXactLock(tx, `apollo-audience-companies:${args.audienceRowId}`);

    const freshAfter = new Date(Date.now() - ORG_CACHE_DAYS * 24 * 60 * 60 * 1000);
    const cached = await tx
      .select()
      .from(apolloOrganizations)
      .where(and(inArray(apolloOrganizations.id, ids), gt(apolloOrganizations.fetchedAt, freshAfter)));
    for (const row of cached) orgs.set(row.id, row.raw as ApolloOrganization);

    const missing = ids.filter((id) => !orgs.has(id));
    if (missing.length === 0) return { kind: "ok" as const, orgs, creditsCharged: 0 };

    const run = await createRun({
      orgId: identity.orgId,
      userId: identity.userId,
      brandIds: identity.brandIds,
      campaignId: identity.campaignId,
      audienceId: identity.audienceId,
      featureSlug: identity.featureSlug,
      workflowSlug: identity.workflowSlug,
      serviceName: "apollo-service",
      taskName: "audience-companies",
      parentRunId: runId,
    });

    // PROVISION the worst case (every missing company billed) before anything is spent.
    const provisioned = await addCosts(
      run.id,
      [{ costName: COMPANY_FIRMOGRAPHICS_COST_NAME, costSource: keySource, quantity: missing.length, status: "provisioned" }],
      identity,
    );
    const provisionedCostId = provisioned.costs?.[0]?.id ?? null;
    const releaseHold = async (status: "completed" | "failed") => {
      if (provisionedCostId) await updateCostStatus(run.id, provisionedCostId, "cancelled", identity);
      await updateRun(run.id, status, identity);
    };

    // AUTHORIZE platform-key spend (a BYOK org pays Apollo directly).
    if (keySource === "platform") {
      const auth = await authorizeCredit({
        items: [{ costName: COMPANY_FIRMOGRAPHICS_COST_NAME, quantity: missing.length }],
        description: "apollo-audience-companies",
        orgId: identity.orgId,
        userId: identity.userId!,
        runId,
        brandIds: identity.brandIds,
        campaignId: identity.campaignId,
        audienceId: identity.audienceId,
        featureSlug: identity.featureSlug,
        workflowSlug: identity.workflowSlug,
      });
      if (!auth.sufficient) {
        await releaseHold("failed");
        return { kind: "insufficient" as const, balance_cents: auth.balance_cents, required_cents: auth.required_cents };
      }
    }

    // EXECUTE.
    const alertIdentity = toCreditAlertIdentity(req);
    const results = await mapConcurrent(missing, LOOKUP_CONCURRENCY, async (id) => {
      const domain = args.domains.get(id);
      try {
        if (!domain) {
          if (keySource === "platform" && ownKeyExhausted()) {
            // treg can only be asked by domain: no domain, no firmographics while our credits are out.
            console.warn(`[Apollo Service][audience-companies] no domain for org ${id}, firmographics skipped while our Apollo credits are out`);
            return { id, org: null, tregCostMicro: null, error: null as unknown };
          }
          return { id, org: await getOrganizationById(apolloApiKey, id, alertIdentity), tregCostMicro: null, error: null as unknown };
        }
        // Our Apollo key, or Apollo through treg while ours is out of credits (apollo-reveal-route.ts).
        const r = await withTregFallback<ApolloOrganization | null>(keySource, {
          own: () => getOrganizationById(apolloApiKey, id, alertIdentity),
          treg: { endpoint: "apollo.companies.enrich", method: "GET", query: { domain } },
          callerPath: "/audiences/:apolloAudienceId/companies",
        });
        if (r.via === "apollo") return { id, org: r.response, tregCostMicro: null, error: null as unknown };
        // treg answers organizations/enrich by domain: keep it only when it is the SAME organization.
        const org = (r.response as unknown as { organization?: ApolloOrganization | null }).organization ?? null;
        return { id, org: org && org.id === id ? org : null, tregCostMicro: r.tregCostMicro, error: null as unknown };
      } catch (error) {
        return { id, org: null, tregCostMicro: null, error };
      }
    });
    const fetched = results.filter((r): r is { id: string; org: ApolloOrganization; tregCostMicro: number | null; error: unknown } => r.org !== null);
    for (const r of fetched) {
      orgs.set(r.id, r.org);
      // Outside the tx on purpose: a record Apollo billed us for is kept even if this request fails later.
      await db
        .insert(apolloOrganizations)
        .values({ id: r.id, raw: r.org, fetchedAt: new Date() })
        .onConflictDoUpdate({ target: apolloOrganizations.id, set: { raw: r.org, fetchedAt: new Date() } });
    }

    // ACTUALIZE what Apollo returned (a 404 bills nothing), then release the hold.
    // Our key bills 1 credit per organization returned; treg bills what its header says, matched or not.
    const ownBilled = fetched.filter((r) => r.tregCostMicro === null).length;
    const tregMicro = results.reduce((n, r) => n + (r.tregCostMicro ?? 0), 0);
    const costItems = [
      ...(ownBilled > 0 ? [{ costName: COMPANY_FIRMOGRAPHICS_COST_NAME, costSource: keySource, quantity: ownBilled }] : []),
      ...tregCostItems(tregMicro),
    ];
    if (costItems.length > 0) {
      await addCosts(run.id, costItems, identity);
    }
    const failure = results.find((r) => r.error);
    await releaseHold(failure ? "failed" : "completed");
    if (failure) throw failure.error;

    return { kind: "ok" as const, orgs, creditsCharged: fetched.length };
  });
}

/**
 * GET /audiences/:apolloAudienceId/companies?offset=&limit= — up to 100
 * distinct companies where people of the audience work, in Apollo's rank
 * order, each with firmographics and the one person to write to. Chunked so a
 * consumer gets its first rows in a couple of seconds; repeat calls return the
 * same order and never pay twice for a company (global cache).
 * See src/lib/audience-companies.ts for how each step was measured.
 */
router.get("/audiences/:apolloAudienceId/companies", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = AudienceCompaniesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ type: "validation", error: "Invalid query", details: parsed.error.flatten() });
    }
    const { offset, limit } = parsed.data;
    if (!req.runId) {
      return res.status(400).json({ type: "validation", error: "x-run-id header required" });
    }
    const { apolloAudienceId } = req.params;

    const [row] = await db
      .select()
      .from(apolloAudiences)
      .where(and(eq(apolloAudiences.id, apolloAudienceId), eq(apolloAudiences.orgId, req.orgId!)))
      .limit(1);
    if (!row) {
      return res.status(404).json({ type: "not_found", error: "Audience not found" });
    }

    const brandIds = row.brandId ? [row.brandId] : req.brandIds;
    const tracking = { brandIds, campaignId: req.campaignId, audienceId: req.audienceId, featureSlug: req.featureSlug, workflowSlug: req.workflowSlug };
    const identity: IdentityHeaders = { orgId: req.orgId!, userId: req.userId, ...tracking };

    const { key: apolloApiKey, keySource } = await decryptKey(
      req.orgId!,
      req.userId!,
      "apollo",
      { callerMethod: "GET", callerPath: "/audiences/:apolloAudienceId/companies" },
      tracking,
    );
    assertKeySource(keySource);

    const filters = row.filters as Record<string, unknown>;
    const alertIdentity = toCreditAlertIdentity(req);
    const end = Math.min(offset + limit, MAX_COMPANIES);
    const collection = end > offset ? await collectEmployers(apolloApiKey, filters, end, alertIdentity) : { count: 0, employers: [], morePages: false };
    const chunk = collection.employers.slice(offset, end);

    const candidates = await mapConcurrent(chunk, LOOKUP_CONCURRENCY, (e) => resolveOrganization(apolloApiKey, filters, e, alertIdentity));
    const ids = [...new Set(candidates.map((c) => c?.id).filter((id): id is string => !!id))];
    const domains = new Map<string, string>();
    for (const c of candidates) {
      const domain = c ? normalizeDomain(c.domain) ?? normalizeDomain(c.website_url) : null;
      if (c && domain) domains.set(c.id, domain);
    }

    const enriched = await enrichOrganizations({ ids, domains, audienceRowId: row.id, apolloApiKey, keySource, identity, runId: req.runId, req });
    if (enriched.kind === "insufficient") {
      return res.status(402).json({
        type: "credit_insufficient",
        error: "Insufficient credits",
        balance_cents: enriched.balance_cents,
        required_cents: enriched.required_cents,
      });
    }

    const companies = chunk.map((e, i) => {
      const candidate = candidates[i];
      const org = candidate ? enriched.orgs.get(candidate.id) ?? null : null;
      return { rank: offset + i + 1, name: e.name, ...toFirmographics(candidate, org), peopleInSample: e.peopleInSample, person: e.person };
    });

    res.json({
      apolloAudienceId: row.id,
      count: collection.count,
      offset,
      limit,
      companies,
      hasMore: end < MAX_COMPANIES && (collection.employers.length > end || collection.morePages),
      creditsCharged: enriched.creditsCharged,
    });
  } catch (error) {
    console.error("[Apollo Service][GET /audiences/:id/companies] ERROR:", error);
    if (error instanceof SignalNotApolloSearchableError) return res.status(400).json({ type: "validation", error: error.message });
    res.status(500).json({ type: "internal", error: error instanceof Error ? error.message : "Internal server error", ...providerErrorFields(error) });
  }
});

/**
 * POST /audiences/:apolloAudienceId/dry-run — re-count the stored filters via a
 * free Apollo dry-run and refresh the count snapshot. Returns { count }.
 */
router.post("/audiences/:apolloAudienceId/dry-run", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { apolloAudienceId } = req.params;

    const [row] = await db
      .select()
      .from(apolloAudiences)
      .where(and(eq(apolloAudiences.id, apolloAudienceId), eq(apolloAudiences.orgId, req.orgId!)))
      .limit(1);

    if (!row) {
      return res.status(404).json({ type: "not_found", error: "Audience not found" });
    }

    const { key: apolloApiKey } = await decryptKey(
      req.orgId!,
      req.userId!,
      "apollo",
      { callerMethod: "POST", callerPath: "/audiences/:apolloAudienceId/dry-run" },
      { brandIds: row.brandId ? [row.brandId] : req.brandIds, featureSlug: req.featureSlug, workflowSlug: req.workflowSlug },
    );

    const count = await dryRunCount(apolloApiKey, row.filters as Record<string, unknown>, toCreditAlertIdentity(req));

    await db
      .update(apolloAudiences)
      .set({ count, countRefreshedAt: new Date(), updatedAt: new Date() })
      .where(eq(apolloAudiences.id, apolloAudienceId));

    res.json({ count });
  } catch (error) {
    console.error("[Apollo Service][POST /audiences/:id/dry-run] ERROR:", error);
    if (error instanceof SignalNotApolloSearchableError) return res.status(400).json({ type: "validation", error: error.message });
    res.status(500).json({ type: "internal", error: error instanceof Error ? error.message : "Internal server error", ...providerErrorFields(error) });
  }
});

// ─── Buying-signal audiences (src/lib/buying-signals.ts) ────────────────────

const SIGNAL_LABELS: Record<BuyingSignalType, string> = {
  hiring: "Hiring",
  job_change: "New in role",
  funding: "Recently funded",
  linkedin_engagement: "Engaged with competitor posts",
};

function signalLabel(spec: BuyingSignalSpec): string {
  const roles = spec.type === "hiring" && spec.job_titles?.length ? ` ${spec.job_titles.join(" / ")}` : "";
  return `${SIGNAL_LABELS[spec.type]}${roles} (last ${spec.window_days} days)`;
}

/**
 * People AND distinct employers a signal filter set matches, free (teaser pages
 * of 100). A people count alone hides concentration: measured 2026-09-29, one
 * "recently funded" audience held 217 people at 2 companies. Employers are
 * counted over the first COVERAGE_MAX_PAGES pages, exact when the pool fits.
 */
const COVERAGE_MAX_PAGES = 5;
async function countSignalEmployers(
  apiKey: string,
  filters: Record<string, unknown>,
  alert: ReturnType<typeof toCreditAlertIdentity>,
): Promise<{ count: number; companies: number; companiesExact: boolean }> {
  const params = toApolloSearchParams(filters);
  const names = new Set<string>();
  let count = 0;
  let walked = 0;
  for (let page = 1; page <= COVERAGE_MAX_PAGES; page++) {
    const res = await searchPeople(apiKey, { ...params, page, per_page: 100 }, alert);
    count = res.total_entries ?? res.pagination?.total_entries ?? 0;
    const people = res.people ?? [];
    for (const p of people as Array<{ organization?: { name?: string | null } | null }>) {
      const name = p.organization?.name;
      if (typeof name === "string" && name.trim()) names.add(normalizeCompanyName(name));
    }
    walked += people.length;
    if (people.length < 100 || walked >= count) break;
  }
  return { count, companies: names.size, companiesExact: walked >= count };
}

/** The ICP a signal request starts from: a stored audience of this org, or inline filters. */
async function loadSignalBase(
  orgId: string,
  body: { apolloAudienceId?: string; filters?: Record<string, unknown> },
): Promise<{ filters: Record<string, unknown>; name: string | null; brandId: string | null } | null> {
  if (body.filters) return { filters: body.filters, name: null, brandId: null };
  const [row] = await db
    .select()
    .from(apolloAudiences)
    .where(and(eq(apolloAudiences.id, body.apolloAudienceId!), eq(apolloAudiences.orgId, orgId)))
    .limit(1);
  if (!row) return null;
  return { filters: row.filters as Record<string, unknown>, name: row.name, brandId: row.brandId };
}

/**
 * POST /audiences/signal-coverage — how many verified-email people each buying
 * signal yields for one ICP, per window. Free (teaser counts), nothing stored.
 */
router.post("/audiences/signal-coverage", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = SignalCoverageRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ type: "validation", error: "Invalid request", details: parsed.error.flatten() });
    }
    const base = await loadSignalBase(req.orgId!, parsed.data);
    if (!base) return res.status(404).json({ type: "not_found", error: "Audience not found" });
    const icp = { ...base.filters };
    delete icp.buying_signal;

    const { key: apolloApiKey } = await decryptKey(
      req.orgId!,
      req.userId!,
      "apollo",
      { callerMethod: "POST", callerPath: "/audiences/signal-coverage" },
      { brandIds: base.brandId ? [base.brandId] : req.brandIds, featureSlug: req.featureSlug, workflowSlug: req.workflowSlug },
    );
    const alert = toCreditAlertIdentity(req);
    const windows = parsed.data.windowDays ?? [30, 90];
    const jobTitles = parsed.data.jobTitles?.length ? parsed.data.jobTitles : undefined;

    const specs: BuyingSignalSpec[] = APOLLO_BUYING_SIGNAL_TYPES.flatMap((type) =>
      windows.map((window_days) => ({ type, window_days, ...(type === "hiring" && jobTitles ? { job_titles: jobTitles } : {}) })),
    );
    for (const spec of specs) {
      const conflicts = signalConflicts({ ...icp, buying_signal: spec });
      if (conflicts.length > 0) {
        return res.status(400).json({ type: "validation", error: `The ICP already sets ${conflicts.join(", ")}, which the ${spec.type} signal drives`, fields: conflicts });
      }
    }
    const baseCount = await dryRunCount(apolloApiKey, icp, alert);
    // Sequential on purpose: Apollo's people search allows 200 calls a minute.
    const signals = [];
    for (const spec of specs) {
      const { count, companies, companiesExact } = await countSignalEmployers(apolloApiKey, { ...icp, buying_signal: spec }, alert);
      signals.push({ type: spec.type, windowDays: spec.window_days, jobTitles: spec.job_titles ?? null, count, companies, companiesExact });
    }
    res.json({ measuredOn: utcDay(new Date()), baseCount, signals });
  } catch (error) {
    console.error("[Apollo Service][POST /audiences/signal-coverage] ERROR:", error);
    if (error instanceof SignalNotApolloSearchableError) return res.status(400).json({ type: "validation", error: error.message });
    res.status(500).json({ type: "internal", error: error instanceof Error ? error.message : "Internal server error", ...providerErrorFields(error) });
  }
});

/**
 * POST /audiences/signal — persist an audience = ICP + one buying signal + a
 * recency window, with its free size estimate. The stored filters carry the
 * RELATIVE signal, so a consumer forwarding them to /search/next verbatim gets
 * a rolling audience.
 */
router.post("/audiences/signal", serviceAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = CreateSignalAudienceRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ type: "validation", error: "Invalid request", details: parsed.error.flatten() });
    }
    const base = await loadSignalBase(req.orgId!, parsed.data);
    if (!base) return res.status(404).json({ type: "not_found", error: "Audience not found" });

    const { type, windowDays, jobTitles, competitorPages } = parsed.data.signal;
    if (jobTitles?.length && type !== "hiring") {
      return res.status(400).json({ type: "validation", error: "jobTitles is only valid for the hiring signal" });
    }
    if (type === "linkedin_engagement") {
      return await createLinkedinEngagementAudience(req, res, { base, windowDays, competitorPages, name: parsed.data.name, brandId: parsed.data.brandId });
    }
    if (competitorPages) {
      return res.status(400).json({ type: "validation", error: "competitorPages is only valid for the linkedin_engagement signal" });
    }
    const spec: BuyingSignalSpec = { type, window_days: windowDays, ...(jobTitles?.length ? { job_titles: jobTitles } : {}) };
    const icp = { ...base.filters };
    delete icp.buying_signal;
    const filters = { ...icp, buying_signal: spec };
    const checked = SearchFiltersSchema.safeParse(filters);
    if (!checked.success) {
      return res.status(400).json({ type: "validation", error: "Invalid filters", details: checked.error.flatten() });
    }
    const conflicts = signalConflicts(filters);
    if (conflicts.length > 0) {
      return res.status(400).json({ type: "validation", error: `The ICP already sets ${conflicts.join(", ")}, which the ${type} signal drives`, fields: conflicts });
    }

    const brandId = parsed.data.brandId ?? base.brandId ?? req.brandIds?.[0] ?? null;
    const { key: apolloApiKey } = await decryptKey(
      req.orgId!,
      req.userId!,
      "apollo",
      { callerMethod: "POST", callerPath: "/audiences/signal" },
      { brandIds: brandId ? [brandId] : req.brandIds, featureSlug: req.featureSlug, workflowSlug: req.workflowSlug },
    );
    const count = await dryRunCount(apolloApiKey, filters, toCreditAlertIdentity(req));
    const now = new Date();
    const window = signalWindow(spec, now);
    const label = signalLabel(spec);
    const name = parsed.data.name ?? (base.name ? `${base.name} · ${label}` : label);
    const description = `${base.name ? `People of the "${base.name}" audience` : "People matching the ICP filters"} whose ${
      type === "job_change" ? "current role started" : type === "funding" ? "employer raised its latest funding round" : "employer posted a job"
    } in the last ${windowDays} days${type === "hiring" && jobTitles?.length ? ` (roles: ${jobTitles.join(", ")})` : ""}. The window rolls: each day serves the signals that are new since the last serve.`;

    const [row] = await db
      .insert(apolloAudiences)
      .values({ orgId: req.orgId!, userId: req.userId ?? null, brandId, name, description, filters, count, countRefreshedAt: now })
      .returning();

    res.json({ apolloAudienceId: row.id, name, description, filters, count, window });
  } catch (error) {
    console.error("[Apollo Service][POST /audiences/signal] ERROR:", error);
    if (error instanceof SignalNotApolloSearchableError) return res.status(400).json({ type: "validation", error: error.message });
    res.status(500).json({ type: "internal", error: error instanceof Error ? error.message : "Internal server error", ...providerErrorFields(error) });
  }
});

/**
 * POST /audiences/signal for linkedin_engagement: persists the criterion only.
 * No Apollo count exists for it (its people are competitor post engagers) and
 * reading the posts is a paid step, so the size is null until the first serve.
 */
async function createLinkedinEngagementAudience(
  req: AuthenticatedRequest,
  res: Response,
  args: {
    base: { filters: Record<string, unknown>; name: string | null; brandId: string | null };
    windowDays: number;
    competitorPages: string[] | undefined;
    name: string | undefined;
    brandId: string | undefined;
  },
) {
  if (!args.competitorPages?.length) {
    return res.status(400).json({ type: "validation", error: "competitorPages (1-3 LinkedIn company page URLs) is required for the linkedin_engagement signal", fields: ["signal.competitorPages"] });
  }
  const beside = filtersBesideEngagement(args.base.filters);
  if (beside.length > 0) {
    return res.status(400).json({ type: "validation", error: `Apollo filters cannot be combined with the linkedin_engagement signal (its people are LinkedIn engagers, not an Apollo search): ${beside.join(", ")}`, fields: beside });
  }
  const pages = args.competitorPages.map((u) => parseCompetitorPage(u)!);
  const spec: BuyingSignalSpec = { type: "linkedin_engagement", window_days: args.windowDays, competitor_pages: pages.map((p) => p.url) };
  const filters = { buying_signal: spec };
  const checked = SearchFiltersSchema.safeParse(filters);
  if (!checked.success) {
    return res.status(400).json({ type: "validation", error: "Invalid filters", details: checked.error.flatten() });
  }
  const now = new Date();
  const label = `${SIGNAL_LABELS.linkedin_engagement} (${pages.map((p) => p.slug).join(", ")}, last ${args.windowDays} days)`;
  const name = args.name ?? label;
  const description = `People who reacted to or commented on a LinkedIn post published in the last ${args.windowDays} days by ${pages.map((p) => p.slug).join(", ")}. Their own employees are excluded. Each person's work email is found and verified before it is used.`;
  const brandId = args.brandId ?? args.base.brandId ?? req.brandIds?.[0] ?? null;
  const [row] = await db
    .insert(apolloAudiences)
    .values({ orgId: req.orgId!, userId: req.userId ?? null, brandId, name, description, filters, count: 0, countRefreshedAt: now })
    .returning();
  res.json({ apolloAudienceId: row.id, name, description, filters, count: null, window: signalWindow(spec, now) });
}

export default router;
