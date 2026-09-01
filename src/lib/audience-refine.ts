/**
 * Agentic "NL segment → Apollo filters" refinement loop.
 *
 * This logic moved OUT of human-service INTO apollo-service: given a segment
 * name + self-contained description, iterate Apollo People-Search filter sets,
 * use the FREE dry-run as live count feedback, and let the model explore
 * alternative encodings of the SAME target. The winning filter set + a count
 * snapshot are persisted by the caller (POST /audiences/suggest-from-segment).
 *
 * The LLM call goes through chat-service (which owns the LLM cost). The Apollo
 * people-search teaser consumes NO credits at any page size, so both the count
 * and the sample are free and this loop declares no cost of its own — same as
 * POST /search/dry-run.
 *
 * SHAPE (see CLAUDE.md "the refine loop is a strong model with a real budget"):
 * a strong model, the filter catalog, a plain goal, and ten dry-run attempts —
 * each answered with a live count AND a random sample of who it matched.
 * The set the model returns with `action:"final"` IS the result — no code
 * re-ranks, scores or overrides it. One closing question ("does this set match
 * what was asked?") populates `degraded` for the customer; it is read AFTER the
 * set is chosen and never selects anything.
 */

import { z } from "zod";
import { chatComplete, type ChatTrackingHeaders } from "./chat-client.js";
import { toApolloSearchParams } from "./transform.js";
import { toCreditAlertIdentity, type CreditAlertIdentity } from "./credit-alert.js";
import { searchPeople, type ApolloPerson } from "./apollo-client.js";
import { SearchFiltersSchema } from "../schemas.js";

/** The model this loop runs on: cheap AND smart, per the owner's instruction.
 *
 * A/B'd head-to-head against `deepseek/deepseek-pro` on the Swiss-drugstores
 * description, 3 runs each (2026-09-01). `glm-pro` returned 13 / 171 / 15 with
 * employers that are recognisably the target (Vita Drogerie AG, LANUR, PANVEGA,
 * Markthalle Luzern); `deepseek-pro` returned 268 / 203 / 1 with Emmi Group,
 * Transgourmet, Möbel Pfister and CALIDA in its samples — a wider spread AND
 * off-target companies. glm-pro wins.
 *
 * `google/pro` was the emergency swap after the platform Anthropic account hit
 * its usage cap (#236); Anthropic is off the table for this loop for good. */
const REFINE_PROVIDER = "zai" as const;
const REFINE_MODEL = "glm-pro" as const;

/** Real dry-run attempts. Each one gives the model a live count AND a sample of
 * who it matched, to react to. */
const MAX_REAL_ATTEMPTS = 10;
/** Attempts the model must actually SPEND before a `final` is accepted.
 *
 * This is an EXPLORATION MECHANIC, not a targeting rule: it says nothing about
 * WHAT to look for, only that the budget is there to be used. Six production
 * runs of the same description returned 25, 9, 25, 164721, 13 and 6643 — and the
 * two worst stopped at attempt 3 of 10 while their own sample showed the target
 * abandoned. A `final` before this floor is run and shown to the model exactly
 * like a `test`; the model keeps its set and can send it again. Nothing here
 * re-ranks or rejects a set on its content. */
const MIN_REAL_ATTEMPTS = 6;
/** Extra budget for unusable model output (malformed decision JSON or filters
 * rejected by the faithful schema). These do NOT consume a real attempt — a
 * provider hiccup must not eat the exploration budget. */
const MAX_INVALID_RETRIES = 3;
/** People pulled per sampled page, and how many pages are sampled. ~20 rows is
 * enough to see a geography leak or an off-target sector at a glance. */
const SAMPLE_PER_PAGE = 10;
const SAMPLE_PAGES = 2;
/** Apollo serves at most 500 pages (see CLAUDE.md "pagination hard cap") — a
 * sampled page beyond it 422s. */
const APOLLO_MAX_PAGE = 500;

/** One sampled person, flattened to what makes a bad filter set obvious.
 *
 * Company + title is ALL there is: Apollo's free people-search teaser REDACTS
 * every location field — a person carries `id, first_name, last_name_obfuscated,
 * title, organization` plus `has_city` / `has_state` / `has_country` BOOLEANS,
 * and the nested organization carries only `name` + its own `has_*` flags
 * (verified live 2026-08-31). So city, country, domain and industry are not
 * obtainable here at zero credits — do not re-add them expecting values; they
 * come back `null` for every row. The company name is still the load-bearing
 * signal: it is what shows Emmi Group and World Vision sitting in a "drugstores"
 * audience. */
export interface SampledPerson {
  company: string | null;
  title: string | null;
}

export interface RefineIteration {
  iteration: number;
  action: "test" | "final" | "invalid";
  filters: Record<string, unknown> | null;
  count: number | null;
  /** Who the set actually matched. `null` on `invalid` rows (nothing was run). */
  sample?: SampledPerson[] | null;
  reasoning: string;
  validationErrors?: string[];
  /** The model's closing answer on its `final` row: does this set match what was
   * asked? Absent on every other row. Reported, never used to choose. */
  matchesRequest?: boolean;
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
  /** TRUE when the model did not close with "yes, this matches what was asked"
   * — it answered no, or the attempt budget ran out before it answered at all.
   * The audience is usable but unblessed: the customer can look at it and reject
   * it instead of seeing an error. Purely informational — the returned set is
   * the model's own final set either way. */
  degraded: boolean;
  trace: RefineIteration[];
}

/** Free Apollo dry-run: count people matching `filters` without spending credits. */
export async function dryRunCount(
  apolloApiKey: string,
  filters: Record<string, unknown>,
  alertIdentity?: CreditAlertIdentity,
): Promise<number> {
  const apolloParams = { ...toApolloSearchParams(filters), page: 1, per_page: 1 };
  const result = await searchPeople(apolloApiKey, apolloParams, alertIdentity);
  return result.total_entries ?? result.pagination?.total_entries ?? 0;
}

/** Up to `n` distinct pages drawn at random from 1..totalPages. Apollo RANKS its
 * results, so the head of the list is a biased sample — biased in the direction
 * that hides the bug (a set leaking into French-speaking Switzerland can show a
 * clean first page while the leak sits on page 40). */
function pickRandomPages(totalPages: number, n: number): number[] {
  if (totalPages <= n) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const picked = new Set<number>();
  while (picked.size < n) picked.add(1 + Math.floor(Math.random() * totalPages));
  return [...picked].sort((a, b) => a - b);
}

function toSampledPerson(p: ApolloPerson): SampledPerson {
  return { company: p.organization?.name ?? null, title: p.title ?? null };
}

/**
 * Free Apollo dry-run with a real sample: the live count PLUS ~20 people drawn
 * from random pages of the result set. Apollo's people-search teaser costs zero
 * credits at any page size, so the sample is free — and a count is a scalar that
 * says how many, never who.
 */
export async function dryRunSample(
  apolloApiKey: string,
  filters: Record<string, unknown>,
  alertIdentity?: CreditAlertIdentity,
): Promise<{ count: number; sample: SampledPerson[] }> {
  const count = await dryRunCount(apolloApiKey, filters, alertIdentity);
  if (count === 0) return { count, sample: [] };

  const apolloParams = toApolloSearchParams(filters);
  const totalPages = Math.min(Math.ceil(count / SAMPLE_PER_PAGE), APOLLO_MAX_PAGE);
  const sample: SampledPerson[] = [];
  for (const page of pickRandomPages(totalPages, SAMPLE_PAGES)) {
    const res = await searchPeople(apolloApiKey, { ...apolloParams, page, per_page: SAMPLE_PER_PAGE }, alertIdentity);
    sample.push(...(res.people ?? []).map(toSampledPerson));
  }
  return { count, sample };
}

const RefineDecisionSchema = z.object({
  action: z.enum(["test", "final"]),
  /** Accepted as the object itself OR as a JSON string of it. Schemaless JSON
   * modes return the object; some providers wrap it in a string. Taking both is
   * plain tolerance of the wire shape — it removes a class of unusable output
   * and costs nothing. */
  filters: z.union([z.record(z.string(), z.unknown()), z.string()]),
  reasoning: z.string().optional(),
  /** Only meaningful on `final`. */
  matchesRequest: z.boolean().optional(),
});

/** The decision's filters as an object. `null` when the model sent something that
 * is not one — unusable output, handled on the invalid-retry budget. */
function decodeFilters(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function buildSystemPrompt(catalog: string): string {
  return [
    "You are apollo-service's audience builder. Given a natural-language description of a B2B",
    "audience, find the Apollo People Search filter set that best answers that description.",
    "Use your judgment and common sense — you are smart, act it.",
    "",
    "Only use the filter fields below, with Apollo's exact accepted values. Do not invent field",
    "names or values; omit a field rather than guess. All filters AND together.",
    "",
    "=== AVAILABLE FILTERS (Apollo vocabulary) ===",
    catalog,
    "=== END FILTERS ===",
    "",
    "Every set you propose is run against Apollo. You get back the live number of people it matches,",
    "plus a sample of who they actually are — the employer and the person's title — drawn from random",
    `pages of the result set. You have up to ${MAX_REAL_ATTEMPTS} proposals. Stop when you have the set you want.`,
    "",
    `The first ${MIN_REAL_ATTEMPTS} proposals are exploration and they are yours to spend: a "final" sent before`,
    `you have used ${MIN_REAL_ATTEMPTS} of them is run and answered like a "test", and the loop continues. Keep the`,
    "set if you still want it — you can send it again as your answer once the exploration budget is spent.",
    "",
    "Each turn, reply with ONLY a JSON object (no prose, no code fences):",
    "{",
    '  "action": "test" | "final",',
    '  "filters": { ...filters... },',
    '  "reasoning": "<one short line>",',
    '  "matchesRequest": true | false',
    "}",
    '- "test": you want the live count for this filter set before deciding.',
    '- "final": this is your answer. The set you send with "final" is what we return — nothing',
    "  re-ranks it, and no other round can win over it.",
    '- "matchesRequest": on your "final" turn, does the set you are returning match what was',
    "  asked? It does not change which set is used — it only tells the customer whether we are",
    "  confident in the audience we built for them.",
  ].join("\n");
}

function buildUserMessage(input: RefineInput, history: RefineIteration[], realAttemptsUsed: number): string {
  const lines: string[] = [
    `Segment name: ${input.name}`,
    `Segment description: ${input.description}`,
    "",
  ];

  if (history.length === 0) {
    lines.push('No filter sets tried yet. Propose your first filter set with action "test".');
    return lines.join("\n");
  }

  lines.push("Filter sets tried so far (most recent last):");
  for (const h of history) {
    if (h.action === "invalid") {
      lines.push(
        `- #${h.iteration} INVALID (rejected by schema): ${JSON.stringify(h.filters)} — errors: ${(h.validationErrors ?? []).join("; ")}`,
      );
    } else {
      lines.push(`- #${h.iteration} count=${h.count} filters=${JSON.stringify(h.filters)} — ${h.reasoning}`);
      for (const s of h.sample ?? []) {
        lines.push(`    · ${s.company ?? "?"} — ${s.title ?? "?"}`);
      }
    }
  }
  lines.push("");
  const mustSpend = Math.max(0, MIN_REAL_ATTEMPTS - realAttemptsUsed);
  lines.push(
    `You have ${MAX_REAL_ATTEMPTS - realAttemptsUsed} proposal(s) left. Propose another set (action "test"), or give ` +
      'your answer (action "final").',
  );
  if (mustSpend > 0) {
    lines.push(
      `${mustSpend} exploration proposal(s) remain to be spent — a "final" before that is run and answered like a ` +
        '"test", and the loop continues.',
    );
  }
  return lines.join("\n");
}

/** Diagnostic of last resort: one structured line carrying the WHOLE trace when
 * the run ends degraded or with nothing usable — every iteration's filters,
 * count, action and reasoning. When the independent grader (#225) started
 * rejecting every set in production there was no way to tell an over-strict
 * judgement from a broken call, and the only option was a revert. Deliberately
 * NOT emitted on the happy path — this is not per-iteration chatter. */
function logRefineTrace(input: RefineInput, trace: RefineIteration[], outcome: "degraded" | "no_usable_set"): void {
  console.warn(
    "[apollo-service][refineAudience] refine ended without a confident set " +
      JSON.stringify({
        outcome,
        name: input.name,
        description: input.description,
        iterations: trace.map((h) => ({
          iteration: h.iteration,
          action: h.action,
          count: h.count,
          filters: h.filters,
          sample: h.sample,
          matchesRequest: h.matchesRequest,
          validationErrors: h.validationErrors,
          reasoning: h.reasoning,
        })),
      }),
  );
}

export async function refineAudience(input: RefineInput): Promise<RefineResult> {
  const systemPrompt = buildSystemPrompt(input.filtersPromptCatalog);
  const trace: RefineIteration[] = [];

  // Two separate budgets: MAX_REAL_ATTEMPTS live dry-runs (the exploration
  // budget), plus MAX_INVALID_RETRIES extra turns for unusable model output that
  // must NOT eat a real attempt. `step` numbers the trace rows in order.
  let realAttempts = 0;
  let invalidRetries = 0;
  let step = 0;
  /** The model's own answer, once it gives one. */
  let answered = false;

  while (realAttempts < MAX_REAL_ATTEMPTS) {
    step += 1;
    const message = buildUserMessage(input, trace, realAttempts);
    const res = await chatComplete(
      {
        message,
        systemPrompt,
        // Cheap AND smart, in SCHEMALESS JSON mode — the Zod guards below
        // validate the shape, so no responseSchema is sent. Anthropic is off the
        // table for this loop for good (the platform account is usage-capped and
        // the loop is not worth an opus bill either way), and `google/pro` was
        // only ever the emergency swap that replaced it.
        // Reasoning stays ON: judgement is the whole job here, so no
        // `disableThinking` and no thinkingLevel floor.
        provider: REFINE_PROVIDER,
        model: REFINE_MODEL,
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
        filters: decodeFilters(res.json?.filters),
        count: null,
        reasoning: "model decision did not match {action, filters}",
        validationErrors: parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`),
      });
      if (invalidRetries > MAX_INVALID_RETRIES) break;
      continue;
    }

    const { action, reasoning, matchesRequest } = parsed.data;
    const filters = decodeFilters(parsed.data.filters);
    if (filters === null) {
      // The filter string was not a JSON object — unusable output, retry budget.
      invalidRetries += 1;
      trace.push({
        iteration: step,
        action: "invalid",
        filters: null,
        count: null,
        reasoning: reasoning ?? "",
        validationErrors: [`filters: not a JSON object (${String(parsed.data.filters).slice(0, 200)})`],
      });
      if (invalidRetries > MAX_INVALID_RETRIES) break;
      continue;
    }

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
      trace.push({
        iteration: step,
        action: "invalid",
        filters,
        count: null,
        reasoning: reasoning ?? "",
        validationErrors,
      });
      if (invalidRetries > MAX_INVALID_RETRIES) break;
      continue;
    }

    // A valid filter set we can dry-run — this consumes one real attempt.
    realAttempts += 1;
    const validFilters = filterCheck.data as Record<string, unknown>;
    const { count, sample } = await dryRunSample(
      input.apolloApiKey,
      validFilters,
      toCreditAlertIdentity(input.tracking),
    );

    // A `final` sent before the exploration floor is DEFERRED: the set was just
    // dry-run and its count + sample go back to the model like any other
    // proposal, and the loop continues. The model keeps its set and may send it
    // again once the budget is spent. Nothing about the set's CONTENT is judged
    // here — only how much of the budget has been used.
    const deferred = action === "final" && realAttempts < MIN_REAL_ATTEMPTS;

    trace.push({
      iteration: step,
      action: deferred ? "test" : action,
      filters: validFilters,
      count,
      sample,
      reasoning: reasoning ?? "",
      ...(deferred && { finalDeferred: true }),
      ...(action === "final" && !deferred && { matchesRequest: matchesRequest === true }),
    });

    if (action === "final" && !deferred) {
      answered = true;
      break;
    }
  }

  // The model's own answer is the result: its `final` set, or — when the budget
  // ran out before it gave one — its most recent proposal. Nothing re-ranks.
  const chosen = [...trace]
    .reverse()
    .find(
      (h): h is RefineIteration & { filters: Record<string, unknown>; count: number } =>
        h.action !== "invalid" && h.filters !== null && h.count !== null,
    );

  // The closing question is read AFTER the set is chosen. No answer (budget
  // exhausted, or the model omitted it) = not confident.
  const degraded = chosen?.matchesRequest !== true;

  // A set that matches NOBODY is not an audience — that is a real error, and
  // fail-loud still holds for it (as it does for chat-service or Apollo being
  // unreachable, which already threw above).
  if (!chosen || chosen.count === 0) {
    logRefineTrace(input, trace, "no_usable_set");
    throw new Error("[apollo-service][refineAudience] no filter set validated and matched at least one person");
  }

  if (degraded) logRefineTrace(input, trace, "degraded");

  return {
    filters: chosen.filters,
    count: chosen.count,
    status: answered ? "confirmed" : "exhausted",
    degraded,
    trace,
  };
}
