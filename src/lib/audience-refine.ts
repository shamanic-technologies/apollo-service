/**
 * Agentic "NL segment → Apollo filters" refinement loop.
 *
 * This logic moved OUT of human-service INTO apollo-service: given a segment
 * name + self-contained description, iterate Apollo People-Search filter sets,
 * use the FREE dry-run as live count + sample feedback, and let the model
 * explore alternative encodings of the SAME target. The winning filter set + a
 * count snapshot are persisted by the caller (POST /audiences/suggest-from-segment).
 *
 * The LLM call goes through chat-service (which owns the LLM cost). The Apollo
 * people-search teaser consumes NO credits at any page size, so both the count
 * and the sample are free and this loop declares no cost of its own — same as
 * POST /search/dry-run.
 *
 * SHAPE (see CLAUDE.md): the model is given DATA and CONTEXT, never targeting
 * rules. Every round it receives the original request verbatim, the cold-email
 * business context (why volume matters AND that a genuinely small market is a
 * correct answer), its round budget, and the full ordered history — each past
 * round carrying its filters, its live count, 10 sample rows drawn from RANDOM
 * pages, and the model's own three notes. It answers with a filter set, a
 * factual `showable` (does this answer the client's filtering request?) and
 * `toContinue`.
 *
 * SELECTION: the LARGEST `showable` round wins — not the last one. Runs that
 * stopped early on a visibly over-constrained set (4, 30, 7, 9, 80, 14 people
 * for a market of a few hundred) are why. With no showable round, the largest
 * overall is returned and flagged `degraded`. Nothing here scores, re-ranks on
 * content, or enforces a count floor.
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
 * description, 3 runs each (2026-09-01). `glm-pro` returned recognisable target
 * employers (Vita Drogerie AG, LANUR, PANVEGA); `deepseek-pro` returned a wider
 * spread AND off-target companies (Emmi Group, Transgourmet, CALIDA).
 *
 * Anthropic is off the table for this loop for good (#236/#241). */
const REFINE_PROVIDER = "zai" as const;
const REFINE_MODEL = "glm-pro" as const;

/** Rounds of live dry-run feedback the model gets. Each one returns a count AND
 * a sample of who matched. */
const MAX_ROUNDS = 10;
/** Extra budget for unusable model output (malformed decision JSON or filters
 * rejected by the faithful schema). These do NOT consume a round — a provider
 * hiccup must not eat the exploration budget. */
const MAX_INVALID_RETRIES = 3;
/** 10 sample rows, drawn 5 at a time from 2 RANDOM pages. Apollo RANKS results,
 * so the head of the list is a biased sample — biased in the direction that
 * hides the bug (a 10,791-count set can show an immaculate page 1 while the tail
 * is manufacturers). */
const SAMPLE_PAGE_SIZE = 10;
const SAMPLE_PAGES = 2;
const SAMPLE_ROWS_PER_PAGE = 5;
/** Apollo serves at most 500 pages (see CLAUDE.md "pagination hard cap") — a
 * sampled page beyond it 422s. */
const APOLLO_MAX_PAGE = 500;

/** One sampled person, flattened to what makes a bad filter set obvious.
 *
 * Company + title is ALL there is: Apollo's free people-search teaser REDACTS
 * every location field — a person carries `id, first_name, last_name_obfuscated,
 * title, organization` plus `has_city` / `has_state` / `has_country` BOOLEANS,
 * and the nested organization carries only `name` (verified live 2026-08-31, #238).
 * Do not re-add location expecting values; it comes back null for every row, and
 * obtaining it for real would need paid enrichment. */
export interface SampledPerson {
  company: string | null;
  title: string | null;
}

/** The model's three one-sentence notes, fed back to it in later rounds. */
export interface RoundNotes {
  whatWorked: string;
  whatToImprove: string;
  nextExperiment: string;
}

export interface RefineIteration {
  iteration: number;
  action: "round" | "invalid";
  filters: Record<string, unknown> | null;
  count: number | null;
  /** Who the set actually matched. `null` on `invalid` rows (nothing was run). */
  sample?: SampledPerson[] | null;
  /** Does this set answer the client's filtering request? The model's own
   * factual answer, independent of whether the volume is good. Selection picks
   * the LARGEST showable round. */
  showable?: boolean;
  /** The model asked to keep iterating (or not). */
  toContinue?: boolean;
  notes?: RoundNotes;
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
  /** TRUE when NO round was marked showable — the largest set is returned
   * anyway (never nothing), unblessed, so the customer can look at it and reject
   * it instead of seeing an error. human-service reads this and the dashboard
   * renders it. */
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

/** Up to `n` distinct pages drawn at random from 1..totalPages. */
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
 * Free Apollo dry-run with a real sample: the live count PLUS 10 people drawn
 * from RANDOM pages of the result set. Apollo's people-search teaser costs zero
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
  const totalPages = Math.min(Math.ceil(count / SAMPLE_PAGE_SIZE), APOLLO_MAX_PAGE);
  const sample: SampledPerson[] = [];
  for (const page of pickRandomPages(totalPages, SAMPLE_PAGES)) {
    const res = await searchPeople(
      apolloApiKey,
      { ...apolloParams, page, per_page: SAMPLE_PAGE_SIZE },
      alertIdentity,
    );
    sample.push(...(res.people ?? []).slice(0, SAMPLE_ROWS_PER_PAGE).map(toSampledPerson));
  }
  return { count, sample };
}

const RefineDecisionSchema = z.object({
  /** Accepted as the object itself OR as a JSON string of it. Schemaless JSON
   * modes return the object; some providers wrap it in a string. Taking both is
   * plain tolerance of the wire shape. */
  filters: z.union([z.record(z.string(), z.unknown()), z.string()]),
  showable: z.boolean().optional(),
  toContinue: z.boolean().optional(),
  whatWorked: z.string().optional(),
  whatToImprove: z.string().optional(),
  nextExperiment: z.string().optional(),
  reasoning: z.string().optional(),
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

/** What the audience is FOR. This is the missing information the model never
 * had: with only a description, precision is the only objective it can infer, so
 * it stacks ANDed constraints with great diligence and returns an audience of 4.
 *
 * BOTH halves are load-bearing. The numbers explain why volume matters; they are
 * NOT a floor. A model told "below 2,000 is pointless" without the counterweight
 * loosens until it hits 2,000, and the only way to get there is by sweeping in
 * manufacturers — precisely the failure this exists to prevent. */
const COLD_EMAIL_CONTEXT = [
  "=== WHAT THIS AUDIENCE IS FOR ===",
  "The people you select will receive a COLD EMAIL campaign. That changes the trade-off:",
  "",
  "- Every filter you AND together SUBTRACTS people. A constraint that feels like sharpening is",
  "  usually deleting most of the target: Apollo assigns roughly one industry per company, so",
  "  listing four industries and missing the right one removes the target entirely, and a long",
  "  exclusion list makes real targets exclude themselves on an incidental tag.",
  "- A somewhat-too-large audience carrying some noise is BETTER than a too-narrow one. Noise",
  "  costs a little budget. An audience of 4 people makes the whole engagement pointless.",
  "- For orientation only: an engagement is hard to justify below roughly 2,000 contactable",
  "  people, and a durably successful client looks more like 50,000.",
  "",
  "Those two numbers are CONTEXT, not a target and not a floor. Some markets are genuinely small.",
  "A niche local trade can hold a few hundred people in Apollo and that is the whole market — a",
  "genuinely small answer is a VALID, CORRECT answer and must be reported honestly rather than",
  "inflated. Never loosen the request to reach a number: reaching a big count by sweeping in",
  "companies nobody asked for is a worse answer than a small honest one.",
  "=== END ===",
].join("\n");

function buildSystemPrompt(catalog: string): string {
  return [
    "You are apollo-service's audience builder. Given a natural-language description of a B2B",
    "audience, find the Apollo People Search filter set that both answers that description and",
    "reaches as many relevant people as possible. Use your judgment and common sense — you are",
    "smart, act it.",
    "",
    "Only use the filter fields below, with Apollo's exact accepted values. Do not invent field",
    "names or values; omit a field rather than guess. All filters AND together.",
    "",
    "=== AVAILABLE FILTERS (Apollo vocabulary) ===",
    catalog,
    "=== END FILTERS ===",
    "",
    COLD_EMAIL_CONTEXT,
    "",
    `Every set you propose is run against Apollo. You get back the live number of people it matches`,
    "(people with an SMTP-verified email — that is the contactable pool), plus 10 sample rows drawn",
    "from RANDOM pages of the result set: the employer and the person's title. Apollo ranks results,",
    "so the sample is deliberately not the head — it is what the tail of your set actually looks like.",
    "",
    `You have up to ${MAX_ROUNDS} rounds. Every round you see the full history of what you tried, what it`,
    "counted, who it matched, and your own notes.",
    "",
    "Each turn, reply with ONLY a JSON object (no prose, no code fences):",
    "{",
    '  "filters": { ...filters... },',
    '  "showable": true | false,',
    '  "toContinue": true | false,',
    '  "whatWorked": "<one sentence>",',
    '  "whatToImprove": "<one sentence>",',
    '  "nextExperiment": "<one sentence: what you are trying next and why>"',
    "}",
    '- "showable": does THIS filter set answer the client\'s filtering request? A factual question',
    "  about the request, independent of whether the volume is good.",
    '- "toContinue": true to keep iterating, false to stop here because you are satisfied.',
    "",
    "When the loop ends, the SHOWABLE set with the LARGEST count is what we return — not your last",
    "one. So a good set stays in the running even after you move on from it.",
  ].join("\n");
}

function buildUserMessage(input: RefineInput, history: RefineIteration[], roundsUsed: number): string {
  const lines: string[] = [
    "=== THE REQUEST (verbatim) ===",
    `Segment name: ${input.name}`,
    `Segment description: ${input.description}`,
    "=== END REQUEST ===",
    "",
  ];

  if (history.length === 0) {
    lines.push(`Round 1 of ${MAX_ROUNDS}. No filter sets tried yet. Propose your first filter set.`);
    return lines.join("\n");
  }

  lines.push("Rounds so far (oldest first):");
  for (const h of history) {
    if (h.action === "invalid") {
      lines.push(
        `- #${h.iteration} INVALID (rejected by schema): ${JSON.stringify(h.filters)} — errors: ${(h.validationErrors ?? []).join("; ")}`,
      );
      continue;
    }
    lines.push(
      `- #${h.iteration} count=${h.count} showable=${h.showable === true} filters=${JSON.stringify(h.filters)}`,
    );
    for (const s of h.sample ?? []) {
      lines.push(`    · ${s.company ?? "?"} — ${s.title ?? "?"}`);
    }
    if (h.notes) {
      lines.push(`    worked: ${h.notes.whatWorked}`);
      lines.push(`    to improve: ${h.notes.whatToImprove}`);
      lines.push(`    next: ${h.notes.nextExperiment}`);
    }
  }
  lines.push("");
  lines.push(
    `Round ${roundsUsed + 1} of ${MAX_ROUNDS} (${MAX_ROUNDS - roundsUsed} left). Propose the next filter set, or set ` +
      '"toContinue": false to stop here.',
  );
  return lines.join("\n");
}

/** Diagnostic of last resort: one structured line carrying the WHOLE trace when
 * the run ends degraded or with nothing usable — every round's filters, count,
 * sample and notes. When the independent grader (#225) started rejecting every
 * set in production there was no way to tell an over-strict judgement from a
 * broken call, and the only option was a revert. Deliberately NOT emitted on the
 * happy path. */
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
          showable: h.showable,
          toContinue: h.toContinue,
          notes: h.notes,
          validationErrors: h.validationErrors,
          reasoning: h.reasoning,
        })),
      }),
  );
}

type ScoredRound = RefineIteration & { filters: Record<string, unknown>; count: number };

function isScored(h: RefineIteration): h is ScoredRound {
  return h.action === "round" && h.filters !== null && h.count !== null;
}

export async function refineAudience(input: RefineInput): Promise<RefineResult> {
  const systemPrompt = buildSystemPrompt(input.filtersPromptCatalog);
  const trace: RefineIteration[] = [];

  // Two separate budgets: MAX_ROUNDS live dry-runs (the exploration budget),
  // plus MAX_INVALID_RETRIES extra turns for unusable model output that must NOT
  // eat a round. `step` numbers the trace rows in order.
  let rounds = 0;
  let invalidRetries = 0;
  let step = 0;

  while (rounds < MAX_ROUNDS) {
    step += 1;
    const message = buildUserMessage(input, trace, rounds);
    const res = await chatComplete(
      {
        message,
        systemPrompt,
        // Cheap AND smart, in SCHEMALESS JSON mode — the Zod guards below
        // validate the shape, so no responseSchema is sent. Reasoning stays ON:
        // judgement is the whole job here.
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
      // Unusable decision shape — burns the retry budget, NOT a round.
      invalidRetries += 1;
      trace.push({
        iteration: step,
        action: "invalid",
        filters: decodeFilters(res.json?.filters),
        count: null,
        reasoning: "model decision did not match {filters, showable, toContinue}",
        validationErrors: parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`),
      });
      if (invalidRetries > MAX_INVALID_RETRIES) break;
      continue;
    }

    const { showable, toContinue, whatWorked, whatToImprove, nextExperiment, reasoning } = parsed.data;
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
      // Schema-invalid filters — burns the retry budget, NOT a round.
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

    // A valid filter set we can dry-run — this consumes one round.
    rounds += 1;
    const validFilters = filterCheck.data as Record<string, unknown>;
    const { count, sample } = await dryRunSample(
      input.apolloApiKey,
      validFilters,
      toCreditAlertIdentity(input.tracking),
    );

    trace.push({
      iteration: step,
      action: "round",
      filters: validFilters,
      count,
      sample,
      showable: showable === true,
      toContinue: toContinue !== false,
      notes: {
        whatWorked: whatWorked ?? "",
        whatToImprove: whatToImprove ?? "",
        nextExperiment: nextExperiment ?? "",
      },
      reasoning: reasoning ?? "",
    });

    if (toContinue === false) break;
  }

  // Selection: the LARGEST `showable` round across the whole run — not the last
  // one. Nothing here judges the CONTENT of a set; the model's own factual
  // "does this answer the request" is the only gate, and among the sets that
  // pass it, more relevant people is strictly better for a cold-email campaign.
  const scored = trace.filter(isScored).filter((h) => h.count > 0);
  const showable = scored.filter((h) => h.showable === true);
  const pool = showable.length > 0 ? showable : scored;
  const chosen = pool.reduce<ScoredRound | undefined>(
    (best, h) => (best === undefined || h.count > best.count ? h : best),
    undefined,
  );

  // No round the model called showable = usable but unblessed. Never nothing.
  const degraded = showable.length === 0;

  // A run where every set matched NOBODY is not an audience — that is a real
  // error, and fail-loud still holds for it (as it does for chat-service or
  // Apollo being unreachable, which already threw above).
  if (!chosen) {
    logRefineTrace(input, trace, "no_usable_set");
    throw new Error("[apollo-service][refineAudience] no filter set validated and matched at least one person");
  }

  if (degraded) logRefineTrace(input, trace, "degraded");

  return {
    filters: chosen.filters,
    count: chosen.count,
    // "confirmed" = we have a set the model itself called showable.
    status: degraded ? "exhausted" : "confirmed",
    degraded,
    trace,
  };
}
