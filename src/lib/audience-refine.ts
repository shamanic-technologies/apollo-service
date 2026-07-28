/**
 * Agentic "NL segment → Apollo filters" refinement loop.
 *
 * This logic moved OUT of human-service INTO apollo-service: given a segment
 * name + self-contained description, iterate Apollo People-Search filter sets,
 * use the FREE dry-run as live count feedback, and let the model explore
 * alternative encodings of the SAME target. The winning filter set + a count
 * snapshot are persisted by the caller (POST /audiences/suggest-from-segment).
 *
 * The LLM call goes through chat-service (which owns the LLM cost). The dry-run
 * Apollo people-search (per_page=1) consumes NO Apollo credits, so this loop
 * declares no cost of its own — same as POST /search/dry-run.
 *
 * OBJECTIVE (see CLAUDE.md "MECE invariant + max volume among MECE"):
 * the loop is NOT steered by size. Every round the model must hold ONE
 * invariant — the filter set is MECE with respect to the DESCRIBED target
 * (adds nobody who should not be there, leaves out nobody who should be there)
 * — and among the sets that hold it, the largest count wins. Selection is
 * DETERMINISTIC in code (max count among both-flags-false iterations), not the
 * model's `confirm`. There is NO count floor, ambition, or target band; a size
 * threshold is exactly what pressures the model into breaking MECE.
 */

import { z } from "zod";
import { chatComplete, type ChatTrackingHeaders } from "./chat-client.js";
import { toApolloSearchParams } from "./transform.js";
import { searchPeople } from "./apollo-client.js";
import { SearchFiltersSchema } from "../schemas.js";

/** Real dry-run attempts (each consumes a live count). The loop uses these to
 * test alternative encodings of the same target and to retry a filter VALUE
 * that returned 0 (dead value, live concept). */
const MAX_REAL_ATTEMPTS = 6;
/** Extra budget for unusable model output (malformed decision JSON or filters
 * rejected by the faithful schema). These do NOT consume a real attempt — a
 * Gemini hiccup must not eat the exploration budget. */
const MAX_INVALID_RETRIES = 3;
/** A `confirm` is only accepted once this many DISTINCT filter sets have been
 * dry-run. Comparing two encodings of the same target is the act that surfaces
 * an off-target leak (a set that quietly dropped a stated constraint looks
 * perfectly fine on its own — it just returns a suspiciously large count). */
const MIN_ENCODINGS_BEFORE_CONFIRM = 2;

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
  /** Judgement of THIS iteration's filter set. `null` only on `invalid` rows —
   * there is no usable filter set to judge. Both `false` = selectable. */
  reachesOffTarget: boolean | null;
  offTargetReason: string | null;
  leavesTargetUnreached: boolean | null;
  unreachedReason: string | null;
  /** Later rounds may RE-JUDGE this iteration (count known, an alternative
   * encoding available for contrast — a much less biased act than grading your
   * own proposal before seeing its count). Newest revision wins and is mirrored
   * onto the flat fields above; the full history stays here. */
  revisions?: Array<TargetFitJudgement & { atIteration: number }>;
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

const TargetFitSchema = z.object({
  reachesOffTarget: z.boolean(),
  offTargetReason: z.string().nullable().optional(),
  leavesTargetUnreached: z.boolean(),
  unreachedReason: z.string().nullable().optional(),
});

/** Model decision schema for one refine turn. The two booleans are REQUIRED —
 * a decision that does not grade its own proposal is unusable output, not a
 * default-to-clean. */
const RefineDecisionSchema = TargetFitSchema.extend({
  action: z.enum(["test", "confirm"]),
  filters: z.record(z.string(), z.unknown()),
  reasoning: z.string().optional(),
  /** Re-judgements of EARLIER iterations, by 1-based `iteration` number. */
  revisions: z.array(TargetFitSchema.extend({ iteration: z.number().int() })).optional(),
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
    '  "reasoning": "<one short line>",',
    '  "reachesOffTarget": true | false,',
    '  "offTargetReason": "<short why>" | null,',
    '  "leavesTargetUnreached": true | false,',
    '  "unreachedReason": "<short why>" | null,',
    '  "revisions": [ { "iteration": <n>, "reachesOffTarget": …, "offTargetReason": …, "leavesTargetUnreached": …, "unreachedReason": … } ]',
    "}",
    '- "test": you want the live count for this filter set before deciding.',
    '- "confirm": you are done exploring. It does NOT mean "use this set" — the winning set is',
    "  chosen by count among every set you judged MECE, so grade honestly rather than strategically.",
    "- The four judgement fields grade the filter set in THIS message: reachesOffTarget = it matches",
    "  people outside the described target; leavesTargetUnreached = it excludes people inside it.",
    "  Give the matching reason when a flag is true, null when it is false. Both are REQUIRED.",
    '- "revisions" (optional): re-judge an EARLIER iteration now that you know its count and have an',
    "  alternative encoding to compare it against. You graded that set before seeing any of that.",
    "  Re-grade it honestly. Omit the key when you have nothing to revise.",
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
  const revised = h.revisions?.length ? ` [re-judged at iteration ${h.revisions[h.revisions.length - 1]!.atIteration}]` : "";
  return `${off}, ${un}${revised}`;
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
    "Among the sets that hold it, the biggest count wins.",
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
      'or finish exploring (action "confirm"). Re-judge any earlier iteration through "revisions" if seeing ' +
      "its count next to an alternative changes your read of it.",
  );
  return lines.join("\n");
}

/** Apply a round's `revisions` onto earlier iterations: newest judgement wins on
 * the flat fields, full history kept under `revisions`. A revision pointing at an
 * unknown or unjudgeable iteration is model noise — logged, never silently
 * merged into another row. */
function applyRevisions(
  trace: RefineIteration[],
  revisions: z.infer<typeof RefineDecisionSchema>["revisions"] & {},
  atIteration: number,
): void {
  for (const rev of revisions) {
    const target = trace.find((h) => h.iteration === rev.iteration);
    if (!target || target.action === "invalid") {
      console.warn(
        `[apollo-service][refineAudience] revision at iteration ${atIteration} targets unknown/unjudgeable iteration ${rev.iteration} — ignored`,
      );
      continue;
    }
    const judgement: TargetFitJudgement = {
      reachesOffTarget: rev.reachesOffTarget,
      offTargetReason: rev.offTargetReason ?? null,
      leavesTargetUnreached: rev.leavesTargetUnreached,
      unreachedReason: rev.unreachedReason ?? null,
    };
    target.revisions = [...(target.revisions ?? []), { ...judgement, atIteration }];
    target.reachesOffTarget = judgement.reachesOffTarget;
    target.offTargetReason = judgement.offTargetReason;
    target.leavesTargetUnreached = judgement.leavesTargetUnreached;
    target.unreachedReason = judgement.unreachedReason;
  }
}

/** DETERMINISTIC final selection: the biggest count among the iterations judged
 * MECE — both flags false after any later-round revision — and matching at least
 * one person. The model's `confirm` only ends exploration; it does not pick.
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
  // must NOT eat a real attempt. `step` numbers the trace rows in order.
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
        reasoning: "model decision did not match {action, filters, target-fit flags}",
        validationErrors: parsed.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`),
        reachesOffTarget: null,
        offTargetReason: null,
        leavesTargetUnreached: null,
        unreachedReason: null,
      });
      if (invalidRetries > MAX_INVALID_RETRIES) break;
      continue;
    }

    const { action, filters, reasoning, revisions } = parsed.data;

    // A later round may re-judge earlier iterations — apply before this round's
    // own row lands, so a revision can never target the row being written.
    if (revisions?.length) applyRevisions(trace, revisions, step);

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
    const count = await dryRunCount(input.apolloApiKey, validFilters);

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
      reachesOffTarget: parsed.data.reachesOffTarget,
      offTargetReason: parsed.data.offTargetReason ?? null,
      leavesTargetUnreached: parsed.data.leavesTargetUnreached,
      unreachedReason: parsed.data.unreachedReason ?? null,
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
