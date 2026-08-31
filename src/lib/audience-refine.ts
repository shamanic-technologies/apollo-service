/**
 * Agentic "NL segment → Apollo filters" refinement loop.
 *
 * This logic moved OUT of human-service INTO apollo-service: given a segment
 * name + self-contained description, iterate Apollo People-Search filter sets,
 * use the FREE dry-run as live count feedback, and let the model explore
 * alternative encodings of the SAME target. The winning filter set + a count
 * snapshot are persisted by the caller (POST /audiences/suggest-from-segment).
 *
 * The LLM calls go through chat-service (which owns the LLM cost). The dry-run
 * Apollo people-search consumes NO Apollo credits at any per_page, so this loop
 * declares no cost of its own — same as POST /search/dry-run.
 *
 * TWO SEPARATE MODELS, TWO SEPARATE JOBS (see CLAUDE.md "MECE invariant"):
 * a PROPOSER emits filter sets and may maximize volume freely; an independent
 * GRADER judges each set's fit to the described target. The grader never sees
 * the count, never talks back to the proposer, and never authors a filter set,
 * so the volume preference cannot leak into the judgement. Selection stays
 * DETERMINISTIC in code (max count among both-flags-false iterations). There is
 * NO count floor, ambition, or target band; a size threshold is exactly what
 * pressures a set into breaking MECE.
 */

import { z } from "zod";
import { chatComplete, type ChatTrackingHeaders, type ChatProvider, type ChatModel } from "./chat-client.js";
import { toApolloSearchParams } from "./transform.js";
import { toCreditAlertIdentity, type CreditAlertIdentity } from "./credit-alert.js";
import { searchPeople } from "./apollo-client.js";
import { SearchFiltersSchema } from "../schemas.js";

/** Real dry-run attempts (each consumes a live count). The loop uses these to
 * test alternative encodings of the same target and to retry a filter VALUE
 * that returned 0 (dead value, live concept). */
const MAX_REAL_ATTEMPTS = 6;
/** Extra budget for unusable model output (malformed decision JSON or filters
 * rejected by the faithful schema). These do NOT consume a real attempt — a
 * model hiccup must not eat the exploration budget. */
const MAX_INVALID_RETRIES = 3;
/** A `confirm` is only accepted once this many DISTINCT filter sets have been
 * dry-run. Comparing two encodings of the same target is the act that surfaces
 * an off-target leak (a set that quietly dropped a stated constraint looks
 * perfectly fine on its own — it just returns a suspiciously large count). */
const MIN_ENCODINGS_BEFORE_CONFIRM = 2;
/** People pulled per dry-run so the grader sees REAL matched companies instead
 * of reasoning about filters in the abstract. Apollo bills zero credits for a
 * people-search teaser at any per_page. */
const DRY_RUN_SAMPLE_SIZE = 10;

/** Both the proposer and the grader run here. `glm-flash` → `glm-4.7-flashx`
 * (Z.ai): cheap, fast, honours `disableThinking` fully, and serves `json_schema`
 * structured output — which the grader's fixed-shape verdict uses. */
const REFINE_PROVIDER: ChatProvider = "zai";
const REFINE_MODEL: ChatModel = "glm-flash";

/** Nielsen Digital Ad Ratings vocabulary: "off-target" delivery vs the
 * unreached portion of the target. Both false = the set is MECE. */
export interface TargetFitJudgement {
  /** The set matches people OUTSIDE the described target. */
  reachesOffTarget: boolean;
  offTargetReason: string | null;
  /** The set excludes people INSIDE the described target. */
  leavesTargetUnreached: boolean;
  unreachedReason: string | null;
}

export interface RefineIteration {
  iteration: number;
  action: "test" | "confirm" | "invalid" | "rejected_confirm";
  filters: Record<string, unknown> | null;
  count: number | null;
  reasoning: string;
  validationErrors?: string[];
  /** Sample of companies Apollo actually matched — the evidence the grader was
   * shown. Persisted in the bronze trace so a verdict can be re-read later. */
  sampleCompanies?: string[];
  /** Judgement of THIS iteration's filter set, written by the INDEPENDENT
   * grader call (never by the proposer that authored the set). `null` only on
   * `invalid` rows — there is no usable filter set to judge. Both `false` =
   * selectable. */
  reachesOffTarget: boolean | null;
  offTargetReason: string | null;
  leavesTargetUnreached: boolean | null;
  unreachedReason: string | null;
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
  alertIdentity?: CreditAlertIdentity,
): Promise<number> {
  const apolloParams = { ...toApolloSearchParams(filters), page: 1, per_page: 1 };
  const result = await searchPeople(apolloApiKey, apolloParams, alertIdentity);
  return result.total_entries ?? result.pagination?.total_entries ?? 0;
}

/** Free Apollo dry-run that ALSO returns a small sample of matched people, so
 * the grader can judge off-target delivery from real company names rather than
 * from filter semantics alone. Same zero-credit teaser call. */
async function dryRunWithSample(
  apolloApiKey: string,
  filters: Record<string, unknown>,
  alertIdentity?: CreditAlertIdentity,
): Promise<{ count: number; sampleCompanies: string[] }> {
  const apolloParams = { ...toApolloSearchParams(filters), page: 1, per_page: DRY_RUN_SAMPLE_SIZE };
  const result = await searchPeople(apolloApiKey, apolloParams, alertIdentity);
  const count = result.total_entries ?? result.pagination?.total_entries ?? 0;
  const seen = new Set<string>();
  for (const person of result.people ?? []) {
    const org = person.organization;
    if (!org?.name) continue;
    const line = [org.name, org.industry ? `industry: ${org.industry}` : null, person.title ? `matched: ${person.title}` : null]
      .filter(Boolean)
      .join(" — ");
    seen.add(line);
  }
  return { count, sampleCompanies: [...seen] };
}

// ────────────────────────────────────────────────────────────────────────────
// PROPOSER — emits filter sets. It does NOT grade them.
// ────────────────────────────────────────────────────────────────────────────

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
    "=== AVAILABLE FILTERS (Apollo vocabulary) ===",
    catalog,
    "=== END FILTERS ===",
    "",
    "THE INVARIANT — every filter set you propose must be MECE with respect to the described target:",
    "- we do not add people who should not be there",
    "- we do not leave out people who should be there",
    "",
    "MECE is measured against the DESCRIBED target — what the description actually states, no more",
    "and no less. If the description names a sector, profession, geography, size or revenue band,",
    "the set must carry it. If the description names no sector, a set with no sector constraint is",
    "correct — inventing a constraint the description never stated leaves the target unreached.",
    "Read how loose the wording is: \"around\", \"roughly\", \"and similar\" widen the described target;",
    "strict, specific wording keeps it tight.",
    "",
    "THE OBJECTIVE — among the filter sets that hold the invariant, maximize volume.",
    "Two filter sets that describe the SAME target can return very different volumes, not because",
    "one is less correct, but because Apollo's index coverage differs by mechanism (an industry",
    "enum vs employer keyword tags vs free-text keywords vs titles). So maximizing volume among",
    "equally-correct sets is FREE — no fidelity is traded. You pick the mechanism; there is no",
    "preferred one.",
    "",
    "YOU DO NOT GRADE YOUR OWN SETS. An independent reviewer, who never sees any count, judges",
    "every set you propose against the description and decides whether it is MECE. Only sets it",
    "clears can win. Its verdict on your previous sets is quoted back to you each round — read it",
    "and address the reason; you cannot argue with it, only propose better.",
    "",
    "WHY YOU GET SEVERAL ROUNDS — use them for exactly two things:",
    "1. Test whether an Apollo value actually WORKS. A non-functional value returns 0 matches.",
    "   A 0 means \"this word does not work\", NOT \"this constraint is superfluous\" — try another",
    "   value, or another mechanism, for the SAME concept. Never drop the concept.",
    "2. Test DIFFERENT filter sets that should describe the SAME audience. Apollo's grammar allows",
    "   several encodings of one targeting intent; find the one where the index is richest.",
    "",
    "Each turn, reply with ONLY a JSON object (no prose, no code fences):",
    "{",
    '  "action": "test" | "confirm",',
    '  "filters": { ...filters... },',
    '  "reasoning": "<one short line>"',
    "}",
    '- "test": you want the live count for this filter set before deciding.',
    '- "confirm": you are done exploring. It does NOT mean "use this set" — the winning set is',
    "  chosen by count among every set the reviewer judged MECE.",
  ].join("\n");
}

/** Order-insensitive identity of a filter set, so "did I already try this
 * encoding?" is not fooled by key order. */
function encodingKey(filters: Record<string, unknown>): string {
  return JSON.stringify(filters, Object.keys(filters).sort());
}

function distinctEncodings(history: RefineIteration[]): number {
  const seen = new Set<string>();
  for (const h of history) {
    if (h.action === "invalid" || h.filters === null) continue;
    seen.add(encodingKey(h.filters));
  }
  return seen.size;
}

function judgementLine(h: RefineIteration): string {
  const off = h.reachesOffTarget ? `reachesOffTarget=true (${h.offTargetReason ?? "no reason given"})` : "reachesOffTarget=false";
  const un = h.leavesTargetUnreached
    ? `leavesTargetUnreached=true (${h.unreachedReason ?? "no reason given"})`
    : "leavesTargetUnreached=false";
  return `reviewer: ${off}, ${un}`;
}

function rejectionReasons(h: RefineIteration): string[] {
  const out: string[] = [];
  if (h.reachesOffTarget) out.push(`it reaches OFF-TARGET people — ${h.offTargetReason ?? "no reason given"}`);
  if (h.leavesTargetUnreached) out.push(`it LEAVES part of the target unreached — ${h.unreachedReason ?? "no reason given"}`);
  return out;
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
    // The invariant is restated EVERY round, independent of any count. A
    // threshold-gated nudge is what let a set with a dropped sector constraint
    // sail through unexamined once it was "big enough".
    "THE INVARIANT — your filter set must be MECE with respect to the described target:",
    "- we do not add people who should not be there",
    "- we do not leave out people who should be there",
    "Among the sets the reviewer judges MECE, the biggest count wins.",
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
      lines.push(`- #${h.iteration} count=${h.count} filters=${JSON.stringify(h.filters)} — ${judgementLine(h)}`);
    }
  }
  lines.push("");

  // The reviewer's reason for the most recent rejection, quoted explicitly.
  // Retrying blind is a random walk; a concrete reason ("matches Honeywell and
  // Rolex, which are not drugstores") is what makes the next round a search.
  const lastJudged = [...history].reverse().find((h) => h.action !== "invalid" && h.reachesOffTarget !== null);
  if (lastJudged) {
    const reasons = rejectionReasons(lastJudged);
    if (reasons.length > 0) {
      lines.push(`The reviewer REJECTED your last set (#${lastJudged.iteration}):`);
      for (const r of reasons) lines.push(`- ${r}`);
      if (lastJudged.sampleCompanies?.length) {
        lines.push(`It saw these matched companies: ${lastJudged.sampleCompanies.join(" | ")}`);
      }
      lines.push(
        "Fix exactly that, without dropping any concept the description states. Re-encode the failing " +
          "concept with another accepted value or another mechanism.",
      );
      lines.push("");
    }
  }

  const lastValid = [...history]
    .reverse()
    .find((h): h is RefineIteration & { count: number } => h.action !== "invalid" && h.count !== null);

  if (lastValid && lastValid.count === 0) {
    lines.push(
      "The last set returned 0 matches. Apollo applied the filter and matched nobody, so a VALUE in " +
        "that set does not work — it is NOT a signal that the constraint is superfluous. Keep every " +
        "concept the description states and re-encode the failing one: another accepted value, or " +
        "another mechanism for the same idea. Do not drop the concept.",
    );
    lines.push("");
  }

  const encodings = distinctEncodings(history);
  if (encodings < MIN_ENCODINGS_BEFORE_CONFIRM) {
    lines.push(
      `Only ${encodings} distinct encoding tried. Before you can confirm, test at least one ALTERNATIVE ` +
        "encoding of the SAME target (a different mechanism for one of the stated concepts) so the two " +
        "can be compared — that comparison is what reveals a set that quietly dropped a constraint.",
    );
    lines.push("");
  }

  lines.push(
    `You have ${MAX_REAL_ATTEMPTS - realAttemptsUsed} test(s) left. Propose another encoding (action "test"), ` +
      'or finish exploring (action "confirm").',
  );
  return lines.join("\n");
}

// ────────────────────────────────────────────────────────────────────────────
// GRADER — an independent verdict on a set it did not author.
// It never sees the count: showing it the number is exactly what let a 137-match
// sector-less set beat the 19-match correct one (#224).
// ────────────────────────────────────────────────────────────────────────────

const GraderVerdictSchema = z.object({
  reachesOffTarget: z.boolean(),
  offTargetReason: z.string().nullable().optional(),
  leavesTargetUnreached: z.boolean(),
  unreachedReason: z.string().nullable().optional(),
});

/** Fixed shape → the provider enforces it server-side (`json_schema`). */
const GRADER_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    reachesOffTarget: { type: "boolean" },
    offTargetReason: { type: ["string", "null"] },
    leavesTargetUnreached: { type: "boolean" },
    unreachedReason: { type: ["string", "null"] },
  },
  required: ["reachesOffTarget", "offTargetReason", "leavesTargetUnreached", "unreachedReason"],
};

function buildGraderSystemPrompt(): string {
  return [
    "You review Apollo People Search filter sets built for a described B2B audience. You did NOT",
    "write the filter set. You do not propose alternatives, and you do not negotiate — you return",
    "one verdict on the set in front of you.",
    "",
    "Judge it on ONE invariant — is this filter set MECE with respect to the DESCRIBED target?",
    "- reachesOffTarget: the set matches people OUTSIDE the described target (a stated constraint",
    "  is missing or too loose, so people the description excludes are swept in). The sample of",
    "  companies Apollo actually matched is your evidence: if they are not the kind of employer the",
    "  description names, the set reaches off-target.",
    "- leavesTargetUnreached: the set excludes people INSIDE the described target (a constraint the",
    "  description never stated was invented, or a stated one was encoded too narrowly).",
    "",
    "MECE is measured against what the description ACTUALLY STATES, no more and no less.",
    "- Every concept the description names — sector, shop type, profession, geography, size,",
    "  revenue band, an explicit exclusion — must be carried by the set. A set that dropped one",
    "  reaches off-target, however reasonable the remainder looks.",
    "- A description that names NO sector is correctly served by a set with no sector constraint.",
    "  Demanding a constraint the description never stated leaves the target unreached.",
    '- Loose wording ("around", "roughly", "and similar") widens the described target; strict,',
    "  specific wording keeps it tight.",
    "",
    "You are NOT told how many people the set matches, and audience size is NOT your concern.",
    "A precise set is not \"over-filtered\" and a broad one is not \"good coverage\" — only fit to the",
    "description counts. Never reason about volume.",
    "",
    "Reply with ONLY this JSON object (no prose, no code fences):",
    "{",
    '  "reachesOffTarget": true | false,',
    '  "offTargetReason": "<short why>" | null,',
    '  "leavesTargetUnreached": true | false,',
    '  "unreachedReason": "<short why>" | null',
    "}",
    "Give the reason when a flag is true, null when it is false. Be concrete: name the concept that",
    "is missing, invented, or the matched company that does not belong.",
  ].join("\n");
}

function buildGraderUserMessage(
  input: RefineInput,
  filters: Record<string, unknown>,
  sampleCompanies: string[],
): string {
  return [
    `Segment name: ${input.name}`,
    `Segment description: ${input.description}`,
    "",
    "Filter set under review:",
    JSON.stringify(filters),
    "",
    sampleCompanies.length > 0
      ? `Companies Apollo matched with it (sample):\n${sampleCompanies.map((c) => `- ${c}`).join("\n")}`
      : "Apollo returned no sample companies for this set.",
    "",
    "Return your verdict.",
  ].join("\n");
}

/** One independent verdict per candidate set. Fails loud — a grader that cannot
 * answer must not be defaulted to "clean" (that is precisely the bug this
 * split exists to remove). */
async function gradeFilters(
  input: RefineInput,
  filters: Record<string, unknown>,
  sampleCompanies: string[],
): Promise<TargetFitJudgement> {
  const res = await chatComplete(
    {
      message: buildGraderUserMessage(input, filters, sampleCompanies),
      systemPrompt: buildGraderSystemPrompt(),
      provider: REFINE_PROVIDER,
      model: REFINE_MODEL,
      responseFormat: "json",
      responseSchema: GRADER_RESPONSE_SCHEMA,
      temperature: 0,
      maxTokens: 500,
      disableThinking: true,
    },
    input.tracking,
  );

  const parsed = GraderVerdictSchema.safeParse(res.json);
  if (!parsed.success) {
    throw new Error(
      `[apollo-service][refineAudience] grader returned an unusable verdict: ${parsed.error.issues
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join("; ")}`,
    );
  }
  return {
    reachesOffTarget: parsed.data.reachesOffTarget,
    offTargetReason: parsed.data.offTargetReason ?? null,
    leavesTargetUnreached: parsed.data.leavesTargetUnreached,
    unreachedReason: parsed.data.unreachedReason ?? null,
  };
}

/** DETERMINISTIC final selection: the biggest count among the iterations the
 * GRADER judged MECE — both flags false — and matching at least one person. The
 * proposer's `confirm` only ends exploration; it does not pick.
 *
 * A tried set is NOT automatically eligible: the Zod schema validated its
 * VOCABULARY (field names + accepted values), never its fit to the described
 * target. Fit is exactly what the two flags carry. */
function pickBest(history: RefineIteration[]): { filters: Record<string, unknown>; count: number } | null {
  const mece = history.filter(
    (h): h is RefineIteration & { filters: Record<string, unknown>; count: number } =>
      h.action !== "invalid" &&
      h.filters !== null &&
      h.count !== null &&
      h.count > 0 &&
      h.reachesOffTarget === false &&
      h.leavesTargetUnreached === false,
  );
  if (mece.length === 0) return null;
  return mece.reduce((a, b) => (b.count > a.count ? b : a));
}

export async function refineAudience(input: RefineInput): Promise<RefineResult> {
  const systemPrompt = buildSystemPrompt(input.filtersPromptCatalog);
  const trace: RefineIteration[] = [];

  // Two separate budgets: MAX_REAL_ATTEMPTS live dry-runs (the exploration
  // budget), plus MAX_INVALID_RETRIES extra turns for unusable model output that
  // must NOT eat a real attempt. `step` numbers the trace rows in order. The
  // grader adds one CALL per real attempt — never an extra iteration.
  let realAttempts = 0;
  let invalidRetries = 0;
  let step = 0;
  let doneExploring = false;

  while (realAttempts < MAX_REAL_ATTEMPTS) {
    step += 1;
    const message = buildUserMessage(input, trace, realAttempts);
    const res = await chatComplete(
      {
        message,
        systemPrompt,
        // The filter object is SPARSE (a few of ~18 optional Apollo filters), so
        // it cannot carry a strict `responseSchema` — plain JSON mode + the Zod
        // guards below. GLM (`glm-flash` → glm-4.7-flashx) turns reasoning fully
        // off for structured output, so the whole budget goes to the decision.
        provider: REFINE_PROVIDER,
        model: REFINE_MODEL,
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
        reachesOffTarget: null,
        offTargetReason: null,
        leavesTargetUnreached: null,
        unreachedReason: null,
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
      trace.push({
        iteration: step,
        action: "invalid",
        filters,
        count: null,
        reasoning: reasoning ?? "",
        validationErrors,
        reachesOffTarget: null,
        offTargetReason: null,
        leavesTargetUnreached: null,
        unreachedReason: null,
      });
      if (invalidRetries > MAX_INVALID_RETRIES) break;
      continue;
    }

    // A valid filter set we can dry-run — this consumes one real attempt.
    realAttempts += 1;
    const validFilters = filterCheck.data as Record<string, unknown>;
    const { count, sampleCompanies } = await dryRunWithSample(
      input.apolloApiKey,
      validFilters,
      toCreditAlertIdentity(input.tracking),
    );

    // The verdict comes from a call that did not author this set, and is not
    // told the count. Fails loud on a bad verdict — no default-to-clean.
    const judgement = await gradeFilters(input, validFilters, sampleCompanies);

    // A confirm before a second encoding has been tried is premature: without a
    // contrast set there is nothing to compare against, and a set that silently
    // dropped a stated constraint looks fine on its own.
    const encodingsWithThisOne = new Set([
      ...trace.filter((h) => h.action !== "invalid" && h.filters !== null).map((h) => encodingKey(h.filters!)),
      encodingKey(validFilters),
    ]).size;
    const prematureConfirm = action === "confirm" && encodingsWithThisOne < MIN_ENCODINGS_BEFORE_CONFIRM;

    trace.push({
      iteration: step,
      action: action === "confirm" && prematureConfirm ? "rejected_confirm" : action,
      filters: validFilters,
      count,
      reasoning: reasoning ?? "",
      sampleCompanies,
      reachesOffTarget: judgement.reachesOffTarget,
      offTargetReason: judgement.offTargetReason,
      leavesTargetUnreached: judgement.leavesTargetUnreached,
      unreachedReason: judgement.unreachedReason,
    });

    if (action === "confirm" && !prematureConfirm) {
      doneExploring = true;
      break;
    }
  }

  // Selection is ours, not the model's: the biggest MECE-judged set wins,
  // whichever round produced it. No MECE-judged set at all → fail loud. The
  // caller (human-service) runs per-segment builds under Promise.allSettled, so
  // losing one bad segment is correct — better no audience than a false one.
  const best = pickBest(trace);
  if (!best) {
    throw new Error(
      "[apollo-service][refineAudience] no filter set was judged MECE with the described target (both reachesOffTarget and leavesTargetUnreached false) with at least one match",
    );
  }
  return { filters: best.filters, count: best.count, status: doneExploring ? "confirmed" : "exhausted", trace };
}
