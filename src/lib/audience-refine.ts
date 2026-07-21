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

/** Ambition, NOT a hard floor. We WANT large audiences, so the loop aims to
 * reach at least this many matches — but ONLY by faithful widening (loosening
 * the model's OWN constraints), never by adding filters the request didn't ask
 * for. If the largest FAITHFUL filter set genuinely lands below this (a real
 * niche — e.g. US chiropractors), that smaller faithful audience is accepted;
 * we never fabricate reach by betraying the request. The count is Apollo's free
 * dry-run COUNT, not served records (Apollo paginates at most 50,000 — the loop
 * only reads counts).
 *
 * CALIBRATED TO THE VERIFIED-REACHABLE SCALE. Every dry-run now forces
 * contact_email_status:["verified"] (see apollo-client VERIFIED_EMAIL_STATUS),
 * so the counts the loop reads are the actually-contactable pool — roughly a
 * third of the old demographic total (verified rate ~25-33%). The ambition was
 * ~20,000 on the OLD unfiltered counts; on the verified scale that is ~7,000.
 * Do NOT bump it back to 20,000 — that would make the loop over-relax the
 * filters chasing an unreachable band and produce broader, looser audiences. */
const AMBITION_MIN = 7_000;
/** Real dry-run attempts (each consumes a live count). The loop uses these to
 * try faithfully-broader sets while it is still below the ambition. */
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
    "You are apollo-service's audience builder. Turn a natural-language B2B segment into an",
    "Apollo People Search filter set. Use your judgment and common sense — you are smart, act it.",
    "",
    "Only use the filter fields below, with Apollo's exact accepted values. Do not invent field",
    "names or values; omit a field rather than guess. All filters AND together.",
    "",
    "=== AVAILABLE FILTERS (faithful Apollo vocabulary) ===",
    catalog,
    "=== END FILTERS ===",
    "",
    "YOUR JOB, IN ONE SENTENCE:",
    "Among all filter sets that FAITHFULLY match what the person asked for, pick the one that",
    "yields the LARGEST audience. Faithful first, largest second. Never trade faithfulness for size.",
    "",
    "BE FAITHFUL — read the request and respect it, to the letter:",
    "- They give a revenue range -> keep it, don't widen it.",
    "- They give job titles -> target those titles AND their obvious equivalents (a \"VP Sales\" also",
    "  means \"Head of Sales\" / \"Sales Director\" — that's what includeSimilarTitles is for; set it",
    "  true for role targeting unless they ask for exact titles). What you do NOT do is swap in a",
    "  BROADER, off-topic title (never \"clinic owner\" for a request about chiropractors).",
    "- They name a profession/vertical (e.g. \"chiropractor\") -> target THAT. Do NOT add a generic",
    "  \"healthcare\" / \"medical practice\" / \"wellness\" keyword on top — that betrays the request.",
    "- They say a geography (e.g. US) -> give that geography. Never worldwide when they said US.",
    "- Read HOW loose they are: \"around\", \"roughly\", \"and similar\", \"-ish\" -> you may widen in that",
    "  spirit. A strict, specific request -> stay tight.",
    "",
    "KEYWORDS ARE YOUR MOST DANGEROUS TOOL — use them consciously, rarely:",
    "- A keyword group ANDs with everything else, so adding a keyword can ONLY shrink the audience.",
    "  If the job titles already capture the profession (\"Chiropractor\"), adding a \"chiropractic\"",
    "  keyword is a REDUNDANT filter that just removes people for nothing. Don't.",
    "- Free-text q_keywords is the single harshest volume killer (q_keywords=\"SaaS\" ~86 matches vs",
    "  q_organization_keyword_tags=[\"software\"] ~128,274). Prefer a structured filter",
    "  (organization_industries when Apollo has the enum value, else q_organization_keyword_tags)",
    "  and only reach for q_keywords/technology UIDs when the request truly needs that precision.",
    "- Add a keyword ONLY when no structured filter (title, industry, seniority, geography) already",
    "  expresses the idea.",
    "",
    "AIM BIG, BUT STAY FAITHFUL:",
    "- We want reach — aim for a large audience (ideally at least ~7,000 matches).",
    "  (Counts are the VERIFIED-EMAIL-REACHABLE pool — only people we can actually",
    "  contact — so a healthy audience here is smaller than a raw demographic total.)",
    "- Reach that ambition by LOOSENING YOUR OWN over-constraints — drop a redundant keyword, turn on",
    "  includeSimilarTitles, remove a filter the request never asked for. NEVER by adding a broader,",
    "  off-topic filter (that inflates the count with the wrong people).",
    "- If the largest FAITHFUL set still lands below the ambition (a genuine niche — e.g. US",
    "  chiropractors), that is fine: keep the faithful set. A smaller true audience beats a big fake",
    "  one. Do not manufacture size by betraying the request.",
    "",
    "Each turn, reply with ONLY a JSON object (no prose, no code fences):",
    '{ "action": "test" | "confirm", "filters": { ...faithful filters... }, "reasoning": "<one short line>" }',
    '- "test": you want the live count for this filter set before deciding.',
    '- "confirm": this is your largest FAITHFUL set — stop and persist it.',
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

  // Below the ambition and still have budget: nudge the model to try a
  // FAITHFULLY-broader set — by loosening its OWN constraints, never by adding
  // off-topic filters. Once no faithful widening is left, it confirms its
  // largest faithful set (which may be below the ambition — that's allowed).
  const lastValid = [...history]
    .reverse()
    .find((h): h is RefineIteration & { count: number } => h.action !== "invalid" && h.count !== null);
  const remaining = MAX_REAL_ATTEMPTS - realAttemptsUsed;
  if (lastValid && lastValid.count < AMBITION_MIN) {
    lines.push(
      `Latest faithful count is ${lastValid.count}, below the ~7,000 we aim for. You have ${remaining} test(s) left. ` +
        "Try a FAITHFULLY-broader set: drop a redundant keyword (one the job titles already cover), " +
        "turn on includeSimilarTitles, or remove a constraint the request never asked for. Do NOT add a " +
        "broader, off-topic filter (no generic \"healthcare\"/\"wellness\" keyword, no worldwide) — that betrays " +
        "the request. If you cannot widen without betraying it, confirm your largest faithful set as-is.",
    );
    if (remaining <= 1) {
      lines.push(
        "This is your LAST test — submit the LARGEST set that still faithfully matches the request.",
      );
    }
  } else {
    lines.push("Refine further (action \"test\") or finalize (action \"confirm\") with your largest faithful set.");
  }
  return lines.join("\n");
}

/** The largest faithful set tried (every tried set is faithful — the schema
 * validated it and the model only proposes on-request filters). Objective =
 * max count among positive-match sets. Used both when the loop exhausts and as
 * a guardrail so an early `confirm` never returns a set smaller than one we've
 * already seen. */
function pickBest(history: RefineIteration[]): { filters: Record<string, unknown>; count: number } | null {
  const positive = history.filter(
    (h): h is RefineIteration & { filters: Record<string, unknown>; count: number } =>
      h.action !== "invalid" && h.filters !== null && h.count !== null && h.count > 0,
  );
  if (positive.length === 0) return null;
  return positive.reduce((a, b) => (b.count > a.count ? b : a));
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
        // flash = Gemini 2.5 Flash. disableThinking on Gemini 2.5 is a FULL-OFF
        // (unlike Gemini 3 / flash-pro, which floors at `minimal`), so the whole
        // output budget goes to this structured-JSON decision, no chain-of-thought.
        model: "flash",
        responseFormat: "json",
        temperature: 0.2,
        maxTokens: 2000,
        disableThinking: true,
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

    if (action === "confirm" && count > 0) {
      // Trust the model's confirm: it is the fidelity arbiter and the prompt asks
      // it to confirm its LARGEST faithful set. Any positive-match faithful set is
      // acceptable — no count floor. (A deliberate narrowing from a broader tested
      // set is intentional: the broader one was less faithful.)
      trace.push({ iteration: step, action: "confirm", filters: validFilters, count, reasoning: reasoning ?? "" });
      return { filters: validFilters, count, status: "confirmed", trace };
    }

    trace.push({
      iteration: step,
      // A confirm with zero matches is unusable — treat it as a test and keep going.
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
