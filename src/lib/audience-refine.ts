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

/** A "good" B2B audience lands in this count band. Guidance for the model — it
 * decides; Apollo serves at most 50,000 records via pagination. */
const TARGET_MIN = 25;
const TARGET_MAX = 50_000;
const MAX_REFINE_ITERATIONS = 6;

export interface RefineIteration {
  iteration: number;
  action: "test" | "confirm" | "invalid";
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
    `Goal: a focused audience whose match count is roughly ${TARGET_MIN}–${TARGET_MAX}.`,
    "Too many (>50000, Apollo's hard cap) → add/tighten filters. Too few or zero → loosen or drop filters.",
    "",
    "Each turn, reply with ONLY a JSON object (no prose, no code fences):",
    '{ "action": "test" | "confirm", "filters": { ...faithful filters... }, "reasoning": "<one short line>" }',
    '- "test": you want the live count for this filter set before deciding.',
    '- "confirm": this filter set is good — stop and persist it.',
    "Confirm once the count is in a sensible range and further refinement would not help.",
  ].join("\n");
}

function buildUserMessage(input: RefineInput, history: RefineIteration[]): string {
  const lines: string[] = [
    `Segment name: ${input.name}`,
    `Segment description: ${input.description}`,
    "",
  ];
  if (history.length === 0) {
    lines.push("No filter sets tried yet. Propose your first filter set with action \"test\".");
  } else {
    lines.push("Filter sets tried so far (most recent last):");
    for (const h of history) {
      if (h.action === "invalid") {
        lines.push(`- INVALID (rejected by schema): ${JSON.stringify(h.filters)} — errors: ${(h.validationErrors ?? []).join("; ")}`);
      } else {
        lines.push(`- count=${h.count} for filters=${JSON.stringify(h.filters)}`);
      }
    }
    lines.push("");
    lines.push("Refine further (action \"test\") or finalize (action \"confirm\").");
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
  const inBand = valid.filter((h) => h.count >= TARGET_MIN && h.count <= TARGET_MAX);
  if (inBand.length > 0) {
    // Broadest coverage within band.
    return inBand.reduce((a, b) => (b.count > a.count ? b : a));
  }
  // Otherwise closest to the band (distance to nearest edge).
  const dist = (c: number) => (c < TARGET_MIN ? TARGET_MIN - c : c - TARGET_MAX);
  return valid.reduce((a, b) => (dist(b.count) < dist(a.count) ? b : a));
}

export async function refineAudience(input: RefineInput): Promise<RefineResult> {
  const systemPrompt = buildSystemPrompt(input.filtersPromptCatalog);
  const trace: RefineIteration[] = [];

  for (let i = 1; i <= MAX_REFINE_ITERATIONS; i++) {
    const message = buildUserMessage(input, trace);
    const res = await chatComplete(
      {
        message,
        systemPrompt,
        provider: "anthropic",
        model: "sonnet",
        responseFormat: "json",
        temperature: 0.2,
        maxTokens: 2000,
      },
      input.tracking,
    );

    const parsed = RefineDecisionSchema.safeParse(res.json);
    if (!parsed.success) {
      // Model returned an unusable decision shape — record and retry.
      trace.push({
        iteration: i,
        action: "invalid",
        filters: (res.json?.filters as Record<string, unknown>) ?? null,
        count: null,
        reasoning: "model decision did not match {action, filters}",
        validationErrors: parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`),
      });
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
      trace.push({ iteration: i, action: "invalid", filters, count: null, reasoning: reasoning ?? "", validationErrors });
      continue;
    }

    const validFilters = filterCheck.data as Record<string, unknown>;
    const count = await dryRunCount(input.apolloApiKey, validFilters);

    if (action === "confirm") {
      trace.push({ iteration: i, action: "confirm", filters: validFilters, count, reasoning: reasoning ?? "" });
      return { filters: validFilters, count, status: "confirmed", trace };
    }

    trace.push({ iteration: i, action: "test", filters: validFilters, count, reasoning: reasoning ?? "" });
  }

  // Exhausted the iteration budget without a confirm — keep the best tried set.
  const best = pickBest(trace);
  if (!best) {
    throw new Error("[apollo-service][refineAudience] no valid filter set was produced after refinement");
  }
  return { filters: best.filters, count: best.count, status: "exhausted", trace };
}
