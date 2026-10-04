/**
 * HTTP client for runs-service
 * Centralized run tracking and cost management
 */

import { randomUUID } from "node:crypto";
import { recordOpenedHolds, recordSettledHold } from "./cost-hold-ledger.js";

const RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "https://runs.mcpfactory.org";
const RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "";
const RUNS_SERVICE_TIMEOUT_MS = Number(process.env.RUNS_SERVICE_TIMEOUT_MS) || 10_000;

/**
 * Waits before each RETRY of a runs-service call that timed out, could not
 * connect, or answered 5xx/429. runs-service stalls for seconds at a time when
 * its connection pool saturates under box load ("health probe exceeded 2000ms —
 * connection pool is saturated"), and a single 10s timeout used to fail the
 * whole request: every BounceVerify verification behind it 502'd and the
 * transactional mailing-list release skipped the address (2026-10-01).
 *
 * Retrying is write-safe because every write is idempotent on the runs-service
 * side: run creation and cost items carry an `idempotencyKey` (a replay returns
 * the original row, never a duplicate), and PATCH sets an absolute status.
 */
export const RUNS_RETRY_DELAYS_MS = [500, 2_000];

// ─── Types ───────────────────────────────────────────────────────────────────

/** Typed error thrown by runs-client. Distinguishes timeout/network/HTTP failures from generic errors. */
export class RunsServiceError extends Error {
  readonly kind: "timeout" | "network" | "http";
  readonly status?: number;
  readonly path: string;
  readonly method: string;
  readonly body?: string;
  constructor(args: { kind: "timeout" | "network" | "http"; path: string; method: string; status?: number; body?: string; message: string }) {
    super(args.message);
    this.name = "RunsServiceError";
    this.kind = args.kind;
    this.status = args.status;
    this.path = args.path;
    this.method = args.method;
    this.body = args.body;
  }
}

export interface Run {
  id: string;
  parentRunId: string | null;
  organizationId: string;
  userId: string | null;
  appId: string;
  brandId: string | null;
  campaignId: string | null;
  serviceName: string;
  taskName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunCost {
  id: string;
  runId: string;
  costName: string;
  costSource: "platform" | "org";
  quantity: string;
  status?: "provisioned" | "actual" | "cancelled" | "refunded";
  unitCostInUsdCents: string;
  totalCostInUsdCents: string;
  createdAt: string;
}

export interface DescendantRun {
  id: string;
  parentRunId: string | null;
  serviceName: string;
  taskName: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  costs: RunCost[];
  ownCostInUsdCents: string;
}

export interface RunWithOwnCost extends Run {
  ownCostInUsdCents: string;
}

export interface RunWithCosts extends Run {
  costs: RunCost[];
  ownCostInUsdCents: string;
  childrenCostInUsdCents: string;
  totalCostInUsdCents: string;
  descendantRuns: DescendantRun[];
}

export interface CreateRunParams {
  orgId: string;
  userId?: string;
  brandIds?: string[];
  campaignId?: string;
  audienceId?: string;
  featureSlug?: string;
  serviceName: string;
  taskName: string;
  parentRunId?: string;
  workflowSlug?: string;
}

export interface CostItem {
  costName: string;
  costSource: "platform" | "org";
  quantity: number;
  status?: "provisioned" | "actual" | "cancelled";
  /** runs-service per-run dedup key; generated when absent. */
  idempotencyKey?: string;
}

export interface ListRunsParams {
  orgId: string;
  userId?: string;
  brandIds?: string[];
  campaignId?: string;
  audienceId?: string;
  featureSlug?: string;
  serviceName?: string;
  taskName?: string;
  status?: string;
  parentRunId?: string;
  startedAfter?: string;
  startedBefore?: string;
  limit?: number;
  offset?: number;
}

// ─── Identity headers ────────────────────────────────────────────────────────

export interface IdentityHeaders {
  orgId: string;
  userId?: string;
  runId?: string;
  brandIds?: string[];
  campaignId?: string;
  audienceId?: string;
  featureSlug?: string;
  workflowSlug?: string;
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function runsRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; identity?: IdentityHeaders; extraHeaders?: Record<string, string> } = {}
): Promise<T> {
  const { method = "GET", body, identity, extraHeaders } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": RUNS_SERVICE_API_KEY,
    ...extraHeaders,
  };

  if (identity?.orgId) headers["x-org-id"] = identity.orgId;
  if (identity?.userId) headers["x-user-id"] = identity.userId;
  if (identity?.runId) headers["x-run-id"] = identity.runId;
  if (identity?.brandIds?.length) headers["x-brand-id"] = identity.brandIds.join(",");
  if (identity?.campaignId) headers["x-campaign-id"] = identity.campaignId;
  if (identity?.audienceId) headers["x-audience-id"] = identity.audienceId;
  if (identity?.featureSlug) headers["x-feature-slug"] = identity.featureSlug;
  if (identity?.workflowSlug) headers["x-workflow-slug"] = identity.workflowSlug;

  for (let attempt = 0; ; attempt++) {
    try {
      return await runsAttempt<T>(path, method, headers, body);
    } catch (err) {
      const retryable =
        err instanceof RunsServiceError &&
        (err.kind !== "http" || (err.status !== undefined && (err.status >= 500 || err.status === 429)));
      if (!retryable || attempt >= RUNS_RETRY_DELAYS_MS.length) throw err;
      console.warn(`[Apollo Service] runs-service retry ${attempt + 1}/${RUNS_RETRY_DELAYS_MS.length}: ${(err as Error).message}`);
      await new Promise((resolve) => setTimeout(resolve, RUNS_RETRY_DELAYS_MS[attempt]));
    }
  }
}

async function runsAttempt<T>(
  path: string,
  method: string,
  headers: Record<string, string>,
  body: unknown
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUNS_SERVICE_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${RUNS_SERVICE_URL}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new RunsServiceError({
        kind: "timeout",
        path,
        method,
        message: `runs-service ${method} ${path} timed out after ${RUNS_SERVICE_TIMEOUT_MS}ms`,
      });
    }
    throw new RunsServiceError({
      kind: "network",
      path,
      method,
      message: `runs-service ${method} ${path} network error: ${(err as Error).message}`,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new RunsServiceError({
      kind: "http",
      path,
      method,
      status: response.status,
      body: errorText,
      message: `runs-service ${method} ${path} failed: ${response.status} - ${errorText}`,
    });
  }

  return response.json() as Promise<T>;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a new run in runs-service.
 * orgId/userId sent as x-org-id/x-user-id headers.
 * parentRunId sent as x-run-id header (becomes parentRunId on runs-service side).
 */
export async function createRun(params: CreateRunParams): Promise<Run> {
  return runsRequest<Run>("/v1/runs", {
    method: "POST",
    identity: {
      orgId: params.orgId,
      userId: params.userId,
      runId: params.parentRunId,
    },
    body: {
      brandIds: params.brandIds,
      campaignId: params.campaignId,
      audienceId: params.audienceId,
      featureSlug: params.featureSlug,
      serviceName: params.serviceName,
      taskName: params.taskName,
      workflowSlug: params.workflowSlug,
      // One key per logical create: a retry after a lost answer returns the
      // run already created instead of opening a second one.
      idempotencyKey: `apollo-service:run:${randomUUID()}`,
    },
  });
}

/**
 * Update run status (completed or failed).
 */
export async function updateRun(
  runId: string,
  status: "completed" | "failed",
  identity: IdentityHeaders
): Promise<Run> {
  return runsRequest<Run>(`/v1/runs/${runId}`, {
    method: "PATCH",
    identity: { ...identity, runId },
    body: { status },
  });
}

/**
 * Add cost line items to a run.
 * Cost names must be registered in costs-service.
 * costSource is required: "platform" or "org".
 */
export async function addCosts(
  runId: string,
  items: CostItem[],
  identity: IdentityHeaders
): Promise<{ costs: RunCost[] }> {
  const result = await runsRequest<{ costs: RunCost[] }>(`/v1/runs/${runId}/costs`, {
    method: "POST",
    identity: { ...identity, runId },
    // Per-item key so a retry after a lost answer replays the rows already
    // written instead of declaring the cost twice.
    body: { items: items.map((i) => ({ ...i, idempotencyKey: i.idempotencyKey ?? `apollo-service:cost:${randomUUID()}` })) },
  });
  if (items.some((i) => i.status === "provisioned")) {
    const opened = (result.costs ?? []).filter((c) => c.status === "provisioned");
    try {
      await recordOpenedHolds(
        opened.map((c) => ({ costId: c.id, runId, costName: c.costName, costSource: c.costSource, quantity: c.quantity })),
        identity
      );
    } catch (err) {
      // A hold missing from the ledger could never be reconciled if its request
      // dies, so it must not outlive this failure: release it now, then fail the
      // request loudly (the caller's own error path sees no hold id to release).
      console.error(`[Apollo Service] cost_holds.record_failed run=${runId} — releasing ${opened.length} hold(s)`, err);
      for (const c of opened) {
        await updateCostStatus(runId, c.id, "cancelled", identity);
      }
      throw err;
    }
  }
  return result;
}

/**
 * Update a cost item's status (provisioned → actual or cancelled).
 */
export async function updateCostStatus(
  runId: string,
  costId: string,
  status: "actual" | "provisioned" | "cancelled",
  identity: IdentityHeaders
): Promise<RunCost> {
  const cost = await runsRequest<RunCost>(`/v1/runs/${runId}/costs/${costId}`, {
    method: "PATCH",
    identity: { ...identity, runId },
    body: { status },
  });
  if (status !== "provisioned") {
    // The money write above succeeded, so this is bookkeeping: a failure here is
    // logged, and the reconciler marks the row settled when it finds the hold
    // already closed in runs-service.
    await recordSettledHold(costId, status, "request").catch((err) =>
      console.error(`[Apollo Service] cost_holds.settle_record_failed run=${runId} cost=${costId}`, err)
    );
  }
  return cost;
}

/**
 * Error-path helper: fail a run the request opened and never closed, so it is
 * not left `running` forever. The request is already failing with its own
 * error; a failure HERE is logged loudly and must not replace that error.
 */
export async function failOpenRun(
  open: { id: string; identity: IdentityHeaders } | null,
  where: string
): Promise<void> {
  if (!open) return;
  await updateRun(open.id, "failed", open.identity).catch((err) =>
    console.error(`[Apollo Service][${where}] run.mark_failed_failed run=${open.id}`, err)
  );
}

/**
 * Get a single run with costs (including descendant runs and their costs).
 */
export async function getRun(runId: string, identity: IdentityHeaders): Promise<RunWithCosts> {
  return runsRequest<RunWithCosts>(`/v1/runs/${runId}`, {
    identity: { ...identity, runId },
  });
}

/**
 * List runs with filters.
 * orgId sent as x-org-id header (not query param).
 */
export async function listRuns(
  params: ListRunsParams
): Promise<{ runs: RunWithOwnCost[]; limit: number; offset: number }> {
  const searchParams = new URLSearchParams();
  if (params.userId) searchParams.set("userId", params.userId);
  if (params.brandIds?.length) searchParams.set("brandIds", params.brandIds.join(","));
  if (params.campaignId) searchParams.set("campaignId", params.campaignId);
  if (params.audienceId) searchParams.set("audienceId", params.audienceId);
  if (params.serviceName) searchParams.set("serviceName", params.serviceName);
  if (params.taskName) searchParams.set("taskName", params.taskName);
  if (params.status) searchParams.set("status", params.status);
  if (params.parentRunId) searchParams.set("parentRunId", params.parentRunId);
  if (params.startedAfter) searchParams.set("startedAfter", params.startedAfter);
  if (params.startedBefore) searchParams.set("startedBefore", params.startedBefore);
  if (params.limit) searchParams.set("limit", String(params.limit));
  if (params.offset) searchParams.set("offset", String(params.offset));

  return runsRequest<{ runs: RunWithOwnCost[]; limit: number; offset: number }>(
    `/v1/runs?${searchParams.toString()}`,
    { identity: { orgId: params.orgId, userId: params.userId } }
  );
}

/**
 * Fetch multiple runs with costs in parallel.
 * Returns a Map of runId → RunWithCosts.
 */
export async function getRunsBatch(
  runIds: string[],
  identity: IdentityHeaders
): Promise<Map<string, RunWithCosts>> {
  if (runIds.length === 0) return new Map();
  const results = await Promise.all(runIds.map((id) => getRun(id, identity)));
  return new Map(results.map((r) => [r.id, r]));
}

// ─── Platform runs (org-less spend) ─────────────────────────────────────────
//
// For a caller with no org (a platform job such as the distribute.you visit
// recap). runs-service records the run with no organization; costs are posted
// with costSource "platform" as `actual` once the vendor answered. There is no
// org balance to authorize against and no provisioned hold.

const PLATFORM_HEADERS = { "x-service-name": "apollo-service" };

export async function createPlatformRun(params: { taskName: string; idempotencyKey: string }): Promise<{ id: string }> {
  return runsRequest<{ id: string }>("/v1/platform-runs", {
    method: "POST",
    extraHeaders: PLATFORM_HEADERS,
    body: { serviceName: "apollo-service", taskName: params.taskName, idempotencyKey: params.idempotencyKey },
  });
}

export async function addPlatformRunCosts(
  runId: string,
  items: Array<{ costName: string; quantity: number; idempotencyKey: string }>
): Promise<{ costs: RunCost[] }> {
  return runsRequest<{ costs: RunCost[] }>(`/v1/platform-runs/${runId}/costs`, {
    method: "POST",
    extraHeaders: PLATFORM_HEADERS,
    body: { items: items.map((i) => ({ ...i, costSource: "platform", status: "actual" })) },
  });
}

export async function updatePlatformRun(runId: string, status: "completed" | "failed"): Promise<void> {
  await runsRequest(`/v1/platform-runs/${runId}`, { method: "PATCH", extraHeaders: PLATFORM_HEADERS, body: { status } });
}
