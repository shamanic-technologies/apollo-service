/**
 * FACTORY-P3 next outcomes (email_found): the verification WATERFALL as a STORED SCRIPT (workflow-service
 * `email_found/<dynasty>`, its code in the database, proven 100 % on recorded decisions) instead of this repo's
 * `stepOne` + `secondOpinion` orchestration, while workflow-service says the outcome is switched for this service.
 *
 * No workflow step calls the waterfall (every reveal and `POST /email-verifications` does, inside this service), so the
 * switch is a SERVICE switch held by workflow-service (`GET /internal/scripts/switches/service`, read at most once a
 * minute here); its roll-back guard flips it back when the script errs more than our own decisions did.
 *
 * What moves into the script: which verifier is asked, in which order, when the next one is asked, when BounceBan
 * decides, and the decision itself. What stays here (the script's metered DOORS, `POST /internal/email-verifier-calls`
 * and `GET /internal/email-verifier-calls/apify`): each verifier call with its billing hold, its run, its bronze row
 * (the verdict other surfaces reuse for 30 days), its `email_checked` declaration, the Apify-out timer, BounceBan's
 * polling and resume. The 30-day reuse of a held verdict stays before the script (a held final verdict asks nothing).
 *
 * The doors serve ONLY a verification in flight here: the script's vendor calls carry the caller's run
 * (`x-caller-run-id`), and the door finds the verification context this service registered for (that run, that
 * address). A refusal a door meets (billing, key, BounceBan still running) is kept and re-thrown to the caller as the
 * SAME error our own code would have thrown, so every reveal / verification route answers exactly as before.
 */
import { randomUUID } from "node:crypto";
import type { NamedSubject } from "./outcome-declarations.js";

export const EMAIL_FOUND_OUTCOME = "email_found";
export const CALLER_SERVICE = "apollo";
const STATE_TTL_MS = 60_000;
const RUN_TIMEOUT_MS = 600_000;

export interface VerifyScriptSwitch {
  switched: boolean;
  dynasty: string | null;
}

let cached: { state: VerifyScriptSwitch; at: number } | null = null;

/** Test hook. */
export function resetVerifyScriptSwitchMemo(): void {
  cached = null;
}

function workflow(): { base: string; key: string } {
  const base = (process.env.WORKFLOW_SERVICE_URL ?? "").replace(/\/$/, "");
  const key = process.env.WORKFLOW_SERVICE_API_KEY ?? "";
  if (!base || !key) throw new Error("[Apollo Service] WORKFLOW_SERVICE_URL and WORKFLOW_SERVICE_API_KEY are required for the verification switch");
  return { base, key };
}

/** Whether the waterfall runs as the stored script now. Unreadable = the last state read; never read = our own code. */
export async function verifyScriptSwitch(now = Date.now()): Promise<VerifyScriptSwitch> {
  if (cached && now - cached.at < STATE_TTL_MS) return cached.state;
  try {
    const { base, key } = workflow();
    const q = new URLSearchParams({ outcome: EMAIL_FOUND_OUTCOME, callerService: CALLER_SERVICE });
    const res = await fetch(`${base}/internal/scripts/switches/service?${q}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`GET /internal/scripts/switches/service -> ${res.status}: ${text.slice(0, 200)}`);
    const body = JSON.parse(text) as { switched?: unknown; dynasty?: unknown };
    const state: VerifyScriptSwitch = body.switched === true && typeof body.dynasty === "string" && body.dynasty ? { switched: true, dynasty: body.dynasty } : { switched: false, dynasty: null };
    cached = { state, at: now };
    return state;
  } catch (error) {
    const kept = cached?.state ?? { switched: false, dynasty: null };
    console.error(`[Apollo Service] verification switch: state unreadable, keeping ${kept.switched ? `the script ${kept.dynasty}` : "our own code"}: ${error instanceof Error ? error.message : String(error)}`);
    cached = { state: kept, at: now };
    return kept;
  }
}

/** One recorded vendor call of a decision, in the script's own words (what a replay answers it with). */
export interface DecisionCall {
  name: string;
  args?: Record<string, unknown>;
  answer: { ok: boolean; data: Record<string, unknown> };
}

/** A verification in flight, served to the script's doors. */
export interface InFlight<Ctx> {
  token: string;
  email: string;
  ctx: Ctx;
  /** The vendor calls answered so far, in order (the decision's record). */
  calls: DecisionCall[];
  /** The error our own code would have thrown at that point (re-thrown to the caller). */
  thrown: Error | null;
}

const inFlight = new Map<string, Array<InFlight<unknown>>>();
const key = (callerRunId: string, email: string) => `${callerRunId}\u0000${email}`;

export function registerInFlight<Ctx>(callerRunId: string, email: string, ctx: Ctx): InFlight<Ctx> {
  const entry: InFlight<Ctx> = { token: randomUUID(), email, ctx, calls: [], thrown: null };
  const k = key(callerRunId, email);
  inFlight.set(k, [...(inFlight.get(k) ?? []), entry as InFlight<unknown>]);
  return entry;
}

export function releaseInFlight(callerRunId: string, entry: InFlight<unknown>): void {
  const k = key(callerRunId, entry.email);
  const left = (inFlight.get(k) ?? []).filter((e) => e !== entry);
  if (left.length > 0) inFlight.set(k, left);
  else inFlight.delete(k);
}

/** The verification a door call is for: the oldest one in flight for (caller run, address). */
export function findInFlight<Ctx>(callerRunId: string, email: string): InFlight<Ctx> | null {
  return ((inFlight.get(key(callerRunId, email)) ?? [])[0] as InFlight<Ctx> | undefined) ?? null;
}

/** What the script door answers (only the fields a decision reads). */
export interface ScriptDecision {
  runId: string | null;
  scriptSlug: string | null;
  verificationId: string | null;
}

export class VerifyScriptError extends Error {
  constructor(message: string, readonly runId: string | null) {
    super(message);
  }
}

/**
 * Run the stored waterfall for one address on the caller's run. The material is the address and the verdict held for
 * it when a step-1 catch_all / unknown is reused (then only BounceBan runs). Throws `VerifyScriptError` on a refusal.
 */
export async function decideWithScript(input: {
  dynasty: string;
  orgId: string;
  userId: string;
  callerRunId: string;
  tracking: { brandIds?: string[]; campaignId?: string; audienceId?: string; featureSlug?: string; workflowSlug?: string };
  email: string;
  held: { verificationId: string; verifier: string; verdict: string } | null;
  subject?: NamedSubject;
}): Promise<ScriptDecision> {
  const { base, key: apiKey } = workflow();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "x-org-id": input.orgId,
    "x-user-id": input.userId,
    "x-run-id": input.callerRunId,
  };
  if (input.tracking.brandIds?.length) headers["x-brand-id"] = input.tracking.brandIds.join(",");
  if (input.tracking.campaignId) headers["x-campaign-id"] = input.tracking.campaignId;
  if (input.tracking.audienceId) headers["x-audience-id"] = input.tracking.audienceId;
  if (input.tracking.featureSlug) headers["x-feature-slug"] = input.tracking.featureSlug;
  if (input.tracking.workflowSlug) headers["x-workflow-slug"] = input.tracking.workflowSlug;
  const res = await fetch(`${base}/internal/scripts/run`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      outcome: EMAIL_FOUND_OUTCOME,
      dynasty: input.dynasty,
      subject: input.subject ? { service: input.subject.subjectService, id: input.subject.subjectId } : { service: "apollo", id: input.email },
      units: { email_found: { content: { email: input.email, held: input.held } } },
      recordedBy: CALLER_SERVICE,
    }),
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Named below by status.
  }
  const details = (res.ok ? body : ((body.details ?? {}) as Record<string, unknown>)) as Record<string, unknown>;
  const runId = typeof details.runId === "string" ? details.runId : null;
  if (!res.ok) throw new VerifyScriptError(`workflow-service POST /internal/scripts/run -> ${res.status}: ${String(body.error ?? text).slice(0, 400)}`, runId);
  const unit = (body.unit ?? null) as { content?: Record<string, unknown> } | null;
  const verificationId = typeof unit?.content?.verificationId === "string" ? unit.content.verificationId : null;
  if (body.status !== "made" || !verificationId) throw new VerifyScriptError(`the script made no decision (status ${String(body.status)})`, runId);
  return { runId, scriptSlug: typeof body.scriptSlug === "string" ? body.scriptSlug : null, verificationId };
}
