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
 * round carrying its filters, its live count, 24 sample rows drawn from RANDOM
 * pages, and the model's own three notes. It answers with a filter set and
 * `toContinue`.
 *
 * NO SELF-GRADE, NO SELECTION (#246). This loop EXPLORES and REPORTS: it returns
 * EVERY round it ran (`candidates`, in round order, each with its filters, its
 * live count, its 24 sample rows and the model's three notes) and lets the
 * consumer choose. `showable` is GONE — it was `true` on 60 of 60 rounds, the
 * third absolute per-round self-grade in this loop to degenerate to a constant
 * (after `reachesOffTarget`/`leavesTargetUnreached` and `matchesRequest`), which
 * collapsed selection to plain argmax-count and shipped a 179,156-person set at
 * Mars and Lidl. Do NOT re-introduce a per-round self-grade under another name.
 * Which audience serves the customer is a product decision and it is made in
 * human-service, which did not author the sets and compares N rather than
 * judging one in isolation.
 *
 * The legacy single-result fields (`filters`, `count`, `degraded`) are kept
 * ADDITIVELY alongside `candidates` so human-service can migrate on its own
 * schedule; they pick the largest non-empty round, which is exactly what the
 * always-true `showable` reduced to in production.
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
/** Extra turns for a filter set that resolves to a query ALREADY dry-run in this
 * run. Like an invalid decision, a duplicate does NOT consume a round — running
 * the same query twice buys nothing and production runs were losing a fifth of
 * the budget to it (#249: 574 twice, 931 twice, 2,321 twice in single runs). The
 * model is told which round it repeated and asked for something different. */
const MAX_DUPLICATE_RETRIES = 3;
/** 24 sample rows, drawn 8 at a time from 3 RANDOM pages. Apollo RANKS results,
 * so the head of the list is a biased sample — biased in the direction that
 * hides the bug (a 10,791-count set can show an immaculate page 1 while the tail
 * is manufacturers). Ten rows was a thin basis for judging the composition of a
 * several-thousand-person set and the teaser costs zero credits at any page size
 * (#249), so the evidence per round is roughly doubled for the price of tokens. */
const SAMPLE_PAGE_SIZE = 10;
const SAMPLE_PAGES = 3;
const SAMPLE_ROWS_PER_PAGE = 8;
/** Total rows a sample carries — 24, inside the 20-25 band of #249. */
export const SAMPLE_SIZE = SAMPLE_PAGES * SAMPLE_ROWS_PER_PAGE;
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
  action: "round" | "invalid" | "duplicate";
  filters: Record<string, unknown> | null;
  count: number | null;
  /** Who the set actually matched. `null` on `invalid`/`duplicate` rows (nothing was run). */
  sample?: SampledPerson[] | null;
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

/** One explored round, reported as-is. No score, no rank, no self-grade — the
 * count and the sample are the evidence, the notes are the model's own account
 * of what it was trying. Round order is the only order. */
export interface RefineCandidate {
  /** 1-based position in the run, in the order the rounds were explored. */
  round: number;
  filters: Record<string, unknown>;
  count: number;
  sample: SampledPerson[];
  notes: RoundNotes;
}

export interface RefineResult {
  /** LEGACY single result — the largest non-empty round. Kept so human-service
   * can migrate to `candidates` on its own schedule. */
  filters: Record<string, unknown>;
  count: number;
  status: "confirmed" | "exhausted";
  /** LEGACY. With `showable` deleted there is no per-round self-tag left to
   * withhold a blessing, so this is FALSE whenever an audience is returned —
   * which is exactly what it was in production, where `showable` came back true
   * on every round. Read `candidates` instead. */
  degraded: boolean;
  /** EVERY round that was dry-run, in round order. The deliverable. */
  candidates: RefineCandidate[];
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

/** Canonical form of a filter set: object keys sorted, array VALUES sorted,
 * empty arrays / null / undefined dropped. Two sets with the same canonical form
 * send Apollo the same query — values within a field OR, so their order does not
 * change what matches, and a field carrying nothing is not a filter at all. */
function canonicalizeFilters(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(canonicalizeFilters).filter((v) => v !== undefined && v !== null);
    return items.map((v) => JSON.stringify(v)).sort();
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = canonicalizeFilters((value as Record<string, unknown>)[key]);
      if (v === undefined || v === null) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      out[key] = v;
    }
    return out;
  }
  return value;
}

/** Identity of the QUERY a filter set produces — the dedup key. */
export function encodingKey(filters: Record<string, unknown>): string {
  return JSON.stringify(canonicalizeFilters(filters));
}

const RefineDecisionSchema = z.object({
  /** Accepted as the object itself OR as a JSON string of it. Schemaless JSON
   * modes return the object; some providers wrap it in a string. Taking both is
   * plain tolerance of the wire shape. */
  filters: z.union([z.record(z.string(), z.unknown()), z.string()]),
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

/** How the INSTRUMENT behaves — measured live on Apollo, not a targeting rule.
 *
 * The prompt used to say "All filters AND together", which is true ACROSS fields
 * and false WITHIN one, i.e. it stated only the half that makes adding a field
 * look safe when it is the most destructive move available (#249). Both halves
 * ship together, with the numbers that were measured. */
const APOLLO_FILTER_ALGEBRA = [
  "=== HOW APOLLO COMBINES FILTERS (measured, not opinion) ===",
  "- WITHIN one field, the values OR together and WIDEN the set. Measured, one country held fixed:",
  "  q_organization_keyword_tags with tag A alone = 429 people, tag B alone = 58, [A, B] = 487 —",
  "  a clean union. organization_industries with one industry = 34,615, with two = 45,190.",
  "  person_titles with one title = 9,873, with a second spelling of the same role = 11,601.",
  "  Adding a value to a field you already use NEVER removes anyone.",
  "- ACROSS fields, the filters AND together and NARROW the set. Same baseline: tag A alone = 429,",
  "  but tag A PLUS an organization_industries field = 372 — adding a second field DELETED people.",
  "  Adding a field to 'sharpen' a set is the most destructive move available to you.",
  "- A value that matches NOBODY is INVISIBLE in the total, because values union. Measured on four",
  "  tags for the same concept: 429, 196, 2 and 0. So when you add a value to a field and the count",
  "  does not move, that VALUE is dead in Apollo's vocabulary — it does NOT mean the concept is",
  "  unreachable. The only way to learn what a value is worth is to run it on its own in a round.",
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
    "names or values; omit a field rather than guess.",
    "",
    APOLLO_FILTER_ALGEBRA,
    "",
    "=== AVAILABLE FILTERS (Apollo vocabulary) ===",
    catalog,
    "=== END FILTERS ===",
    "",
    COLD_EMAIL_CONTEXT,
    "",
    `Every set you propose is run against Apollo. You get back the live number of people it matches`,
    `(people with an SMTP-verified email — that is the contactable pool), plus ${SAMPLE_SIZE} sample rows drawn`,
    "from RANDOM pages of the result set: the employer and the person's title. Apollo ranks results,",
    "so the sample is deliberately not the head — it is what the tail of your set actually looks like.",
    "",
    `You have up to ${MAX_ROUNDS} rounds. Every round you see the full history of what you tried, what it`,
    "counted, who it matched, and your own notes.",
    "",
    "Each turn, reply with ONLY a JSON object (no prose, no code fences):",
    "{",
    '  "filters": { ...filters... },',
    '  "toContinue": true | false,',
    '  "whatWorked": "<one sentence>",',
    '  "whatToImprove": "<one sentence>",',
    '  "nextExperiment": "<one sentence: what you are trying next and why>"',
    "}",
    '- "toContinue": true to keep iterating, false to stop here because you are satisfied.',
    "",
    "EVERY round you run is reported back, with its count, its sample and your notes — none of them is",
    "discarded, and you are not asked to pick. Explore the space: a round that turns out too narrow or",
    "too broad is still a useful data point for whoever chooses.",
    "",
    "A set that resolves to a query you already ran is NOT run again — you are told which round it",
    "repeated and asked for a different one, and it does not consume a round. Value order and empty",
    "fields do not make a set different.",
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

  // The semantics are restated HERE, next to the raw filter JSON, so they do not
  // decay across turns: the history shows fields and values, and nothing in the
  // JSON says which of the two combines by union and which by intersection.
  lines.push(
    "Rounds so far (oldest first). Reading a filter set: each FIELD is ANDed with the others" +
      " (more fields = fewer people), and the VALUES inside one field are ORed (more values = more" +
      " people, and a value matching nobody adds nothing and is invisible in the count).",
  );
  for (const h of history) {
    if (h.action === "duplicate") {
      lines.push(
        `- #${h.iteration} DUPLICATE of an earlier round — not run: ${JSON.stringify(h.filters)}` +
          ` — ${(h.validationErrors ?? []).join("; ")}`,
      );
      continue;
    }
    if (h.action === "invalid") {
      lines.push(
        `- #${h.iteration} INVALID (rejected by schema): ${JSON.stringify(h.filters)} — errors: ${(h.validationErrors ?? []).join("; ")}`,
      );
      continue;
    }
    lines.push(
      `- #${h.iteration} count=${h.count} filters=${JSON.stringify(h.filters)}`,
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
 * the run ends with nothing usable — every round's filters, count,
 * sample and notes. When the independent grader (#225) started rejecting every
 * set in production there was no way to tell an over-strict judgement from a
 * broken call, and the only option was a revert. Deliberately NOT emitted on the
 * happy path. */
function logRefineTrace(input: RefineInput, trace: RefineIteration[], outcome: "no_usable_set"): void {
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
  let duplicateRetries = 0;
  let step = 0;
  /** encodingKey → the round number that already ran that exact query. */
  const seenEncodings = new Map<string, number>();

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
        reasoning: "model decision did not match {filters, toContinue}",
        validationErrors: parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`),
      });
      if (invalidRetries > MAX_INVALID_RETRIES) break;
      continue;
    }

    const { toContinue, whatWorked, whatToImprove, nextExperiment, reasoning } = parsed.data;
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

    const validFilters = filterCheck.data as Record<string, unknown>;

    // Already dry-run in this run? Re-running the same query buys nothing and
    // the round is the scarce resource — spend a duplicate turn instead, and
    // tell the model which round it repeated.
    const key = encodingKey(validFilters);
    const seenAt = seenEncodings.get(key);
    if (seenAt !== undefined) {
      duplicateRetries += 1;
      trace.push({
        iteration: step,
        action: "duplicate",
        filters: validFilters,
        count: null,
        reasoning: reasoning ?? "",
        validationErrors: [
          `same query as round #${seenAt} (value order and empty fields do not make a set different) — propose a different one`,
        ],
      });
      if (duplicateRetries > MAX_DUPLICATE_RETRIES) break;
      continue;
    }

    // A valid, not-yet-run filter set we can dry-run — this consumes one round.
    rounds += 1;
    seenEncodings.set(key, rounds);
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

  // EVERY round that ran, in round order — the deliverable. Nothing is scored,
  // ranked or filtered out here: a round that matched nobody is still an honest
  // report of what that filter set does, and the consumer chooses.
  const roundRows = trace.filter(isScored);
  const candidates: RefineCandidate[] = roundRows.map((h, i) => ({
    round: i + 1,
    filters: h.filters,
    count: h.count,
    sample: h.sample ?? [],
    notes: h.notes ?? { whatWorked: "", whatToImprove: "", nextExperiment: "" },
  }));

  // LEGACY single result: the largest non-empty round. This is what the
  // always-true `showable` reduced to in production, so the field's behaviour is
  // unchanged for a consumer that has not migrated to `candidates` yet.
  const scored = roundRows.filter((h) => h.count > 0);
  const chosen = scored.reduce<ScoredRound | undefined>(
    (best, h) => (best === undefined || h.count > best.count ? h : best),
    undefined,
  );

  // A run where every set matched NOBODY is not an audience — that is a real
  // error, and fail-loud still holds for it (as it does for chat-service or
  // Apollo being unreachable, which already threw above).
  if (!chosen) {
    logRefineTrace(input, trace, "no_usable_set");
    throw new Error("[apollo-service][refineAudience] no filter set validated and matched at least one person");
  }

  return {
    filters: chosen.filters,
    count: chosen.count,
    status: "confirmed",
    degraded: false,
    candidates,
    trace,
  };
}
