/**
 * Agentic "NL segment → faithful Apollo filters" refinement loop.
 *
 * This logic moved OUT of human-service INTO apollo-service: given a segment
 * name + self-contained description, iterate faithful Apollo People-Search
 * filter sets, use the FREE dry-run as live count feedback, and let the model
 * decide test/confirm/exhausted. The confirmed faithful filters + a count
 * snapshot are persisted by the caller (POST /audiences/suggest-from-segment).
 *
 * The LLM call goes through chat-service (which owns the LLM cost). The dry-run
 * Apollo people-search (per_page=1) consumes NO Apollo credits, so this loop
 * declares no cost of its own — same as POST /search/dry-run.
 */

import { z } from "zod";
import { chatComplete, type ChatTrackingHeaders } from "./chat-client.js";
import { toApolloSearchParams } from "./transform.js";
import { searchPeople } from "./apollo-client.js";
import { SearchFiltersSchema } from "../schemas.js";

/** A "good" B2B audience lands in this count band. The server enforces it for
 * `confirm`; Apollo serves at most 50,000 records via pagination. */
const TARGET_MIN = 1_000;
const TARGET_MAX = 100_000;
/** Real dry-run attempts (each consumes a live count). The loop relaxes
 * constraints across these to cross the 1,000 floor. */
const MAX_REAL_ATTEMPTS = 6;
/** Extra budget for unusable model output (malformed decision JSON or filters
 * rejected by the faithful schema). These do NOT consume a real attempt — a
 * Gemini hiccup must not eat the relaxation budget. */
const MAX_INVALID_RETRIES = 3;

export interface RefineIteration {
  iteration: number;
  action: "test" | "confirm" | "invalid" | "rejected_confirm";
  filters: Record<string, unknown> | null;
  count: number | null;
  reasoning: string;
  validationErrors?: string[];
}

export interface RefineInput {
  name: string;
  description: string;
  /** The faithful-filter catalog (buildFiltersPrompt(SearchFiltersSchema)). */
  filtersPromptCatalog: string;
  apolloApiKey: string;
  tracking: ChatTrackingHeaders;
}

export interface RefineResult {
  filters: Record<string, unknown>;
  count: number;
  status: "confirmed" | "exhausted";
  trace: RefineIteration[];
}

/** Free Apollo dry-run: count people matching `filters` without spending credits. */
export async function dryRunCount(
  apolloApiKey: string,
  filters: Record<string, unknown>,
): Promise<number> {
  const apolloParams = { ...toApolloSearchParams(filters), page: 1, per_page: 1 };
  const result = await searchPeople(apolloApiKey, apolloParams);
  return result.total_entries ?? result.pagination?.total_entries ?? 0;
}

/** Model decision schema for one refine turn. */
const RefineDecisionSchema = z.object({
  action: z.enum(["test", "confirm"]),
  filters: z.record(z.string(), z.unknown()),
  reasoning: z.string().optional(),
});

function buildSystemPrompt(catalog: string): string {
  return [
    "You are apollo-service's audience builder. Convert a natural-language B2B segment",
    "into a faithful Apollo People Search filter set, then refine it using live match counts.",
    "",
    "You MUST only use the filter fields below, with Apollo's exact accepted values.",
    "Do NOT invent field names or values. Omit a field rather than guess. All filters AND together.",
    "",
    "=== AVAILABLE FILTERS (faithful Apollo vocabulary) ===",
    catalog,
    "=== END FILTERS ===",
    "",
    "PRIMARY GOAL: produce an audience with AT LEAST 1,000 matches (ideal band 1,000-100,000).",
    "An audience under 1,000 is a FAILURE unless 1,000 is genuinely unreachable. NEVER confirm",
    "a set whose count is below 1,000.",
    "",
    "RELAX AGGRESSIVELY to cross 1,000. When a filter set returns < 1,000 you MUST loosen or DROP",
    "constraints and test again. Drop the LEAST IMPORTANT constraints first and keep the most",
    "defining ones — YOU decide, for THIS specific request, which constraints matter least (a",
    "revenue or headcount band, a secondary keyword/technology, an overly tight seniority, etc.)",
    "and relax those before anything central. Stay as CLOSE as possible to the original request:",
    "preserve what the request is fundamentally about (who the user wants to reach) and shed the",
    "peripheral qualifiers until the count reaches 1,000.",
    "",
    "Too many (> 100,000) -> add back / tighten constraints toward the request.",
    "",
    "Each turn, reply with ONLY a JSON object (no prose, no code fences):",
    '{ "action": "test" | "confirm", "filters": { ...faithful filters... }, "reasoning": "<one short line>" }',
    '- "test": you want the live count for this filter set before deciding.',
    '- "confirm": this set is good (count >= 1,000 and <= 100,000) — stop and persist it.',
    "Only confirm when the count is >= 1,000. If you still cannot reach 1,000 after relaxing every",
    "non-essential constraint, spend your LAST turn testing your BROADEST set that still honors the",
    "core of the request, so the closest-possible audience is captured.",
  ].join("\n");
}

function buildUserMessage(
  input: RefineInput,
  history: RefineIteration[],
  realAttemptsUsed: number,
): string {
  const lines: string[] = [
    `Segment name: ${input.name}`,
    `Segment description: ${input.description}`,
    "",
  ];
  if (history.length === 0) {
    lines.push("No filter sets tried yet. Propose your first filter set with action \"test\".");
    return lines.join("\n");
  }

  lines.push("Filter sets tried so far (most recent last):");
  for (const h of history) {
    if (h.action === "invalid") {
      lines.push(`- INVALID (rejected by schema): ${JSON.stringify(h.filters)} — errors: ${(h.validationErrors ?? []).join("; ")}`);
    } else {
      lines.push(`- count=${h.count} for filters=${JSON.stringify(h.filters)}`);
    }
  }
  lines.push("");

  // Escalate when the most recent real count is still below the 1,000 floor:
  // tell the model exactly how many tests remain and force a constraint drop.
  const lastValid = [...history]
    .reverse()
    .find((h): h is RefineIteration & { count: number } => h.action !== "invalid" && h.count !== null);
  const remaining = MAX_REAL_ATTEMPTS - realAttemptsUsed;
  if (lastValid && lastValid.count < TARGET_MIN) {
    lines.push(
      `Latest count ${lastValid.count} is BELOW the 1,000 floor. You have ${remaining} test(s) left. ` +
        "DROP the constraint YOU judge least important for this request NOW and test a broader " +
        "set. Do NOT confirm below 1,000.",
    );
    if (remaining <= 1) {
      lines.push(
        "This is your LAST test — submit your BROADEST set that still honors the core of the " +
          "request, to capture the closest-possible audience.",
      );
    }
  } else {
    lines.push("Refine further (action \"test\") or finalize (action \"confirm\", only if count >= 1,000).");
  }
  return lines.join("\n");
}

/** Pick the best tried filter set when the loop exhausts without a confirm. */
function pickBest(history: RefineIteration[]): { filters: Record<string, unknown>; count: number } | null {
  const valid = history.filter(
    (h): h is RefineIteration & { filters: Record<string, unknown>; count: number } =>
      h.action !== "invalid" && h.filters !== null && h.count !== null,
  );
  if (valid.length === 0) return null;
  const inBand = valid.filter((h) => isInTargetBand(h.count));
  if (inBand.length > 0) {
    // Broadest coverage within band.
    return inBand.reduce((a, b) => (b.count > a.count ? b : a));
  }
  const positive = valid.filter((h) => h.count > 0);
  if (positive.length === 0) return null;
  // Otherwise closest to the band (distance to nearest edge).
  const dist = (c: number) => (c < TARGET_MIN ? TARGET_MIN - c : c - TARGET_MAX);
  return positive.reduce((a, b) => (dist(b.count) < dist(a.count) ? b : a));
}

function isInTargetBand(count: number): boolean {
  return count >= TARGET_MIN && count <= TARGET_MAX;
}

export async function refineAudience(input: RefineInput): Promise<RefineResult> {
  const systemPrompt = buildSystemPrompt(input.filtersPromptCatalog);
  const trace: RefineIteration[] = [];

  // Two separate budgets: MAX_REAL_ATTEMPTS live dry-runs (the relaxation budget),
  // plus MAX_INVALID_RETRIES extra turns for unusable model output that must NOT
  // eat a real attempt. `step` numbers the trace rows in order.
  let realAttempts = 0;
  let invalidRetries = 0;
  let step = 0;

  while (realAttempts < MAX_REAL_ATTEMPTS) {
    step += 1;
    const message = buildUserMessage(input, trace, realAttempts);
    const res = await chatComplete(
      {
        message,
        systemPrompt,
        // Google (Gemini) JSON mode, NOT Anthropic. chat-service requires a strict
        // `responseSchema` for Anthropic JSON mode (output_config.format), and a
        // strict Anthropic schema must list EVERY property as required with
        // additionalProperties:false — incompatible with the SPARSE Apollo filter
        // object the model emits (it picks a few of ~18 optional filters). Gemini
        // JSON mode needs no schema and returns free-form JSON, validated by the
        // Zod guards below. (chat-service owns the LLM cost either way.)
        provider: "google",
        model: "flash",
        responseFormat: "json",
        temperature: 0.2,
        maxTokens: 2000,
      },
      input.tracking,
    );

    const parsed = RefineDecisionSchema.safeParse(res.json);
    if (!parsed.success) {
      // Unusable decision shape — burns the retry budget, NOT a real attempt.
      invalidRetries += 1;
      trace.push({
        iteration: step,
        action: "invalid",
        filters: (res.json?.filters as Record<string, unknown>) ?? null,
        count: null,
        reasoning: "model decision did not match {action, filters}",
        validationErrors: parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`),
      });
      if (invalidRetries > MAX_INVALID_RETRIES) break;
      continue;
    }

    const { action, filters, reasoning } = parsed.data;

    // Validate the proposed filters against our faithful vocabulary.
    const filterCheck = SearchFiltersSchema.safeParse(filters);
    if (!filterCheck.success) {
      const flat = filterCheck.error.flatten();
      const validationErrors = [
        ...flat.formErrors,
        ...Object.entries(flat.fieldErrors).flatMap(([k, v]) => (v ?? []).map((m) => `${k}: ${m}`)),
      ];
      // Schema-invalid filters — burns the retry budget, NOT a real attempt.
      invalidRetries += 1;
      trace.push({ iteration: step, action: "invalid", filters, count: null, reasoning: reasoning ?? "", validationErrors });
      if (invalidRetries > MAX_INVALID_RETRIES) break;
      continue;
    }

    // A valid filter set we can dry-run — this consumes one real attempt.
    realAttempts += 1;
    const validFilters = filterCheck.data as Record<string, unknown>;
    const count = await dryRunCount(input.apolloApiKey, validFilters);

    if (action === "confirm" && isInTargetBand(count)) {
      trace.push({ iteration: step, action: "confirm", filters: validFilters, count, reasoning: reasoning ?? "" });
      return { filters: validFilters, count, status: "confirmed", trace };
    }

    trace.push({
      iteration: step,
      action: action === "confirm" ? "rejected_confirm" : "test",
      filters: validFilters,
      count,
      reasoning: reasoning ?? "",
    });
  }

  // Exhausted the attempt budget without a confirm — keep the best tried set.
  const best = pickBest(trace);
  if (!best) {
    throw new Error("[apollo-service][refineAudience] no positive-match filter set was produced after refinement");
  }
  return { filters: best.filters, count: best.count, status: "exhausted", trace };
}
