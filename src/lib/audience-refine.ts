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
 * always-true `showable` reduced to in production. `degraded` reports the
 * model's OWN description of that round (see `describesNarrowOutcome`).
 *
 * EXCLUSIONS ARE MEASURED (#259). A count says how many a set matched and can
 * never say who it removed, so an exclusion is the one move whose cost is
 * invisible in this loop's feedback. Every round that excludes anything is
 * followed by the same query WITHOUT the exclusions — its count and its sample,
 * free — reported back to the model as data. There is no rule here about which
 * exclusions are suspect and nothing in this file acts on the numbers.
 */

import { z } from "zod";
import { chatComplete, type ChatTrackingHeaders } from "./chat-client.js";
import { toApolloSearchParams } from "./transform.js";
import { toCreditAlertIdentity, type CreditAlertIdentity } from "./credit-alert.js";
import { searchPeople, type ApolloPerson } from "./apollo-client.js";
import { SearchFiltersSchema } from "../schemas.js";

/** The model this loop runs on: OpenAI GPT-6 Astra, since 2026-09-09.
 *
 * The owner moved every onboarding step that PRE-FILLS something for a user
 * onto Astra for quality ("les users doivent vraiment avoir le meilleur service
 * possible"); the cost is accepted. Two Astra constraints hold here: it rejects
 * `temperature` != 1 and `top_p` with a 400, so this call sends NO sampling
 * parameter, and `disableThinking` maps to its lowest reasoning level — which
 * this loop does not set, because judgement is the whole job.
 *
 * History, kept: the loop previously ran on `zai/glm-pro`, picked after a
 * head-to-head against `deepseek/deepseek-pro` on the Swiss-drugstores
 * description, 3 runs each (2026-09-01). `glm-pro` returned recognisable target
 * employers (Vita Drogerie AG, LANUR, PANVEGA); `deepseek-pro` returned a wider
 * spread AND off-target companies (Emmi Group, Transgourmet, CALIDA).
 *
 * Anthropic is off the table for this loop for good (#236/#241). */
const REFINE_PROVIDER = "openai" as const;
const REFINE_MODEL = "gpt-pro" as const;

/** Rounds of live dry-run feedback the model gets. Each one returns a count AND
 * a sample of who matched.
 *
 * SIX, not ten, since 2026-09-11. This deliberately trades some exploration for
 * ~25s of onboarding latency (prod p50 for the whole suggest chain was 75s, p90
 * 121s, and this loop is its biggest slice). It reverses the intent of the
 * commit that raised the budget — a conscious call by the owner, not an
 * oversight. The prod evidence: over 515 runs in 30 days, 345 (67%) exhausted
 * the budget and only 101 ended on the model's own `confirm`, while an A/B on
 * three real prod descriptions found the best set by round 3-4 in all three
 * cases — rounds 5-10 mostly re-explored. */
const MAX_ROUNDS = 6;
/** Extra budget for unusable model output (malformed decision JSON, filters
 * rejected by the faithful schema, or chat-service REJECTING the completion
 * outright). These do NOT consume a round — a provider hiccup must not eat the
 * exploration budget.
 *
 * chat-service answers 502 when the model's output does not parse as JSON
 * ("LLM returned invalid JSON"). That is the SAME class of provider hiccup as a
 * response that parses into the wrong shape, and it used to be fatal: the throw
 * escaped the whole run and discarded every round already explored, returning a
 * 500 to the caller. It now burns one unit of this budget like any other
 * unusable turn, and only exhausting the budget ends the run. */
const MAX_INVALID_RETRIES = 3;
/** Wall-clock bound the endpoint imposes on itself.
 *
 * A full run is ~10 model turns at 13-16s each (149s measured in production on
 * 2026-09-09), plus extra turns for invalid output and duplicate queries — so
 * the real worst case runs well past any caller's patience. The caller
 * (human-service) waits 240s; 210s leaves margin for the network and for the
 * caller's own work. No new turn starts past the deadline and an in-flight
 * completion is aborted at it, so the endpoint always answers with whatever it
 * has explored instead of being cut off mid-flight. Every round is already
 * persisted as it goes, so answering early costs nothing. */
export const REFINE_DEADLINE_MS = 210_000;
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

/** Filter fields that REMOVE people rather than select them.
 *
 * Both spellings of each are listed: the model writes Apollo-native names (the
 * catalog it reads is native) but SearchFiltersSchema also accepts the legacy
 * camelCase aliases, and a set carrying the alias excludes exactly as hard. */
const EXCLUSION_FIELDS = [
  "q_not_organization_keyword_tags",
  "person_not_titles",
  "currently_not_using_any_of_technology_uids",
  "not_organization_naics_codes",
  "not_organization_sic_codes",
  "qNotOrganizationKeywordTags",
  "personNotTitles",
  "currentlyNotUsingAnyOfTechnologyUids",
  "notOrganizationNaicsCodes",
  "notOrganizationSicCodes",
] as const;

/** What ONE exclusion field is costing this round: the same set with that field
 * removed, counted live. */
export interface ExclusionProbe {
  field: string;
  countWithout: number;
}

/** What the round's exclusions are costing, measured — never judged.
 *
 * A count is what a filter set matched; it cannot say what the set REMOVED. So
 * a round that excludes anything also gets the counterfactual: the same query
 * without the exclusions, its count and its sample. The dry-run teaser is free
 * at any page size, so this evidence costs nothing but a few hundred
 * milliseconds, and it is reported back to the model as data — there is no rule
 * here about which exclusions are suspect, and nothing in this file acts on it. */
export interface ExclusionObservation {
  /** One entry per exclusion field the round used, in the order they appear. */
  probes: ExclusionProbe[];
  /** Count with EVERY exclusion field dropped at once. */
  countWithoutAll: number;
  /** Who that wider set contains — the population the exclusions are cutting into. */
  sampleWithoutAll: SampledPerson[];
}

/** The model's three one-sentence notes, fed back to it in later rounds. */
export interface RoundNotes {
  whatWorked: string;
  whatToImprove: string;
  nextExperiment: string;
}

export interface RefineIteration {
  iteration: number;
  /** `deadline` is the terminal row of a run cut short by the wall-clock bound —
   * nothing was proposed or run on it, it records WHY the run stopped. */
  action: "round" | "invalid" | "duplicate" | "deadline";
  filters: Record<string, unknown> | null;
  count: number | null;
  /** Who the set actually matched. `null` on `invalid`/`duplicate` rows (nothing was run). */
  sample?: SampledPerson[] | null;
  /** What this round's exclusions removed. `null` when the round excluded nothing. */
  exclusions?: ExclusionObservation | null;
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
  /** Wall-clock bound for this run. Defaults to REFINE_DEADLINE_MS; the route
   * does not pass it, tests do. */
  deadlineMs?: number;
}

/** Why the loop stopped. A run cut short by the wall-clock bound is
 * distinguishable from one that finished on its own terms. */
export type RefineStopReason =
  | "model_stopped"
  | "rounds_exhausted"
  | "deadline"
  | "invalid_budget_exhausted"
  | "duplicate_budget_exhausted";

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
  /** TRUE when the model's OWN account of the returned round describes it as
   * narrow / strict / tiny. Not a self-grade and not a threshold: it reads the
   * sentences the model already wrote (`describesNarrowOutcome`). A 7-person
   * audience the model itself called "strict criteria" used to come back
   * `false`. Read `candidates` for the full picture. */
  degraded: boolean;
  /** EVERY round that was dry-run, in round order. The deliverable. */
  candidates: RefineCandidate[];
  /** Why the loop stopped — `deadline` means the run was cut short by the
   * wall-clock bound and the exploration was NOT finished. */
  stoppedReason: RefineStopReason;
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

function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "string") return v.length > 0;
  return true;
}

function omitFields(filters: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(filters)) {
    if (!fields.includes(k)) out[k] = v;
  }
  return out;
}

/** Exclusion fields this filter set actually uses. */
export function exclusionFieldsUsed(filters: Record<string, unknown>): string[] {
  return EXCLUSION_FIELDS.filter((f) => hasValue(filters[f]));
}

/**
 * Measure what a round's exclusions removed, for free.
 *
 * A filter set that excludes something reports one count, and that count cannot
 * say who is missing from it — so the exclusion is the one move in the whole
 * vocabulary whose cost is invisible in the feedback the loop already collects.
 * This runs the SAME query without the exclusions (one count per exclusion
 * field, plus the count and the sample with all of them dropped) and hands the
 * numbers back to the model. Apollo's teaser is free at any page size, so the
 * whole observation costs zero credits.
 *
 * Returns `null` when the round excluded nothing — nothing to measure.
 */
export async function probeExclusions(
  apolloApiKey: string,
  filters: Record<string, unknown>,
  alertIdentity?: CreditAlertIdentity,
): Promise<ExclusionObservation | null> {
  const used = exclusionFieldsUsed(filters);
  if (used.length === 0) return null;

  const { count: countWithoutAll, sample: sampleWithoutAll } = await dryRunSample(
    apolloApiKey,
    omitFields(filters, used),
    alertIdentity,
  );

  // With a single exclusion field, "without that field" and "without all of
  // them" are the same query — no second call.
  const probes: ExclusionProbe[] =
    used.length === 1
      ? [{ field: used[0], countWithout: countWithoutAll }]
      : await Promise.all(
          used.map(async (field) => ({
            field,
            countWithout: await dryRunCount(apolloApiKey, omitFields(filters, [field]), alertIdentity),
          })),
        );

  return { probes, countWithoutAll, sampleWithoutAll };
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
  "- An EXCLUSION field (any of the not_ / q_not_ fields) removes an employer or a person when ANY",
  "  ONE of its values matches. So each value you add to an exclusion removes more people, and an",
  "  employer that carries one of your excluded values ALONGSIDE the values you are targeting is",
  "  removed too. A count cannot show you that: it says how many matched, never who is missing.",
  "  So whenever a set of yours excludes anything, the same query is ALSO run without the",
  "  exclusions and you are given that count and that sample, free. Read it — it is the only",
  "  evidence of what an exclusion is costing you, and it is measurement, not a verdict.",
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
    if (h.exclusions) {
      lines.push(
        `    this set EXCLUDES with ${h.exclusions.probes.length} field(s). Same query without them: ` +
          `${h.exclusions.countWithoutAll} people (this round matched ${h.count}).`,
      );
      for (const p of h.exclusions.probes) {
        lines.push(`      without ${p.field}: ${p.countWithout}`);
      }
      if (h.exclusions.sampleWithoutAll.length > 0) {
        lines.push("      who is in that wider set (sample, random pages):");
        for (const s of h.exclusions.sampleWithoutAll) {
          lines.push(`        · ${s.company ?? "?"} — ${s.title ?? "?"}`);
        }
      }
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
          exclusions: h.exclusions,
          toContinue: h.toContinue,
          notes: h.notes,
          validationErrors: h.validationErrors,
          reasoning: h.reasoning,
        })),
      }),
  );
}

/** Words a writer reaches for when the thing they are describing is small or
 * over-constrained. NOT a vocabulary about any market, any sector or any
 * filter — it is about the PROSE, and it is applied to nothing but the model's
 * own sentences. */
const NARROW_WORDS = [
  "narrow",
  "strict",
  "restrictive",
  "tiny",
  "small",
  "handful",
  "few people",
  "very few",
  "too specific",
  "highly specific",
  "over-constrained",
  "overly constrained",
  "limited",
  "sparse",
  "thin",
  "not enough",
  "low count",
  "low volume",
  "too low",
  "under-reach",
];

/**
 * Does the model's own account of a round describe it as narrow?
 *
 * The model already says so in prose when it knows the audience is small —
 * "~7 contacts identified with these strict criteria" was written by the model
 * that then returned `degraded: false`. This reads the sentences it already
 * wrote; it does NOT ask it to grade anything, and there is no count in it.
 * Three per-round self-grades have degenerated to constants in this loop
 * (`reachesOffTarget`/`leavesTargetUnreached`, `matchesRequest`, `showable`) —
 * this deliberately adds no fourth.
 *
 * It errs toward flagging: a round whose notes merely DISCUSS narrowness comes
 * back degraded. Announcing a fine audience as narrow is recoverable by whoever
 * chooses; announcing an audience of 7 as a normal result is what happened.
 */
export function describesNarrowOutcome(notes: RoundNotes | undefined, reasoning: string | undefined): boolean {
  const prose = [notes?.whatWorked, notes?.whatToImprove, notes?.nextExperiment, reasoning]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (prose.length === 0) return false;
  return NARROW_WORDS.some((w) => prose.includes(w));
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

  // Wall-clock bound. The endpoint answers within it in every case, returning
  // whatever it has explored by then — the caller cannot pick a sensible timeout
  // for an endpoint that offers no bound at all.
  const deadlineAt = Date.now() + (input.deadlineMs ?? REFINE_DEADLINE_MS);
  /** Nothing left to stop it: the loop ran its full round budget. */
  let stoppedReason: RefineStopReason = "rounds_exhausted";
  const stopOnDeadline = (): void => {
    stoppedReason = "deadline";
    step += 1;
    trace.push({
      iteration: step,
      action: "deadline",
      filters: null,
      count: null,
      reasoning: `stopped: the ${input.deadlineMs ?? REFINE_DEADLINE_MS}ms wall-clock bound was reached after ${rounds} round(s)`,
    });
  };

  while (rounds < MAX_ROUNDS) {
    if (Date.now() >= deadlineAt) {
      stopOnDeadline();
      break;
    }
    step += 1;
    const message = buildUserMessage(input, trace, rounds);
    let res: Awaited<ReturnType<typeof chatComplete>>;
    try {
      res = await chatComplete(
        {
          message,
          systemPrompt,
          // SCHEMALESS JSON mode — the Zod guards below validate the shape, so
          // no responseSchema is sent. Reasoning stays ON: judgement is the
          // whole job here. No `temperature`/`top_p`: Astra 400s on both.
          provider: REFINE_PROVIDER,
          model: REFINE_MODEL,
          responseFormat: "json",
          maxTokens: 2000,
          // A completion still in flight at the deadline is worthless: the run
          // has to answer with what it has.
          signal: AbortSignal.timeout(Math.max(deadlineAt - Date.now(), 1)),
        },
        input.tracking,
      );
    } catch (error) {
      // chat-service REJECTED the model response (502 "LLM returned invalid
      // JSON") or the call itself failed. Same class as a response that parses
      // into the wrong shape: unusable model output. It burns the retry budget,
      // NOT a round, and it is recorded in the trace like any other unusable
      // turn — never swallowed. Only exhausting the budget ends the run, and it
      // ends by returning the rounds already explored.
      invalidRetries += 1;
      trace.push({
        iteration: step,
        action: "invalid",
        filters: null,
        count: null,
        reasoning: "chat-service did not return a usable model response",
        validationErrors: [error instanceof Error ? error.message : String(error)],
      });
      if (invalidRetries > MAX_INVALID_RETRIES) {
        stoppedReason = "invalid_budget_exhausted";
        break;
      }
      continue;
    }

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
      if (invalidRetries > MAX_INVALID_RETRIES) {
        stoppedReason = "invalid_budget_exhausted";
        break;
      }
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
      if (invalidRetries > MAX_INVALID_RETRIES) {
        stoppedReason = "invalid_budget_exhausted";
        break;
      }
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
      if (invalidRetries > MAX_INVALID_RETRIES) {
        stoppedReason = "invalid_budget_exhausted";
        break;
      }
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
      if (duplicateRetries > MAX_DUPLICATE_RETRIES) {
        stoppedReason = "duplicate_budget_exhausted";
        break;
      }
      continue;
    }

    // The completion can come back with the deadline already past. Running four
    // more Apollo calls for a round nobody is waiting for only overshoots the
    // bound — stop here and report what was explored.
    if (Date.now() >= deadlineAt) {
      stopOnDeadline();
      break;
    }

    // A valid, not-yet-run filter set we can dry-run — this consumes one round.
    rounds += 1;
    seenEncodings.set(key, rounds);
    const alertIdentity = toCreditAlertIdentity(input.tracking);
    const { count, sample } = await dryRunSample(input.apolloApiKey, validFilters, alertIdentity);
    // Free, and only when the round excluded something: what those exclusions
    // removed. Without it the cost of an exclusion is the one thing the loop's
    // feedback cannot show.
    const exclusions = await probeExclusions(input.apolloApiKey, validFilters, alertIdentity);

    trace.push({
      iteration: step,
      action: "round",
      filters: validFilters,
      count,
      sample,
      exclusions,
      toContinue: toContinue !== false,
      notes: {
        whatWorked: whatWorked ?? "",
        whatToImprove: whatToImprove ?? "",
        nextExperiment: nextExperiment ?? "",
      },
      reasoning: reasoning ?? "",
    });

    if (toContinue === false) {
      stoppedReason = "model_stopped";
      break;
    }
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
    throw new Error(
      `[apollo-service][refineAudience] no filter set validated and matched at least one person (stopped: ${stoppedReason})`,
    );
  }

  return {
    filters: chosen.filters,
    count: chosen.count,
    status: "confirmed",
    // The model's own words about the round being returned. It already writes
    // "strict criteria" when it knows the set is tiny; that assessment now
    // reaches the flag instead of dying in the notes.
    degraded: describesNarrowOutcome(chosen.notes, chosen.reasoning),
    candidates,
    stoppedReason,
    trace,
  };
}
