/**
 * A METERED treg call for the people sources that are cheap but no longer free
 * (APOLLO-ZERO-COST-1119: Leadsforge started billing $0.005 per search through
 * treg at 2026-11-20 00:06 UTC while its catalog entry still read "free"; our
 * free-only guard then refused every call). Same protocol as every treg spend
 * here: one child run per request, PROVISION the ceiling, AUTHORIZE it
 * (platform key), call, post treg's own `X-Treg-Cost-Micro` as `actual`
 * (`treg-micro-usd`), cancel the hold. A call that bills 0 costs nothing.
 */

import { authorizeCredit } from "./billing-client.js";
import { addCosts, createRun, updateCostStatus, updateRun, type IdentityHeaders } from "./runs-client.js";
import { decryptKey, type TrackingContext } from "./keys-client.js";
import { assertKeySource } from "./validators.js";
import { TREG_COST_NAME } from "./email-finders.js";

/** Most a single free-source search may bill: 2x the measured $0.005, so a price jump stops loud. */
export const FREE_SOURCE_MAX_MICRO = 10_000;

export class TregMeterCreditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TregMeterCreditError";
  }
}

export interface TregMeterContext {
  identity: IdentityHeaders;
  userId: string;
  runId: string | undefined;
  tracking: TrackingContext;
  callerPath: string;
  taskName: string;
}

export interface TregMeterAnswer {
  status: number;
  body: unknown;
  chargedMicro: number;
}

export class TregMeter {
  private run: Promise<{ id: string }> | null = null;
  private keys: Promise<{ token: string; org: string; keySource: "org" | "platform" }> | null = null;

  constructor(private readonly ctx: TregMeterContext) {}

  private resolveKeys() {
    if (!this.keys) {
      const caller = { callerMethod: "POST", callerPath: this.ctx.callerPath };
      this.keys = (async () => {
        const { key: token, keySource } = await decryptKey(this.ctx.identity.orgId, this.ctx.userId, "treg", caller, this.ctx.tracking);
        assertKeySource(keySource);
        const { key: org } = await decryptKey(this.ctx.identity.orgId, this.ctx.userId, "treg-org", caller, this.ctx.tracking);
        return { token, org, keySource };
      })();
      this.keys.catch(() => {
        this.keys = null;
      });
    }
    return this.keys;
  }

  private ensureRun(): Promise<{ id: string }> {
    if (!this.run) {
      const { identity } = this.ctx;
      this.run = createRun({
        orgId: identity.orgId,
        userId: identity.userId,
        brandIds: identity.brandIds,
        campaignId: identity.campaignId,
        audienceId: identity.audienceId,
        featureSlug: identity.featureSlug,
        workflowSlug: identity.workflowSlug,
        serviceName: "apollo-service",
        taskName: this.ctx.taskName,
        parentRunId: this.ctx.runId,
      });
      this.run.catch(() => {
        this.run = null;
      });
    }
    return this.run;
  }

  /** POST `body` to a treg catalog endpoint, metered. Throws only on OUR failures; the vendor's status is returned. */
  async post(endpoint: string, body: Record<string, unknown>, opts: { query?: string; timeoutMs: number; maxMicro?: number }): Promise<TregMeterAnswer> {
    const { identity } = this.ctx;
    const maxMicro = opts.maxMicro ?? FREE_SOURCE_MAX_MICRO;
    const keys = await this.resolveKeys();
    const runId = (await this.ensureRun()).id;
    const provisioned = await addCosts(runId, [{ costName: TREG_COST_NAME, costSource: keys.keySource, quantity: maxMicro, status: "provisioned" }], identity);
    const holdId = provisioned.costs?.[0]?.id ?? null;
    if (!holdId) throw new Error(`runs-service returned no cost id for the ${TREG_COST_NAME} hold`);
    if (keys.keySource === "platform") {
      const auth = await authorizeCredit({
        items: [{ costName: TREG_COST_NAME, quantity: maxMicro }],
        description: `${this.ctx.taskName}: ${endpoint}`,
        orgId: identity.orgId,
        userId: this.ctx.userId,
        runId: this.ctx.runId,
        ...this.ctx.tracking,
      });
      if (!auth.sufficient) {
        await updateCostStatus(runId, holdId, "cancelled", identity);
        throw new TregMeterCreditError(`${endpoint}: credit refused (${JSON.stringify(auth).slice(0, 200)})`);
      }
    }
    // A network failure may have reached treg and been billed: it propagates and the
    // hold stays for the reconciler (src/lib/hold-reconciler.ts).
    const response = await fetch(`https://treg.to/call/${endpoint}${opts.query ? `?${opts.query}` : ""}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Treg-Token": keys.token, "X-Treg-Org": keys.org, "Cache-Control": "no-cache" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { _raw: text.slice(0, 2000) };
    }
    const costHeader = response.headers.get("x-treg-cost-micro");
    let charged = costHeader === null || costHeader.trim() === "" ? null : Number(costHeader);
    if (charged === null || !Number.isFinite(charged)) {
      if (response.status === 200) throw new Error(`${endpoint}: treg answered 200 without X-Treg-Cost-Micro, the charge cannot be declared`);
      charged = 0; // treg bills nothing for a relayed failure
    }
    if (charged > 0) await addCosts(runId, [{ costName: TREG_COST_NAME, costSource: keys.keySource, quantity: charged }], identity);
    await updateCostStatus(runId, holdId, "cancelled", identity);
    if (charged > maxMicro) console.error(`[apollo-service][treg-meter] ${endpoint} billed ${charged} micro-USD, above the ${maxMicro} ceiling (declared as billed)`);
    return { status: response.status, body: parsed, chargedMicro: charged };
  }

  async finish(status: "completed" | "failed"): Promise<void> {
    if (this.run) await updateRun((await this.run).id, status, this.ctx.identity);
  }
}
