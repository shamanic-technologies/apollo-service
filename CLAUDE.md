# Project: apollo-service

Apollo.io integration service for lead search, enrichment, and validation with cost tracking via runs-service.

## apollo-service OWNS "an Apollo audience" — faithful Apollo vocabulary, single source

This service is the single owner of the Apollo People-Search filter vocabulary
and of saved Apollo audiences. The filter schema (`SearchFiltersSchema`) is 1:1
FAITHFUL to Apollo's real People Search API — full accepted value sets, no
narrowed/renamed enums. Consumers (human-service) store ONLY an apollo-audience
id (a pointer); they must NOT hold or reinvent Apollo's filter vocabulary.

- **Faithful filters (do NOT re-subset).** Seniorities include the FULL Apollo
  set incl `head` + `intern`. `organizationNumEmployeesRanges` accepts ARBITRARY
  `"min,max"` spans (not a fixed bucket enum). `*_range` params are `{min,max}`
  objects (`revenueRangeNative`, `organizationFoundedYearRange`,
  `organizationNumJobsRange`, `personTotalYoeRange`, … — see the "{min,max}"
  section below). `includeSimilarTitles` is exposed. Any NEW Apollo people-search
  filter is ADDITIVE/backward-compatible — widen, never narrow, and map it in
  `toApolloSearchParams` (`*_range` → `{min,max}` via `cleanRange`). A real
  Apollo people-search filter that is MISSING from the schema is a **gap to
  fill**, never an optional "want me to add it?" — surface it and add it. (Cost
  2026-06-25: funding filters were entirely absent from the input path; framing
  the add as optional drew a sharp correction.)
- **Stateful audiences (Bronze/Silver/Gold).** `apollo_audiences` table:
  bronze = `refine_trace` (raw refine iterations + counts), silver = `filters`
  (canonical faithful filter object keyed by id), gold = `count` snapshot.
- **The NL-segment→filters agentic refine loop lives HERE** (`src/lib/audience-refine.ts`),
  not in human-service. It calls **chat-service** for the LLM (chat-service owns
  the LLM cost — apollo-service declares NONE for it) and uses the FREE Apollo
  people-search teaser (zero credits at any page size) for live feedback.
- **The refine loop gets DATA and CONTEXT, never targeting rules — do not add
  rules to it.** Every round the model receives: the original request VERBATIM,
  the Apollo filter catalog (`buildFiltersPrompt`), the COLD-EMAIL business
  context (below), its round budget, and the FULL ordered history of previous
  rounds. Up to **6** rounds (`MAX_ROUNDS`), plus a SEPARATE
  `MAX_INVALID_RETRIES` (3) budget for malformed output and a SEPARATE
  `MAX_DUPLICATE_RETRIES` (3) budget for a repeated encoding — neither may eat a
  round.
  - **The budget is SIX since 2026-09-11, down from ten — a deliberate latency
    trade, not an oversight.** The onboarding audience step waited ~100s for the
    suggest chain (prod p50 75s, p90 121s) and this loop is its biggest slice.
    Prod evidence over 515 runs / 30 days: 345 (67%) exhausted the round budget
    and only 101 ended on the model's own `confirm` — the model almost never
    stops by itself — while an A/B on three real prod descriptions found the best
    set by round 3-4 in all three cases, rounds 5-10 mostly re-exploring. Six
    rounds buys ~25s per audience for some exploration. This REVERSES the
    "spend the budget before answering" intent of the commit that raised it;
    owner's call (Kevin, 2026-09-11). The deadline, the invalid/duplicate
    budgets and the candidate contract are untouched.
  - **The model has never been told what the audience is FOR — that was the root
    cause, and the fix is the cold-email context, not another rule.** With only a
    description, PRECISION is the only objective a model can infer, so it stacks
    ANDed constraints with great diligence and ships an audience of 4. Ablating
    one shipped final set one constraint at a time: 4 as shipped → 7 without the
    employee ranges → 23 without seniorities → 161 without `organization_industries`
    → **664** without the 27-term `q_not_organization_keyword_tags` blocklist →
    10,791 without industries + both blocklists. Apollo assigns roughly ONE
    industry per company (listing four and missing the right one deletes the
    target) and a drugstore carrying an incidental `beauty` tag excludes itself
    from its own audience. `COLD_EMAIL_CONTEXT` states the trade-off: noise costs
    a little budget, an audience of 4 makes the engagement pointless.
  - **BOTH halves of the volume guidance ship together, or the change is a
    regression.** The orientation numbers (hard to justify below ~2,000
    contactable, a durable client looks like ~50,000) are CONTEXT explaining why
    volume matters — NOT a floor. A model told "below 2,000 is pointless" without
    the counterweight loosens until it reaches 2,000, and the only way there is
    Migros Industrie, ADM and Emmi. So the prompt says plainly, in the same
    breath, that a genuinely small market is a VALID, CORRECT answer to be
    reported honestly rather than inflated, and never to loosen the request to
    reach a number. A numeric target in a prompt makes a model fabricate when
    reality cannot meet it — documented in this codebase; this is its live case.
  - **THIS SERVICE EXPLORES AND REPORTS — IT DOES NOT CHOOSE (#246).** Every round
    is persisted as its own `apollo_audiences` row and every round is returned, in
    ROUND ORDER, as `candidates[]` — each carrying its persisted apollo-audience
    id, its filters, its live count, its 24 random-page sample rows and the model's
    three notes. Nothing here ranks, scores or sorts. WHICH audience serves the
    customer is a product decision made in **human-service**: it did not author the
    sets (so it has no stake in any of them) and choosing among N is COMPARATIVE,
    which is exactly what does not degenerate. `toContinue` stays — the model may
    still stop early when satisfied. Rows are cheap and the unchosen ones are a
    useful record of what was explored.
  - **`showable` is DELETED and no per-round self-grade replaces it, under any
    name.** It was `true` on 60 of 60 rounds. That is the THIRD absolute
    self-judgement in this loop to degenerate to a constant —
    `reachesOffTarget`/`leavesTargetUnreached` were always clean, `matchesRequest`
    was always true (including on World Health Organization and HORNBACH
    Baumarkt), `showable` was always true — so selection collapsed to plain
    argmax-count and the loosest round of each run won (179,156 people at Mars,
    Lidl, Bucherer and Manor, marked showable). The pattern is settled: a model
    grading its own proposal in isolation answers the same way every time. The
    exploration was never the problem — nearly every run already contains a round
    in the low hundreds to ~2,000 with recognisable targets. The model writes the
    right filter set; it cannot pick it. Do NOT re-introduce a per-round
    self-grade, and do NOT convert one into a ranking.
  - **Each round's history entry carries filters, count, sample and the model's
    own three one-sentence notes** (`whatWorked`, `whatToImprove`,
    `nextExperiment`). The notes are the model's own memory of what it was trying —
    they are fed back, never graded, and they ship on the candidate so whoever
    chooses can read what the round was for.
  - **Each dry-run returns a COUNT and a SAMPLE of who matched** (`dryRunSample`):
    **24** people drawn from up to 3 RANDOM pages (`SAMPLE_PAGES` ×
    `SAMPLE_ROWS_PER_PAGE`, clamped to Apollo's 500-page cap), each rendered as
    `employer — title`. Ten rows was too thin a basis for judging the composition
    of a several-thousand-person set and the teaser is free at any page size, so
    #249 raised it; keep the RANDOM-page draw.
    **That is ALL Apollo's free teaser serves** — a person comes back as
    `id, first_name, last_name_obfuscated, title, organization` plus `has_city` /
    `has_state` / `has_country` BOOLEANS, and the nested organization carries only
    `name` (verified live 2026-08-31). City, country, domain and industry are NOT
    obtainable at zero credits; do not re-add them to `SampledPerson` expecting
    values. Consequence worth knowing: the sample exposes an off-target SECTOR
    (Emmi Group and World Vision in a "drugstores" audience) but cannot expose a
    GEOGRAPHY leak, so a bare `Switzerland` where cantons were asked for gets no
    feedback from it. **That is ACCEPTED, by design: geography is out of scope for
    the loop's feedback and the CUSTOMER is the feedback loop for that axis** — the
    resulting Apollo filters are rendered in the onboarding UI, so a missing canton
    constraint is visible to the human who wrote the request. Do NOT "fix" it with a
    geography rule in the prompt, and do NOT try to re-derive location from company
    names. Real per-person location would need paid enrichment, which turns a free
    sample into a billed one. Random pages, never the head: Apollo RANKS results, so page 1 is
    biased in the direction that hides the bug (a set leaking into Romandie shows
    clean German-Swiss shops on page 1 while Geneva sits on page 40). The sample
    is what REPLACES the deleted rules — the model sees Procter & Gamble and Rolex
    in a "drugstores" audience and draws its own conclusion, and sees a sample thin
    out when it invented a headcount clamp. Do NOT re-add the rules alongside it.
  - **A COUNT WITHOUT A SAMPLE IS NOT A CALIBRATION — never judge the loop against
    a hand-built number nobody looked at.** A "1,919-person hand-built equivalent"
    was used to call six prod runs (4-80) a 24x-480x under-reach; sampling that set
    live returned ADM, Omya, Emmi Group, HOCHDORF and DocMorris — ingredient and
    food multinationals matched by broad tags (`organic products`, `natural foods`,
    `nutritional supplements`), not drugstore owners. The count was real, the
    relevance was never checked, and the whole judgement inverted once it was
    (2026-09-01, #241/#242). Swiss Drogerien are 2-5-person shops: Apollo holds
    them in the LOW HUNDREDS with verified emails, so a small count for a niche
    local trade is the correct answer, not a bug. Sample any reference set before
    comparing the loop to it — the same instrument the loop itself runs on.
  - **The single-result fields are LEGACY and additive.** `apolloAudienceId` /
    `filters` / `count` / `degraded` stay on the response beside `candidates`:
    the largest non-empty round, with `degraded` now carrying the model's own
    description of THAT round (see above). Additive on purpose: human-service migrates to `candidates` on
    its own schedule, so there is no deploy-ordering constraint in either
    direction. A LATER PR removes them once human-service reads `candidates`.
  - **Never throw, except for real errors.** Missing config, and a run that ends
    with NO round having matched anybody (`count === 0` everywhere, including a
    run where every turn failed), still throw. Everything else returns the
    candidate list.
  - **A REJECTED model response burns the invalid-retry budget, it does not end
    the run.** chat-service answers **502** when the model's output does not parse
    (`{"error":"LLM returned invalid JSON.", …}`), and that throw used to escape
    `refineAudience` and discard every round already explored — one bad turn out
    of ten returned a 500 and the customer saw a generic chat error. A response
    that fails to PARSE and one that parses into the WRONG SHAPE are the same
    class of provider hiccup, so the `chatComplete` call is wrapped and a failure
    is traced as `action:"invalid"` carrying the upstream message verbatim
    (never swallowed), costing one `MAX_INVALID_RETRIES` unit and no round. Only
    exhausting that budget ends the run, and it ends by RETURNING the rounds
    already explored. Do NOT retry the run as a whole.
  - **The endpoint bounds its own wall clock: `REFINE_DEADLINE_MS` = 210s.** A
    measured full run was ~149s at the old ten-round budget (10 turns × 13-16s;
    six rounds land near ~90s) and extra turns for invalid
    output or duplicates push the real worst case well past that, so three
    consecutive attempts died at the caller's 120s abort — with ten candidates
    already persisted on our side each time, and nothing delivered. A caller
    cannot pick a sensible timeout for an endpoint that offers no bound, so the
    bound lives HERE: no new turn starts past the deadline, an in-flight
    completion is aborted at it (`AbortSignal.timeout`, and `fetchWithRetry` does
    not retry an aborted call), and a round whose completion lands after it is not
    dry-run. The run then answers with what it explored. **210s is paired with
    human-service's 240s wait** — the margin covers the network and the caller's
    own work; changing one without the other re-opens the bug.
  - **`stoppedReason` says whether the run finished on its own terms.**
    `model_stopped` / `rounds_exhausted` / `deadline` /
    `invalid_budget_exhausted` / `duplicate_budget_exhausted`, additive on the
    response beside `candidates`, with a terminal `action:"deadline"` row in the
    trace for a truncated run. A consumer must be able to tell a complete
    exploration from a cut-short one; every round is persisted as it goes, so
    answering early costs nothing.
  - **A run with no usable set logs its FULL trace** (`logRefineTrace`): every
    attempt's filters, count, sample and reasoning, in one structured `console.warn`.
    Nothing on the happy path. Without it, an over-strict judgement is
    indistinguishable from a broken call and the only option is a revert (#227).
  - **The loop runs on `provider:"anthropic", model:"sonnet"` (Claude Sonnet 5.5) — since
    2026-09-29.** Owner decision: every LLM call of the public onboarding moves to
    Sonnet 5.5 (Astra was slow and broke onboarding when the OpenAI credit ran out on
    2026-09-28); campaign audience builds switch with it. This SUPERSEDES the "Anthropic
    is off the table" line below. Anthropic JSON mode REQUIRES a strict `responseSchema`
    (`REFINE_DECISION_JSON_SCHEMA`), so `filters` travels as a JSON-ENCODED STRING and
    the prompt says so; the Zod guard still decodes both forms. No sampling parameter
    (Sonnet 5.5 400s on `temperature`). Thinking cannot be off: `disableThinking: true`
    maps to `output_config.effort: "low"`; `maxTokens` 8000 covers the thinking tokens.
  - **Previous model, kept: `provider:"openai", model:"gpt-pro"` (GPT-6 Astra),
    2026-09-09 → 2026-09-29**, schemaless JSON, reasoning at its default, ~10.8 s p50 per round.
  - **Model history, kept: the loop previously ran on `provider:"zai", model:"glm-pro"`.**
    Cheap AND smart, per the owner's instruction. A/B'd against `deepseek/deepseek-pro`
    on the Swiss-drugstores description, 3 runs each (2026-09-01): glm-pro returned
    13 / 171 / 15 with employers that are recognisably the target (Vita Drogerie AG,
    LANUR, PANVEGA, Markthalle Luzern); deepseek-pro returned 268 / 203 / 1 with
    Emmi Group, Transgourmet, Möbel Pfister and CALIDA in its samples — a wider
    spread AND off-target companies. **Anthropic is off the table for this loop for
    good** (do NOT return to `opus` when the platform account's usage cap lifts), and
    `google/pro` was only the emergency swap that replaced it (#236). No
    `responseSchema` is sent: the Zod guards validate the decision, and the guard
    still accepts `filters` as an object OR a JSON string — plain tolerance of the
    wire shape, not an Anthropic contortion. Do NOT set `disableThinking` or a
    thinkingLevel floor: judgement is the whole job here.
  - **The prompt states Apollo's filter ALGEBRA, both halves — that is the
    INSTRUMENT, not a targeting rule (#249).** It used to say only "All filters AND
    together", which is true ACROSS fields and FALSE WITHIN one, i.e. exactly the
    half that makes adding a field look safe when it is the most destructive move
    available. Measured live on `person_locations:["Switzerland"]`: tags
    `["drogerie"]` 429 + `["bioladen"]` 58 = `["drogerie","bioladen"]` **487** (a
    clean union), `organization_industries` `["retail"]` 34,615 → with
    `"consumer goods"` **45,190**, `person_titles` `["Owner"]` 9,873 →
    `["Owner","Inhaber"]` **11,601**; but tags `["drogerie"]` AND
    `organization_industries:["retail"]` = **372**, fewer than the tag alone.
    `APOLLO_FILTER_ALGEBRA` states both halves with those numbers ANONYMISED (tag
    A / tag B — a standing prompt must not name a vertical), and `buildUserMessage`
    RESTATES the semantics next to the raw filter JSON so they do not decay across
    turns. Same section carries the corollary: because values union, a value
    matching 0 rows is INVISIBLE in the total (`drogerie` 429, `drogerien` 196,
    `reformhaus` 2, `naturkost` 0), so an unchanged count after adding a value
    means THAT VALUE IS DEAD, not that the concept is unreachable.
  - **An EXCLUSION's cost is MEASURED and handed back, because a count cannot
    show it (#259).** A count says how many a set matched and never who it
    removed, so an exclusion is the one move in Apollo's vocabulary whose cost is
    invisible in the loop's own feedback — a customer's own "not pharmacies" took
    a real audience from 514 to 106 and nothing in the run could see it. Every
    round that uses an exclusion field (`q_not_organization_keyword_tags`,
    `person_not_titles`, `currently_not_using_any_of_technology_uids`, the
    `not_organization_*_codes` pair, and their camelCase aliases) is followed by
    the SAME query WITHOUT them: one count per exclusion field, plus the count
    AND the 24-row sample with all of them dropped (`probeExclusions`). Free —
    the teaser costs zero credits — and reported back as data on the next turn
    and on the persisted trace. There is NO rule about which exclusions are
    suspect and nothing in the code acts on the numbers; the model reads the
    difference and decides. The general fact, stated once in the prompt's algebra
    block and in the field's own description, is that an exclusion removes an
    entity when ANY listed value matches, so a target carrying an excluded tag
    incidentally excludes itself. Do NOT turn this into a threshold, a warning or
    an auto-drop.
  - **`degraded` is the model's OWN prose, not a floor (#259).** It used to be a
    constant `false`, so a 7-person audience the model itself described as
    "~7 contacts identified with these strict criteria" shipped as a normal
    result. `describesNarrowOutcome` reads the sentences the model ALREADY wrote
    (its three notes + its reasoning) for narrowness words and flags the returned
    round. This is deliberately NOT a fourth per-round self-grade — nothing is
    asked of the model — and deliberately NOT a count threshold: a 180k round the
    model calls narrow is flagged, a 9-person round it does not is not. It errs
    toward flagging; announcing a fine audience as narrow is recoverable,
    announcing an audience of 7 as normal is what happened.
  - **A round is never spent on a query already run (#249).** `encodingKey()`
    canonicalises a filter set (keys sorted, values sorted, empty/null fields
    dropped) — value order and empty fields do not make a set different. A repeat
    burns a `MAX_DUPLICATE_RETRIES` turn instead of a round, is traced as
    `action:"duplicate"` and is shown back to the model as
    `#N DUPLICATE of an earlier round`. Production runs were losing a fifth of the
    budget to it (574 twice, 931 twice, 2,321 twice in single runs).
  - **Employee ranges behave CORRECTLY — do not "fix" them.** An
    `organization_num_employees_ranges` filter does NOT drop rows whose headcount
    Apollo does not know: all eight ranges cumulated returns the same count as no
    filter at all (429 = 429), so every row carries a known headcount. A 1-50 cap
    genuinely excludes larger employers, which is what it is for.
  - **DO NOT re-add:** the MECE vocabulary and its restated invariant, the
    "maximize volume among the MECE sets" objective, the `reachesOffTarget` /
    `leavesTargetUnreached` self-grading fields, `pickBest`, `MIN_ENCODINGS_BEFORE_CONFIRM`,
    the 0-count "never drop the concept" rule, the "never invent a firmographic
    constraint" rule, the frozen-count "wrong lever" rule, a geography rule, or any
    count floor, ambition, target band or scoring function — and `showable`, or any
    per-round self-grade wearing a different name. (`COLD_EMAIL_CONTEXT` is not on
    this list: it is what the audience is FOR, not what to look for.) Every one of them was added after a specific
    incident, and the pile is what made the results a lottery: the same request
    produced 2,640 (correct, 19 German-speaking cantons), 161 (an invented headcount
    clamp) and 1,222 (geography collapsed to bare `Switzerland`) in one day. If a
    fix adds an instruction to this prompt, it is the wrong fix — the model has the
    count, the sample and its own judgement, which is the whole design.
- **Endpoints:** `POST /audiences/suggest-from-segment` (returns `candidates[]` —
  every explored round, in round order, each persisted), `GET /audiences/{id}`,
  `POST /audiences/{id}/dry-run`. A serve-next-by-audience-id endpoint is a
  later wave (designed with human-service) — do NOT build it here yet.
- **Env vars (NEW consumer of chat-service):** `CHAT_SERVICE_URL` +
  `CHAT_SERVICE_API_KEY` (shared fleet values) are required by the audience
  endpoints. They are read lazily inside the handler, so their absence does NOT
  break boot or any existing endpoint — only `/audiences/suggest-from-segment`
  would 500 until they are set.

## `POST /enrich` works OUTSIDE a campaign (x-campaign-id optional there only)

A reveal can precede any campaign: signed-out onboarding reveals a few preview
people to prove they are reachable (consumer: human-service). So `/enrich`
requires only `x-run-id` + `x-brand-id`; without `x-campaign-id` it is the SAME
billed reveal (authorize, `apollo-credit`, BounceVerify, 12-month cache keyed on
the person, so a later campaign serve never pays twice), metered on the caller's
org/brand/run/audience. The enrichment row and child runs hold `campaign_id`
NULL (migration `0028` dropped NOT NULL). Nothing is invented in its place, so
it never enters a campaign's attribution or stats. `/search/next` and `/match`
still require a campaign (the cursor is campaign-keyed).

## Audience preview (`GET /audiences/:id/preview`) is FREE and READ-ONLY

A sample of who is in a persisted audience, for showing a signed-out prospect
real output (consumer: human-service). `src/lib/audience-preview.ts`. ONE Apollo
people-search teaser call (page 1, per_page 100; zero credits, measured
2026-09-28 via `credit_usage_stats` before/after 3 calls) → up to 10 distinct
employers (name only) + up to 20 people (first name, obfuscated last name,
title, employer, and `apolloPersonId`), round-robin across the listed employers.
`apolloPersonId` is the teaser's own Apollo id, the handle `POST /enrich`
accepts, so a consumer can reveal + verify a sampled person's email through the
normal billed path; the preview call itself still spends nothing. No cursor, no row
written, no count refresh, no cost declared. Company descriptors are omitted on
purpose: `mixed_companies/search` moved `lead_credit` by 1 per page, and would
ignore the audience's person filters anyway. Do not add them without a billed
path. Page 1 (not random pages) so repeat calls are stable.

## Audience companies (`GET /audiences/:id/companies`) — 100 companies, 1 credit each, cached

Up to 100 distinct companies where people OF THE AUDIENCE work, with firmographics
and the one person to write to (consumer: human-service → signed-out onboarding).
`src/lib/audience-companies.ts`; chunked by `offset`/`limit` (default 25, total
capped at 100), `x-run-id` required. Every step measured on prod 2026-09-29 via
`POST usage_stats/credit_usage_stats` before/after, zero baseline drift:

- **Employers: FREE.** The audience's own people teaser (so person filters hold),
  page 1, pages 2..5 in parallel only if page 1 lacks employers. First-ranked
  person per employer = the person. The teaser carries NO organization id.
- **Organization id: FREE.** `POST organizations/search` +
  `display_mode:"fuzzy_select_mode"` (Apollo's free Lookup): 0 credits over 101
  calls. The SAME body on `mixed_companies/search` costs 1 credit per call — do
  not swap paths. Only an EXACT (case/space-insensitive) name match resolves;
  several exact matches are settled by a free people search scoped to each
  candidate id (first holding an audience person wins); else id null and every
  firmographic null. Never a fuzzy guess.
- **Firmographics: 1 `apollo-credit` per company** (`GET organizations/{id}`).
  Rejected: `mixed_companies/search` with 100 `organization_ids` is 1 credit per
  REQUEST but returns no industry/headcount/location/description;
  `organizations/bulk_enrich` is also 1 per company. So 100 companies ≤ 100
  credits (11.8¢ each at org price ≈ $11.80). Global cache `apollo_organizations`
  (no org_id — firmographics are facts; not in transfer-brand) for 90 days: a
  cached company is never paid again, whoever asks.
- **Metering**: child run `audience-companies` of `x-run-id`, PROVISION the
  uncached count → AUTHORIZE (platform key; 402 + hold released if short) →
  EXECUTE → ACTUALIZE what Apollo returned → cancel the hold. A fetched record is
  cached even if a sibling fetch fails (the retry pays only for the rest). An
  advisory lock per audience stops two concurrent chunks paying twice.
- Never an email, a phone (not even the switchboard) or a filter object. The
  preview route is untouched.

## Buying signals are an AUDIENCE CRITERION (hiring / job_change / funding)

An audience can be ICP + one buying signal + a recency window. Not a new
channel or campaign type: the audience is served, revealed and costed like any
other. `src/lib/buying-signal-spec.ts` (pure) + `src/lib/buying-signals.ts`.

- **All three are native Apollo People Search filters, measured honored live
  2026-09-29** (free teaser counts, baseline CEO+US 356,526): hiring =
  `organization_job_posted_at_range` (+ `q_organization_job_titles`), job_change
  = `person_days_in_current_title_range`, funding = `latest_funding_date_range`.
  Impossible bounds return 0 and max bounds are honored. treg was not needed.
- **Filters carry a RELATIVE `buying_signal` {type, window_days, job_titles?}**,
  distribute-owned and kept OUT of `ApolloNativeSearchFiltersSchema` (the refine
  loop and `/search/filters-prompt` never offer it). `toApolloSearchParams(sp, now)`
  turns it into Apollo's date filters for the current window; it throws (400) if
  the ICP already sets the Apollo field the signal drives, never a silent override.
- **Rolling cohorts, no new state beyond the cursor table.** human-service
  forwards stored filters verbatim to `/search/next`, so `resolveSignalCohort`
  pins them to a day (`as_of`): first serve = whole window; an open cohort keeps
  being walked; one walked out on an earlier day opens a new cohort covering only
  signals `since` that day; walked out today = `done` until tomorrow. human-service
  persists `reachableCount` on exhaustion but asks again next serve, so the
  audience keeps filling.
- **Evidence travels with the lead: `/enrich` returns `buyingSignal`
  {type, occurredOn, fact, source, sourceUrl} | null.** Only for a person a signal
  cohort served to this org (`apollo_signal_serves`, gold, org data, in
  transfer-brand). funding + job_change are read FREE from the enrichment Apollo
  already returned (funding_events, current employment start_date); hiring buys
  the employer's job postings: `GET organizations/{id}/job_postings`, **1 lead
  credit per call that returns postings, 0 for an empty list** (measured, 3 rounds,
  zero drift), cached per company `JOB_POSTINGS_CACHE_DAYS` (7) in bronze
  `apollo_job_postings_fetches`, provision → authorize → execute → actualize on a
  `buying-signal-evidence` child run, 402 when the org cannot pay. Every dated fact
  lands in silver `buying_signals` (global). No dated evidence in the window =
  null, never invented. job_change allows 31 days of slack for Apollo's
  month-precision start dates.
- **Endpoints:** `POST /audiences/signal-coverage` (free people AND distinct
  companies per signal x window for an ICP, the "is it worth it" check; read
  companies, not people: "recently funded" crypto market makers were 217 people
  at 2 firms) and `POST /audiences/signal`
  (persist ICP + signal, return the size estimate). The consumer registers the
  returned `apolloAudienceId` + `filters` with human-service `POST /orgs/audiences`
  (send the filters too, or serve 422s).

## Fourth buying signal: `linkedin_engagement` (competitor post engagers) — NOT an Apollo search

`buying_signal: {type: "linkedin_engagement", window_days, competitor_pages: [1-3 LinkedIn company page URLs]}`.
People who reacted to / commented on a competitor page's posts published in the
window. `src/lib/linkedin-engagement-spec.ts` (pure) + `src/lib/linkedin-engagement.ts`.

- **Served on `/search/next`, never on Apollo.** Up to 5 teasers per call, id
  `li:<profileId>`, `source:"linkedin_engagement"`, name/title/headline/employer
  from the RESOLVED profile. Never twice per audience: `linkedin_engagement_serves`
  unique (org, audience_key, profile), claimed BEFORE any spend on the person
  (audience_key = `audience:<x-audience-id>`, else `campaign:<id>`). `done` only
  once silver is current and nobody is left. `toApolloSearchParams` throws
  `SignalNotApolloSearchableError` (400) for it: no dry-run/preview/count. Apollo
  filters beside it are a named 400 (cannot be enforced on LinkedIn people).
- **Wire facts (live 2026-10-03):** company posts = ~10 latest, no paging, DATE
  APPROXIMATE (relative age); Fetchin engagement = 100 reactions + 100 comments per
  call, a reaction has NO date (evidence dates it by the post, says "around"); a
  reactor's URL is the opaque `in/ACoAA…` form NO email finder resolves, and the
  headline missed lemlist staff. So every candidate's profile is resolved
  (`treg.linkedin.user.profile`, ~$0.0015, cached 30 days, misses free): public
  slug, CURRENT employer slug (employee filter), company website (find domain).
- **Company posts come from a PROVIDER CHAIN, never one routed id (2026-10-04).**
  treg withdrew `treg.linkedin.company.posts` at 00:33 UTC (`404 "no tool … in this
  org"`) and every serve failed for 5h while its children kept working. Now
  `POSTS_PROVIDERS` (`src/lib/linkedin-company-posts.ts`) calls the children
  directly: scrapecreators ($0.00188) → tikhub ($0.001/success, exact dates) →
  harvestapi ($0.004). Withdrawn tool / 429 / 5xx / timeout / "page not found"
  → next provider (coverage differs: scrapecreators did not know
  oxblue-corporation, tikhub had 50 posts); dead = EVERY provider said not found.
  A dead page (`linkedin_company_pages.posts_status = not_found`, re-checked after
  24h) is SKIPPED with a loud log + warn trace, the other pages served; every page
  dead = 422 `competitor_pages_unreadable` (all providers down = 502, retryable).
  No provider resolves `showcase/eimmigration` (all three probed).
- **`/enrich li:<id>`** = treg find on public URL + names + company domain, then the
  verifier (same as `qe:`), plus `buyingSignal` with an additive `engagement` block
  (page, post, reaction/comment, dates). 404 if never served to this org.
- **Speed (2026-10-03, one serve took 90s then >300s):** profile lookups send
  `X-Treg-Route-Exclude: anyapi` (anyapi missed 62/62 and cost 8-10s per lookup;
  fetchinio answers in ~2s, same price); one `/search/next` claims up to 20
  engagers, resolves them 5 at a time (10 drew fetchinio 429s) and returns EVERY
  prospect (human-service buffers the page); harvest reads 3 posts at once.
- **A TRANSIENT lookup failure defers that one engager, never the page**: timeout
  (30s), network, 429/5xx, or a `route_failed` where any child `outcome:"error"`
  (a rate-limited fetchinio is NOT "nobody has this"). Its claim is released,
  nothing is cached, a later serve retries it. Only a page that serves nobody
  BECAUSE of transient failures throws. A non-transient failure fails the call
  and releases every claim not handed back. Migration 0034 released the 7
  engagers the first version wrongly stored as unreadable.
- **Money:** every treg call = PROVISION ceiling → AUTHORIZE → call → `actual`
  = `X-Treg-Cost-Micro` → cancel hold, cost name `treg-micro-usd`, child run
  `linkedin-engagement`, org-billed. Silver global: posts re-listed / engagement
  re-read at most once a day per page/post, whoever pays.
- **A treg routed 502 `route_failed` where children MISSED (nothing charged) is a
  not_found**, not a failure (`isTregRoutedMiss`, also used by the email find).
- Consumers (human-service, lead-service) enumerate signal types strictly: no
  audience may carry this kind until they accept it.

## Phone reveal is OPT-IN, ASYNCHRONOUS, and lives on its own route

Apollo does not return phone numbers by default and never has — that is why
`apollo_people_enrichments` held 63,907 rows with zero phones: the reveal was
never requested. A reveal is opt-in on Apollo's side (`reveal_phone_number`),
billed separately (~8 credits when a mobile comes back, ZERO when nothing is
found), and the number is delivered ASYNCHRONOUSLY to a `webhook_url` Apollo
then requires — minutes later, not in the response.

- **Its own route, so nobody reveals by accident.** `POST
  /people/{apolloPersonId}/phone-reveal` (request) + `GET` the same path (read)
  + `POST /webhook/phone-reveal?secret=` (Apollo's delivery). `/enrich`,
  `/match` and `/search/next` are untouched and send no `reveal_phone_number`
  key at all — `phone-optin.regression.test.ts` asserts the key is ABSENT from
  their request bodies, not merely false. Do NOT fold the reveal into
  enrichment "for convenience": that would put reveal credits on every existing
  caller.
- **`status` is the contract, not the phone column.** `pending` (Apollo has not
  delivered yet) / `found` / `not_found` (Apollo has no number — a REAL answer,
  zero credits) / `failed` (the reveal itself failed). A null number cannot
  express those four, which is the whole reason `apollo_phone_reveals` exists.
  The consumer (instantly-service, on a qualified sales reply) polls the GET for
  a bounded ~90s and proceeds either way, so the three non-`found` states must
  stay distinguishable. Never collapse them.
- **Plus 1 credit for the PERSON RECORD, on every reveal (measured 2026-09-26).**
  The `people/match` call that asks for the phone returns the person, and
  Apollo bills that record like any enrichment: one reveal moved the account's
  lead counter by 9 while the callback reported `credits_consumed: 8`. The route
  declares the 1 as `actual` right after the call (`isBilledApolloPerson`) and
  authorizes 9. Phone credits come out of the SAME lead pool — Apollo's
  `direct_dial_credit` counter read 7,500/7,500 used and did not block anything.
- **Cost: `apollo-credit`, quantity 8 — quantity is the lever, the name is
  reused.** PROVISION 8 as a hold + AUTHORIZE (platform key only) BEFORE the
  call; the callback ACTUALIZES it when a number arrives and CANCELS it when
  none does, so a fruitless reveal costs the org nothing. Apollo's own
  `credits_consumed` wins when it differs from 8 (post the truth, cancel the
  hold — runs PATCH is status-only).
- **The callback answers 200 for anything parseable.** Apollo counts a 4xx like
  a 5xx and disables a webhook that keeps failing, which would lose every future
  reveal (the same mechanism that took instantly-service's webhook down twice).
  The ONE 5xx case is a cost reconciliation we could not complete: the phone is
  already committed by then, `costReconciledAt` is still null, and the
  redelivery re-runs only the reconcile.
- **The callback's field names are `_cd`-SUFFIXED — read both spellings.**
  Verified live 2026-09-05: the async delivery sends `type_cd: "mobile"`,
  `status_cd: "valid_number"`, `dnc_status_cd: null`, `confidence_cd: "high"`,
  while the synchronous enrichment shape uses the unsuffixed names. Reading only
  `dnc_status` makes every number report as clear to dial — the exact failure
  this feature exists to prevent. `normalizePhoneNumbers` accepts both;
  `phone-reveal.test.ts` pins Apollo's real production payload.
- **DNC survives to the consumer.** Every number carries Apollo's `dnc_status`
  verbatim plus a derived `doNotCall`. An UNKNOWN dnc value is treated as
  do-not-call — announcing a clean number as DNC is recoverable, dialling a
  flagged one is not.
- **A number is never fabricated, guessed or pattern-matched.** Only what Apollo
  sent: `phone_numbers[]` plus the `mobile_phone` scalar when it sends one.
  Empty means `not_found`.
- **Env vars:** `APOLLO_SERVICE_PUBLIC_URL` (already set) +
  `APOLLO_PHONE_REVEAL_WEBHOOK_SECRET`. Without both, `buildPhoneRevealWebhookUrl`
  returns undefined and the route fails loud BEFORE spending a credit — a reveal
  with nowhere to land is a credit thrown away.

## Every revealed email carries a VERIFIER VERDICT (`emailVerification`)

Getting a correct address is this service's job (owner, 2026-09-25), so the
pre-serve verification moved here from human-service. `/enrich`, `/match` and
`/email-finder/find` (found rows) all return, additive beside `person`:
`emailVerification: { email, verdict, deliverable, verifier, verificationId, verifiedAt, reused } | null`.

- **`deliverable` is THE switch — true only for verdict `valid`.** catch_all,
  invalid, risky, unknown are NOT deliverable. Measured on 100 bounced + 100
  delivered prod addresses: valid 3/36, catch_all 41/46, unknown 32/15,
  invalid 24/3. The PERSON still comes back when not deliverable, so a
  consumer can suppress them (the reveal credit is spent; never re-reveal).
- **Verifier: BounceVerify Apify actor** (`bounceverify~bounceverify-email-verifier`,
  run-sync, ~3s), key-service `apify` key, cost `apify-bounceverify-email`,
  billed only on a DECISIVE verdict (`unknown` is free). Provision → authorize
  → execute → actualize, hold cancelled — `src/lib/email-verification.ts`.
- **Bronze = `email_verifications`**, one row per call, actor row verbatim,
  failures included. A decisive verdict under `VERDICT_REUSE_DAYS` (30) is
  REUSED (`reused: true`, nothing billed) — cache hits reuse it too.
- **Fail loud: 502 `{type:"email_verification"}`.** Never an unverified email
  labelled deliverable. The reveal / finding is already stored, so a retry is
  a cache hit that re-runs only the verification.
- **Addresses a caller already HOLDS: `POST /email-verifications`** (2026-09-28,
  first caller transactional-email-service's paced mailing-list release). 1-50
  addresses, 10 verified at once, each through `verifyRevealedEmail` — same
  bronze, 30-day reuse, child run of `x-run-id`, cost authorized against the
  CALLER's org. ALL OR NOTHING: one address that cannot be verified 502s the
  whole call, so a caller never holds a partial answer to send half of. Bronze
  `source` = `verify:<caller label>`.
- **Apify out of usage raises the SAME staff email as Apollo** (`provider: "apify"`)
  and the 502 carries `providerError` (provider `apify`). Apify answers 403
  `platform-feature-disabled` "Monthly usage hard limit exceeded" (or 402):
  2026-09-29 it lasted 20 hours, 4,801 verifications failed and nobody was told.
  `looksLikeApifyCreditExhaustion` stays narrow (an outage 502 is not
  exhaustion). Dedup is transactional-email-service's, per org per day per
  EVENT TYPE, so an Apollo alert the same day for the same org hides the Apify one.
- **A runs-service stall is retried, not surfaced (2026-10-01).** After the
  Apify cap (09-29 13:00 → 09-30 08:50) the residual 502s were runs-service
  10s timeouts while its pool saturated under box load. `runsRequest` retries
  timeout / network / 5xx / 429 (`RUNS_RETRY_DELAYS_MS` 500ms, 2s); safe
  because `createRun` and every `addCosts` item carry a generated
  `idempotencyKey` (runs-service replays the original row) and PATCH is
  absolute. A 4xx is never retried. Apify's own gateway 502/503/504 is retried
  once (`APIFY_GATEWAY_RETRY_DELAY_MS`).
- Callers of `/match` today: human-service AND journalists-service — both now
  receive the verdict and its cost. Do not make it opt-in per caller; the
  owner's rule is that no revealed email leaves unverified.

## Reveal domain gate — no Apollo credit on a domain that cannot verify `valid`

`POST /enrich` (Apollo path, cache miss) judges the employer's MAIL DOMAIN
before authorizing or calling Apollo (`src/lib/reveal-domain-gate.ts`).
catch_all and checker-refused (`unknown`) are DOMAIN facts: on prod
2026-09-25..29, a domain already holding a catch_all verdict gave 132 more
catch_alls and 0 valids; one holding an unknown gave 121 unknowns and 0 valids.
Prices are re-derived daily by costs-service (2026-10-07: reveal 5.6¢, BounceVerify check 3.2¢, 0 on unknown); a probe is paid once per domain fleet-wide, a wasted reveal once per person.

- **Employer**: the free teaser only carries `organization.name`, so
  `/search/next` upserts it into `apollo_teaser_people` (global, no org).
  Migration 0030 backfilled 14 days of `apollo_people_searches`.
- **Domains**: Apollo's FREE org lookup (`organizations/search`), exact name to
  org ids, then `candidateMailDomains` (below). ⚠️ That lookup is capped at
  **400 calls/hour** on the platform key, shared by the gate and the teaser
  employer domains: never replay the gate over history with live lookups (a
  1,245-row replay hit the cap on 2026-10-07); stand in the reveal's own
  `organization_id` instead. **Serves have priority** (`org-lookup-budget.ts`):
  the teaser fill is `background` (≤250/h, no 429 retry, paused 10 min after an
  hourly 429, page stops at first refusal); the gate memoizes a name 6h and a
  rate-limited lookup REVEALS (basis `org_lookup_rate_limited`), never 500s;
  an HOURLY 429 (any Apollo endpoint) is never retried, only per-minute ones
  (2026-10-08: a resumed campaign's teaser burst 500'd two paid /enrich serves).
- **Judge** (`judgeDomain`, fleet-wide `email_verifications`, any org/source):
  latest decisive verdict within 30d decides (catch_all = bad, else ok) unless
  2+ unknowns within 7d came AFTER it (= bad); no decisive one + an unknown
  within 7d = bad (`checker_blocked_domain`, TRANSIENT, re-probed after);
  nothing = PROBE one random `zz-probe-…@domain` address through
  `verifyRevealedEmail` (source `reveal-domain-probe`, cost
  `apify-bounceverify-email`, normal protocol). A PROBE answering `valid` = the
  domain accepted a mailbox nobody owns = catch_all.
- **Mail domains judged = `candidateMailDomains`**: reveals we hold are the
  evidence. Several exact org ids (homonyms) → only the ids we already revealed
  people at, when any (every "Jump Trading" reveal sat on one of its two ids;
  the other is jumpcrypto.com). Per org with reveals → its revealed email domains
  carrying ≥10% of them (website dropped); without reveals → its website. Skip
  only if all bad; `organizationId` = ids comma-joined.
- **Skip only when EVERY domain is bad**; no employer / no exact org / no domain
  → reveal as before (benefit of the doubt). A probe failure 502s like any
  verification failure, never a silent pass.
- **Where the waste was (prod 2026-10-02..07, 625 paid gate-passes):** ambiguous
  name 344 wasted of 407 (Jump Trading alone 370 `unknown` reveals: Proofpoint
  554s our checker, one fluke `valid` kept it "ok" 30 days), domain-judged 120 of
  731 (mostly person-level `invalid`). First-seen domains on the judged path were
  NOT the bulk. The 2,305 `no_employer` reveals of 2026-10-01 were a
  transactional-email-service mailing-list release whose people never came
  through `/search/next` (no teaser employer).
- **A skip**: `person: null`, `emailVerification: null`, additive
  `revealSkipped {skipId, reason, evidence[]}`, a `reveal_skips` row (moved by
  transfer-brand), an `enrich-skipped` trace. No apollo-credit authorized or spent.
  human-service already treats `person: null` as a no-email reveal.
- The DELIVERABLE policy is unchanged: only `valid` is served.

## Employer domain on free teasers (`/search/next` → `organizationDomain`)

So a caller (lead-service via human-service) can qualify a person's COMPANY
before buying the reveal. The free teaser masks the domain; `/search/next` now
fills the person's EXISTING `organizationDomain` field (human-service reads it
verbatim as `organization.domain`, zero consumer change).
`src/lib/teaser-employer-domains.ts`.

- **Same rule as the reveal gate** (they share `exactOrganizationIds`): Apollo's
  FREE name lookup (`organizations/search` fuzzy_select_mode, 0 credits) must
  return EXACTLY ONE organization id whose name equals the employer name
  (case/space-insensitive), with a domain (`domain`, else `website_url` host).
  No match / several / no domain ⟹ field absent, never guessed. Apollo's own
  `primary_domain`, when a teaser carries one, wins and is never looked up.
- **Cache**: `apollo_employer_domains` (migration `0038`, global, no org_id, not
  in transfer-brand), keyed on the normalized name, EVERY outcome cached 30 days.
  A failed lookup (Apollo error / rate limit) is not cached and leaves the field
  absent; it never fails the search.
- **Latency**: misses looked up 8 at a time under a 4s budget per page; lookups
  still running after the budget keep filling the cache for the next page.
- **Scope**: the Apollo walk only. QuickEnrich pages already carry the domain;
  linkedin_engagement pages are untouched. `/enrich` (billing, response) unchanged.

## Company firmographics by domain (`POST /internal/company-firmographics`) — ORG-LESS, platform-billed

"Who is the company behind this website, and what does this person do there?"
for a caller with NO org (distribute.you's per-visit Telegram recap, a platform
job). `x-api-key` = `APOLLO_SERVICE_API_KEY`, no identity headers.
`src/lib/company-firmographics.ts`. Body `{domain, email?, firstName?, lastName?}`.

- **Spend measured 2026-10-04** (`credit_usage_stats` before/after):
  `GET organizations/enrich?domain=` = 1 lead credit when found, 0 when Apollo
  answers `{}`; `people/match` by email = 1 for a real match, 0 for an unknown
  address (Apollo returns a synthetic person with `match_confidence: "none"` and
  no title — that is "not matched", never a role). Category = one Jev `choice`
  on chat-service `/internal/platform-judgments` (chat-service declares it);
  below 0.5 confidence it is reported null.
- **Org-less protocol** (no org balance, so no authorize/hold): platform run
  opened BEFORE the Apollo call (runs-service down = 502, nothing spent),
  `apollo-credit` posted as `actual` on `/v1/platform-runs/{id}/costs`, run
  closed. The cache row is committed FIRST with `cost_declared_at` null; a
  failed declaration 502s and the next call declares it under the SAME
  idempotency key, never paying Apollo twice. Platform Apollo key via key-service
  `GET /keys/platform/apollo/decrypt`.
- **Cache** global (`company_domain_lookups`, `person_role_lookups`, no org_id,
  not in transfer-brand): 90 days found / 30 days not found. Free-mail domains
  (`PERSONAL_EMAIL_DOMAINS`) answer `company:null, noCompanyReason:
  "personal_email_domain"` with no call at all.
- Every field nullable; ranges are buckets (`revenueRange`, `employeeRange`),
  country is ISO-2 from Apollo's English name (CLDR reverse map + aliases).

## Person identity by email (`POST /internal/person-identity`) — ORG-LESS, platform-billed

`{email}` → `{email, matched, matchConfidence, linkedinUrl, apolloPersonId, name, cached}`.
Apollo `people/match` by EMAIL only (never a name: two people share one). Same
cache row (`person_role_lookups`, key `email:<lower>`), spend protocol and
`apollo-credit` declaration as the firmographics person leg, so neither pays
twice. A free-mail domain is not sent to Apollo as `domain`. `matchConfidence`
is Apollo's verbatim; the caller judges (client-service accepts only `high`).

## Other email finders: treg.to and Explee (bronze / silver / exact cost)

apollo-service holds our enrichment PROVIDERS, not only Apollo. `POST
/email-finder/find` asks **treg.to** (routed hub, ~20 underlying providers) or
**Explee** (preset `basic` 1.5 credits / `premium` 5 credits) for one person's
work email. Vendor I/O lives in `src/lib/email-finders.ts`; the route owns
identity, idempotency, persistence and cost.

- **Bronze = `email_finder_calls`**: every HTTP exchange verbatim (request body,
  status, ALL response headers, parsed body), append-only, including failed
  calls. treg's charge lives in a HEADER, so headers are bronze, not metadata.
- **Silver = `email_findings`**: one row per (vendor, preset, person), UNIQUE.
  `status` pending/found/not_found/failed, `email`, `vendorMailboxStatus`
  (verbatim) + `mailboxStatus` (valid/catch_all/invalid/unverified/unknown),
  `underlyingProvider`, `chargedQuantity` in the vendor's unit.
- **Never pays twice.** found / not_found / pending rows are served back with
  `reused: true` and no vendor call. Only `failed` (a vendor error, which neither
  vendor bills) is retried. treg also gets `Idempotency-Key: apollo-email-find:<findingId>`
  so a lost answer replays free.
- **Cost = the vendor's own figure, never ours.** treg: `X-Treg-Cost-Micro`
  header (integer micro-USD) → `treg-micro-usd` quantity. Explee:
  `meta.credits_charged` → `explee-credit` quantity. Provision the worst case
  (treg `TREG_MAX_COST_MICRO`; Explee the preset's credits), post the reported
  figure as `actual`, cancel the hold. A miss reports 0 → hold cancelled.
- **treg: $0.01 ceiling per find, cheapest first, work-email partners only
  (2026-09-28; $0.006 on 09-26..28, $0.01 before).** `TREG_MAX_COST_MICRO =
  10_000` is sent as `X-Treg-Route-Max-Cost: 0.010000`; every child priced above
  it is `skipped`, never called, and when EVERY candidate for the identity we
  sent is above it treg answers **402 `route_max_cost`** (nothing charged).
  treg walks its plan cheapest per hit — no order header, the ceiling is the
  only price lever. **The ceiling must admit the cheapest NAME+DOMAIN child**,
  since most finds carry no LinkedIn URL: on 2026-09-28 treg dropped trykitt
  ($0.005), tomba ($0.0089) became the cheapest name+domain child, and the
  $0.006 ceiling 402'd 265 of 268 finds. $0.01 admits tomba and nothing dearer
  (next: dropleads $0.018), so a runaway price stops at a 402. The 402 body
  carries treg's whole `plan[]` with prices — read it before moving the ceiling.
  tomba's personal inboxes are caught by `rejectNonWorkEmail`. `X-Treg-Route-Exclude:
  leadmagic` drops the personal-email finder's PROVIDER (an endpoint id there is
  silently ignored).
- **The treg silver preset NAMES THE ROUTING POLICY** (`TREG_PRESET` =
  `routed-max-10000`; `routed-max-6000` / `routed` = older ceilings). A miss
  under one plan is not a miss under another, so changing the ceiling is a NEW
  question: one more lookup per person, old rows kept as history. Every treg call sends
  `Cache-Control: no-cache` — our silver row is the cache, and the only re-ask
  is a policy change, where treg's archived answer would be the old policy's.
- **Bronze records the REQUEST headers** (`email_finder_calls.request_headers`,
  token/api-key redacted). The "leadsforge charged 2.45c despite the $0.01
  cap" of 2026-09-25 was two calls served by the PRE-ceiling container (12:20:19
  and :27, new container created 12:20:21); ~290 post-swap calls never exceeded
  the dearest child under the cap. Without the sent headers that took a
  deploy-log join to prove — now it is one column.
- **A personal address is never `found`.** tomba (a WORK finder, $0.0089)
  returned 8 aol/gmail/hotmail inboxes in the first benchmark, so the price
  ceiling alone is not enough. `rejectNonWorkEmail` turns a consumer-mailbox
  hit (`PERSONAL_EMAIL_DOMAINS`, unless it IS the person's company domain) or
  any hit from a `*personal*` child into `not_found`, keeping the address in
  `rejectedEmail` + `rejectionReason: "personal_email"`. The charge stands and
  is declared exactly. Applied to Explee too. Migration 0025 corrected the 16
  personal rows found before the guard.
- **A treg 402 is not stored against the Idempotency-Key** (verified live): a
  row that failed on `insufficient_balance` retries LIVE on a plain re-request.
  A 200 IS replayed under the same key even when headers changed — which is
  what a lost-answer retry needs.
- **Keep the hold when the vendor may have billed**: a network error / lost
  answer, a found email with no readable charge, and a treg **202** (async child
  still running, `charged_micro: null` — treg says do NOT retry). Those rows say
  `holdKept: true` / `status: pending`; reconcile them from bronze.
- **Once the vendor ANSWERED, a later failure never loses or doubles its
  charge.** Before the `actual` lands (runs-service timed out on it — seen 3
  times in 300 on 2026-09-26), the hold is KEPT and the row is `failed`; the
  retry replays treg free and declares the charge once. After the `actual`
  lands (a later `updateRun` fails), the row is stored SETTLED, so no retry
  calls the vendor or declares again.
- **Missing platform key = 503 `provider_key_missing`** naming the key-service
  provider (`treg` / `treg-org` / `explee`), before any row, hold or vendor call.
  treg's token is an IDENTITY (team-scoped) token: every call also sends
  `X-Treg-Org` = key-service provider `treg-org` (`distribute-you`).
- **treg's mailbox word rides in `raw`, not `output`.** Live 2026-09-25: a hit
  with `output.verified: false` carried `raw.status: "catch_all"`.
  `tregVendorMailboxStatus` prefers a word that names a mailbox state over the bool.
- Do NOT touch the Apollo reveal path from here; this is additive.

## QuickEnrich serve path — free candidates, treg find, per audience, OFF by default

`apollo_audiences.serve_source` = `apollo` (default) | `quickenrich`, set by
`PATCH /audiences/{id}/serve-source` (422 + every reason when the filters are
not expressible). human-service is untouched: it forwards an audience's stored
filters verbatim as `/search/next` searchParams, so the switch is found by
`filters = searchParams::jsonb` within the org (`findQuickenrichAudience`).

- **Flow.** `/search/next` on a switched audience walks QuickEnrich
  (`quickenrich.people.search` via treg, free) on its own cursor columns of
  the same `apollo_search_cursors` row, post-filters, returns people with id
  `qe:<emp_id>` + `source:"quickenrich"`, `done:false`. When QuickEnrich runs
  dry the unchanged Apollo walk takes over. `/enrich` with a `qe:` id reads the
  identity from silver `quickenrich_people`, runs `executeEmailFind` (the SAME
  treg protocol as `/email-finder/find`, `src/lib/email-find-run.ts`), then the
  verdict. not_found / treg 202 → person with null email (consumer records the
  serve, never pays twice).
- **Dedup before spend is human-service's existing pre-pay check**: its
  suppression + opt-outs match `linkedin_url_norm` / provider person id on the
  teaser. QuickEnrich rows carry the LinkedIn URL, re-written in APOLLO's form
  (`http://www.linkedin.com/in/<slug>`, non-ASCII percent-encoded — 406 of
  43,139 served rows are) so a person served via Apollo and found here is one
  key. A row with no LinkedIn / full name / domain is never served. Silver
  `email_findings` (personKey = linkedin) makes a repeat find free.
- **Faithfulness (`planQuickenrich`, `rowMatchesPlan`)**: served only when
  EVERY constraint is enforceable; stricter than Apollo is fine, looser never.
  Enforceable: `person_titles` (server substring + whole-word post-filter,
  exact when `include_similar_titles:false`), `person_not_titles`,
  `person_locations` (server `locality` substring + structural post-filter; a
  US state matches the region only), headcount/revenue only when the Apollo
  span lines up with QuickEnrich's bands (±1 employee). NOT enforceable →
  audience stays on Apollo: keyword tags, seniorities, industries,
  organization locations, technologies, q_keywords, everything else.
- **QuickEnrich's `city`/`region_code`/`country_code` are the COMPANY's
  address** (Salesforce rows read San Francisco, some `country_code:"UK"`);
  the PERSON's location is `locality` ("Austin, Texas, United States", often
  "N/A"). Never use the company address for person_locations.
- **Free, asserted.** Bronze `quickenrich_searches` keeps every call; a
  non-zero or missing `X-Treg-Cost-Micro` throws (no cost name exists for it).
  Costs declared are the treg find (`treg-micro-usd`) + verification only.
- **Pool is the `has_email:true` subset** (measured 2026-09-26: South
  chiropractors 236, US dentists 3,435), so QuickEnrich supplements and Apollo
  still carries volume. Dropping `has_email` quadruples the pool but lowers the
  treg hit rate — an owner decision, not a default.
- **Fields lost vs an Apollo reveal:** seniority, headline, photo, timezone,
  employment history, departments/functions, org id / description / keywords /
  technologies / funding / founded year / website, numeric headcount and
  revenue (bands only: `organizationAnnualRevenuePrinted`). All null, never
  invented.

## treg-FIRST on the reveal path does NOT work — the teaser has nothing to look up

Measured 2026-09-26, so nobody re-plans it: the free People Search teaser a
lead is served from carries `id, first_name, last_name_obfuscated ("Wi***s"),
title, organization.name` and `has_*` booleans — NO LinkedIn URL, NO last
name, NO domain. treg (`treg.people.email.find`) needs `linkedin_url` or full
name + domain, and has no route by first name + company + title. The identity
is only obtainable from Apollo itself, and Apollo bills **1 credit for
demographics even when no email is revealed** (docs: "1 credit for
demographics or email"), so buying the LinkedIn URL costs exactly the reveal.
The 2026-09-25 benchmark's LinkedIn URLs came from people ALREADY revealed.
And treg as a FALLBACK after the reveal adds nothing measurable: on the 125
benchmark people whose Apollo address had a BounceVerify verdict, treg returned
the SAME address 124 times (0 of 73 catch_all/unknown/invalid rescued). The one
open path — resolving a LinkedIn URL from name + last-name mask + company +
title via a paid people search — risks emailing the wrong human and needs an
owner decision; do not build it by default.

## Platform reveals fall back to Apollo THROUGH treg when our credits are out

`/enrich` and `/match` (`people/match`) on the PLATFORM key: on
`ApolloCreditsExhaustedError` the same match is answered by treg's
`apollo.people.enrich` (Apollo's own params in the query string, verbatim Apollo
response, ~$0.026/success), then every platform reveal goes to treg directly
for 1h before our key is retried, so it ends by itself at renewal
(`src/lib/apollo-reveal-route.ts`). Cost declared = treg's `X-Treg-Cost-Micro`
as `treg-micro-usd`, never an `apollo-credit`. BYOK keys are never rerouted.
Not covered (still fail while out): phone reveal, firmographics, job postings,
audience companies. 2026-10-09: credits ran out 3 days before the Oct 12 cycle.

## Running out of Apollo credits raises a STAFF EMAIL — never let it stay silent

Apollo signals credit exhaustion two ways, and BOTH used to be silent here: a
200 response whose `email` is the `email_not_unlocked@domain.com` sentinel (an
email exists but the plan/credits cannot reveal it) and an outright 402/403.
The sentinel is the nastier one — `withVerifiedEmailOnly` nulls it, so downstream
a dry provider is byte-identical to "this person has no verified email", i.e. the
service keeps running and quietly serves nothing. Both signals now raise a staff
alert from `src/lib/credit-alert.ts`, detected at the single chokepoint every
Apollo HTTP call goes through (`src/lib/apollo-client.ts`).

- **transactional-email-service owns the send** (`POST /platform-send`): it holds
  the hardcoded internal staff recipient list, the template, the send's run/cost,
  AND the rate bound. apollo-service declares NO cost for it — same relationship
  as with chat-service for LLM spend. The payload is the PRODUCER's contract, not
  ours: `eventType: "provider_credits_exhausted"`, `metadata.provider` +
  `metadata.reason` REQUIRED non-empty (400 otherwise), `metadata.detail` the
  optional free-form room for the raw upstream status/body — and those three are
  exactly what its staff template renders, so anything else we invent is stored
  and never displayed. `metadata.orgId` is filled in from `x-org-id`; do not send
  it. `recipientEmail`/`bccEmails` are rejected outright (staff-only delivery).
  Re-read its deployed OpenAPI before changing any of this.
- **Zero throttle state on this side, by design.** The alert is deduped per org
  per calendar day inside transactional-email-service, so a run that hits the
  wall on thousands of consecutive people cannot mail-bomb. Do NOT add a local
  counter, cooldown or table — that would duplicate a bound the producer owns.
- **Org-billed, identity reused.** The alert carries the identity of the inbound
  request that hit the wall (`toCreditAlertIdentity(req)`), so the staff email
  names the affected org. An identity-less caller logs a warning and sends
  nothing (the staff path is org-scoped).
- **Detached on purpose.** `reportApolloCreditsExhausted` is fire-and-forget with
  a logged `.catch` — an alert that fails to send must not turn a customer's
  enrichment into a 500. The Apollo error it accompanies is still thrown. This is
  the auto-triggered-side-effect exception to fail-loud, not a swallowed error on
  the request path.
- **Status is NOT the trigger — the BODY is.** What Apollo actually returns when
  the plan's lead credits hit zero is a plain **422** whose body reads
  `{"error":"You have insufficient credits! … Upgrade your plan … lead credits."}`.
  422 is also what an ordinary API error returns (a malformed range filter, a
  cursor paging past the 50k cap — issue #131), so neither "402/403 only" nor
  "422 means exhausted" works. `looksLikeApolloCreditExhaustion(status, body)` in
  `src/lib/apollo-client.ts` alerts when the status is 402/403 (credit-related
  by definition) OR the body matches a narrow out-of-credits pattern (every
  pattern requires the word "credit"/"credits"). Keep the patterns narrow — a
  detector that fires on ordinary errors trains staff to ignore the alert.
  (Cost: the 2026-07-28 and 2026-08-22 exhaustions were both fleet-wide, lasted
  days, and raised nothing — the status-only detector could not see the one
  signal Apollo sends.)
- **A 429 is a RATE LIMIT, not exhaustion — unless its body says credits.**
  Apollo answers 429 when we exceed its per-minute API quota
  (`USAGE.RATE_LIMIT.API_RATE_LIMIT_EXCEEDED`, 200/min on
  `mixed_people/api_search`). Counting every 429 as exhaustion mailed staff
  "apollo is out of credits" on a busy minute and marked the failure
  `retryable: false` for callers (2026-09-28). `sendApolloRequest` (the single
  exit every Apollo call goes through) now RETRIES a rate-limit 429 up to 3 times
  (2s/5s/10s, or `Retry-After` capped at 10s — `/match` holds an advisory lock
  around the call), raises no alert, and throws a plain error if it still fails.
  A 429 whose body matches the credit patterns stays exhaustion, unretried.
- **Env vars:** `TRANSACTIONAL_EMAIL_SERVICE_URL` +
  `TRANSACTIONAL_EMAIL_SERVICE_API_KEY` (shared fleet values), read lazily inside
  the alert call — their absence cannot break boot or any endpoint, it only makes
  the alert fail and log.
- **Reactive, not predictive.** This fires when the wall is hit, not before. A
  "only N credits left" warning would need a daily cron against Apollo's usage
  API; this service has no cron infrastructure today.

## Provider exhaustion is stated to CALLERS too — `providerError` on the error body

The staff email above is only half the answer. Callers used to receive credit
exhaustion as a generic upstream failure — byte-identical to a transient blip —
so every consumer had to GUESS, which is what produced 621 identical retries and
a customer who was told nothing (2026-08-22; same shape 2026-07-28). The
contract that fixes it lives in `src/lib/provider-error.ts`:

- **Additive, never breaking.** HTTP status and the existing `type` / `error`
  fields are UNCHANGED. A caller that ignores the signal sees byte-identical
  behaviour — that is the whole reason the signal is a new FIELD and not a new
  status code. Do NOT "upgrade" it to a 503 later; four downstream services key
  on the field.
- **Present exactly when true.** `ApolloCreditsExhaustedError` is thrown by the
  Apollo chokepoint (`apolloRequestFailure` in `src/lib/apollo-client.ts`) only
  when `looksLikeApolloCreditExhaustion` says so, and routes spread
  `providerErrorFields(error)` into the 500 body. Every ordinary/transient
  failure carries NO `providerError` key at all, so the two are never conflated
  and nobody has to count failures to infer the state:

  ```json
  { "type": "internal", "error": "Apollo search failed: 422 - …",
    "providerError": { "provider": "apollo", "code": "provider_credits_exhausted",
                       "retryable": false, "message": "…" } }
  ```

- **`code` is the switch; `message` is prose.** `provider_credits_exhausted`
  reuses the vocabulary of the staff alert's `eventType` (#211) — one word for
  one state across the fleet. Never make a consumer regex `message`; that is how
  the alert itself broke (#216).
- **This service states, it does not decide.** No retry limiter, circuit breaker
  or backoff belongs here — stopping the campaign, backing off and telling the
  customer are the callers' jobs (chain tracked in campaign-service#397).
- **Not covered: the 200-with-sentinel case.** The
  `email_not_unlocked@domain.com` placeholder still raises the staff alert and
  still returns 200 with a null email (making it throw would be breaking). Only
  a REJECTED Apollo response carries `providerError`.

## Every provisioned hold is in `cost_holds`, and a reconciler settles the ones nobody closed

A hold (`status:"provisioned"`) counts against the customer's balance until it
becomes `actual` or `cancelled`. Every route closes its own holds; what a route
cannot close is its own death (crash, deploy swap mid-call, a failed cleanup
call). runs-service has no cross-org list of open holds, so this service keeps
one: `runs-client` writes a `cost_holds` row for every provisioned cost it
creates (a failed ledger write releases the hold at once and fails the call) and
marks it settled on every `updateCostStatus`. No call site can forget.

- **`src/lib/hold-reconciler.ts`**, in-process every 10 min after `listen`
  (holds older than 1h; phone reveals after 24h), mutex inside the function.
  Per hold, from evidence, never blanket: already closed in runs-service →
  recorded; the run already carries the real charge (same cost name, `actual`)
  → cancel; verify-email with a billed bronze verdict → actual; email-find with
  a vendor-reported charge in `email_finder_calls` → that charge as actual, hold
  cancelled; phone reveal → Apollo's `creditsConsumed`, or cancel if it never
  delivered; anything else → cancel (benefit of the doubt to the customer).
  A run still `running` is then closed: completed if charged, failed otherwise.
- **`POST /internal/cost-holds/reconcile`** `{dryRun, olderThanMinutes?, limit?}`
  (x-api-key = `APOLLO_SERVICE_API_KEY`) runs one pass by hand; `dryRun` writes
  nothing and returns every decision with its reason.
- `/match`, `/enrich`, `/search/next` fail the run they opened on any error
  (`failOpenRun`), so an error no longer leaves a run `running` forever.
- History (2026-09-29): 198 apollo holds had sat provisioned since May, $102 on
  one customer. 179 were 20-credit waterfall holds the timeout path left for a
  webhook that never came; disabling the waterfall (2026-05-28) also commented
  out the only code that ever closed them. None had an email or a callback, so
  all were cancelled. The rest were treg / BounceVerify holds orphaned by the
  2026-09-25 container swaps.

## Brand transfer (`POST /internal/transfer-brand`) moves EVERY table, in one transaction

Fleet contract (brand-service fans it out): `{sourceBrandId, sourceOrgId,
targetOrgId, targetBrandId?}`, `x-api-key` = `APOLLO_SERVICE_API_KEY` (fails
closed). `TABLE_MOVES` in `src/routes/transfer-brand.ts` lists all nine tables
holding org data; **a NEW table carrying `org_id` must be added there** and to
`tests/integration/transfer-brand.db.test.ts` (real Postgres, one case per
table; run it with `TRANSFER_BRAND_TEST_DATABASE_URL` on a throwaway DB).

- Direct: searches / enrichments / cursors / phone reveals / findings
  (`brand_ids = [brand]`), audiences (`brand_id`). Co-branded rows stay.
- Tied: brandless reveals/findings by the brand's CAMPAIGNS; finder calls by
  finding; verifications by (org, run, email) of a brand enrichment/finding;
  QuickEnrich searches by cursor / audience / campaign. Tied tables move FIRST
  (the tie is read from parents still under the source org).
- Not moved, by design: `quickenrich_people` (global, no org), audiences and
  findings written with no brand and no campaign (nothing ties them).
- History only: no cost is declared or reversed.

## Commands

- `pnpm test` — run all tests (Vitest)
- `pnpm test:unit` — run unit tests only
- `pnpm test:integration` — run integration tests only
- `pnpm test:watch` — run tests in watch mode
- `pnpm run build` — compile TypeScript + generate OpenAPI spec
- `pnpm run dev` — local dev server (tsx watch)
- `pnpm run generate:openapi` — regenerate openapi.json from Zod schemas
- `pnpm run start` — start production server
- `pnpm run db:generate` — generate Drizzle migrations
- `pnpm run db:migrate` — run Drizzle migrations
- `pnpm run db:push` — push schema directly (dev only)

## Migrations are HAND-AUTHORED (journal + .sql), NOT `drizzle-kit generate`

`drizzle-kit generate` is interactive (a TUI create/rename prompt that can't be
fed from a pipe) AND this repo's `drizzle/meta` snapshots are STALE — only
`0000`–`0007` exist, so generate diffs against a pre-`0008` baseline and offers
bogus "rename from orgs/users" options. Don't fight it. To add a migration:
1. Edit `src/db/schema.ts`.
2. Hand-write `drizzle/NNNN_<name>.sql` (use `CREATE TABLE IF NOT EXISTS` /
   `CREATE INDEX IF NOT EXISTS` so boot is idempotent; `--> statement-breakpoint`
   between statements — mirror an existing migration like `0019`/`0020`).
3. Append an entry to `drizzle/meta/_journal.json` (`idx`+1, same `version`,
   `when` greater than the previous, `tag` = the filename without `.sql`).
Boot `migrate()` reads ONLY the `.sql` files + `_journal.json` (never the
snapshots), so a missing snapshot does not affect boot. Do NOT write to the
journal/sql via a hooked shell redirect (`>`) — use the editor or `python3`
direct file write (RTK truncation gotcha).

## Verified-email is the standard for EVERY Apollo people operation

This service only ever contacts people with an Apollo SMTP-**verified** email
(non-verified results are dropped at enrichment via `withVerifiedEmailOnly`). So
"verified-email only" is the STANDARD for every people-search it performs — the
count/dry-run, the serve/`search/next` pagination, AND the audience refine/creation
sizing loop. `searchPeople` (`src/lib/apollo-client.ts`) FORCES
`contact_email_status:["verified"]` on the request body of EVERY people-search,
overriding any caller-supplied value (`VERIFIED_EMAIL_STATUS`). Do NOT bypass this
by calling Apollo people-search outside `searchPeople`.

- **Apollo People Search HONORS this filter — it is NOT phantom.** Verified live
  2026-07-21 on `mixed_people/api_search`: `Chiropractor + United States` = 16,220
  total → 4,068 with `["verified"]` (~25% verified-reachable). An earlier note here
  called it a phantom pre-filter; that was wrong — the count really drops. So a fresh
  count/dry-run on an existing audience filter returns the verified-reachable number,
  not the demographic total (which fixes the inflated "remaining to contact").
- **Apollo BILLS every person it returns — email or not (measured 2026-09-26).**
  1 lead credit per `people/match` that returns a person: 5 `unavailable`
  (no email) reveals moved the account counter by 5, 2 `extrapolated` by 2, with
  no other traffic in the window. The old belief ("billed only for verified
  emails") under-recorded ~0.9% of real spend. `isBilledApolloPerson` is the
  charge gate in `/enrich` and `/match`; the `email_not_unlocked` placeholder
  (no credit left) is the one unbilled case. A PAID no-email answer is cached
  `BILLED_NO_EMAIL_CACHE_DAYS` (30) instead of 24h — re-asking paid again (249
  repeat reveals in 90 days). An unmatched person (no record) stays at 24h.
  Reconcile any future doubt the same way: Apollo's `credit_usage_stats` before
  and after N controlled calls, minus our own rows in the window.
- **The refine loop has NO band to calibrate — `AMBITION_MIN` is GONE (2026-07-28).**
  It used to be recalibrated 20,000 → 7,000 when the dry-runs became verified-only
  (counts are ~1/3 of the demographic total). That whole axis was deleted: the model
  reads the count and the sample and decides for itself, and nothing in code compares a
  count to a threshold. So the verified-only change now affects only what a count MEANS
  (the contactable pool), not any accept/reject decision. Do NOT re-derive a band from
  the verified scale.

## Apollo pagination hard cap (DO NOT remove the cursor clamp)

Apollo People Search serves at most **50,000 records** via pagination
(100/page × 500 pages). Requesting a page beyond that window returns
`422 "Page * per page number is over threshold."`, NOT an empty page. The
`/search/next` cursor MUST clamp `totalPages` to `min(ceil(total/per_page), 500)`
(`APOLLO_MAX_SEARCH_RESULTS` in `src/routes/search.ts`) so a >50k search exhausts
cleanly. The 500-page cap is Apollo's documented ceiling — it is NOT an artificial
limit to be removed (a prior "no artificial cap" test made that mistake and caused
prod 422→500s, #129).

## `/search/next` cursor is keyed PER FILTER SET, never by campaign alone

The `apollo_search_cursors` row is keyed by **(org_id, campaign_id, params_hash)**
— `params_hash` is a DB-GENERATED column (`md5(search_params::text)`) so it always
matches Postgres' canonical jsonb serialization (key-order-insensitive,
array-order-sensitive). The unique index is `idx_cursors_org_campaign_params`. This
means each distinct filter set a campaign uses gets its OWN cursor and deep-walks
its own pool independently; re-passing the SAME filters resumes from the stored
page (jsonb-equality lookup in `findCursorForParams`); a different filter set gets a
NEW cursor instead of evicting the others. **DO NOT revert to a campaign-only
unique constraint** (`idx_cursors_org_campaign`): before this fix one campaign that
emitted multiple filter sets thrashed a single cursor back to page 1 on every param
change, so it never read past page ~7 and campaigns auto-stopped on a FALSE "no more
leads" with most of the pool unfetched. The route NEVER resets a cursor to page 1
on a param change — that reset branch was deleted. New cursor inserts use
`onConflictDoNothing()` + re-select to resolve the concurrent same-params race.

The response carries `done` (true ONLY when all pages of THIS filter set are
walked = true pool exhaustion), plus `page` / `totalPages` / `hasMore` so the caller
distinguishes exhaustion from a low-yield page (a page with few/no servable people
is NOT exhaustion — keep pulling while `hasMore=true`). Every people-search now
FORCES `contact_email_status:["verified"]` (see "Verified-email is the standard"
below), so the pool served is already the verified-reachable subset and per-page
email-yield is high. The DEEPER root cause of multiple filter sets per campaign is a
caller (workflow) regenerating filters per run — fixed long-term by the stable
audience path (human-service `serve-next` + `apollo_audiences`), not here.

## Apollo range filters are `{min,max}` objects, NOT strings

Apollo people-search **range** params are JSON objects `{ min, max }` with
**integer** bounds — `revenue_range`, `organization_founded_year_range`,
`organization_headcount_growth_range`, `person_total_yoe_range`,
`organization_num_jobs_range`, `person_days_in_current_title_range`,
`organization_job_posted_at_range`. Sending a range as a string (or array of
`"min,max"` strings) makes Apollo's Ruby do `range["min"]` on a String/Array →
`422 "no implicit conversion of String into Integer"`, surfacing as a 500 from
`/search/dry-run` and a 502 at human-service `/orgs/audiences/suggest`. Our
public filter contract keeps `revenueRange` as the documented `string[]`
(`"min,max"`); `toApolloRevenueRange` in `src/lib/transform.ts` is what collapses
it to the `{min,max}` object Apollo requires (multiple ranges union into one
span; open-ended bounds omit that key). Any NEW Apollo range filter added to
`SearchFiltersSchema` MUST map to `{min,max}` integers in `toApolloSearchParams`,
never a passthrough string/array. The **count/enumerable** list params
(`organization_num_employees_ranges`) genuinely ARE arrays of `"min,max"`
strings — only the `*_range` object params need the conversion (#133, v0.22.1).

## People Search honors UNDOCUMENTED org-funding filters (verified live — DO NOT delete on a doc re-sync)

We hit **People Search only** (`mixed_people/api_search` via `searchPeople`) — the
refine loop AND every dry-run go through it. We never call Company/Organization
Search. Apollo's *published* People Search parameter list does NOT include the
org-funding filters below (they are documented only for **Organization Search**),
but the People Search engine **honors them anyway**. Verified live **2026-06-25**
via the FREE dry-run (`per_page=1`, zero credits); baseline `CEO + United States`
= 521,871 matches:

- `total_funding_range {min,max}` int USD — honored (min=100M → 10,258).
- `latest_funding_amount_range {min,max}` int USD — honored (min=50M → 8,642).
- `latest_funding_date_range {min,max}` ISO date — honored (2024+ → 25,022).
- `organization_latest_funding_stage_cd` `string[]` — honored, but **only Apollo
  NUMERIC stage codes filter**. Label strings (`"Series A"`) are silently treated
  as "has any funding stage" → all labels return the same 11,736 (no real
  discrimination). Code map **CERTIFIED** (each label read back via Organization
  Enrichment 2026-06-25 — e.g. `2`→portalvagas.com=Series A, `5`→hackerrank.com=
  Series D, `8`→anthropic.com=Series G):
  `1`=Angel, `2`=Series A, `3`=Series B, `4`=Series C, `5`=Series D, `6`=Series E,
  `7`=Series F, `8`=Series G, `9`=Series H, `10`=Venture (Round not Specified),
  `11`=Private Equity, `12`=Other, `13`=Debt Financing, `14`=Equity Crowdfunding,
  `15`=Convertible Note.
  **`0`=Seed exists in Apollo but People Search does NOT filter on code `0`** (it
  returns the "has any stage" fallback, 11,736), so Seed is **not addressable**
  via People Search — codes `1`–`15` are the usable set.

**Apollo silently DROPS unknown params** — a nonsense param returns the baseline
count unchanged (no 422). So a wrong field name is a **dead filter, not an
error**. Never trust that a new People-Search filter works because it compiles;
confirm it with a free dry-run **count delta** first.

**Filter-discovery methodology (3-way count classification).** To probe whether a
candidate undocumented filter/value is honored, hit `mixed_people/api_search` with
`per_page=1` (free, reads `pagination.total_entries`) against a fixed baseline and
read the delta — there are THREE outcomes, not two:
- `count == baseline` → the **param NAME is dead** (Apollo dropped the whole key;
  wrong field name). E.g. `not_organization_keyword_tags`, `person_departments`,
  `organization_headcount_growth_range`.
- `count == 0` → the **param is honored but the VALUE/slug is unknown** (Apollo
  applied the filter, matched nothing). E.g. `person_functions=["healthcare"]` (0)
  while `["engineering"]` works → "healthcare" is the wrong slug, not a dead param.
- `count > 0 && != baseline` → **honored** ✅, publish it.
Endpoint is `mixed_people/api_search` (the old `mixed_people/search` 422s as
deprecated); auth header `x-api-key`. RTK truncates `curl` JSON — probe with
Python `urllib` (see `/tmp/apollo_probe*.py` pattern from the 2026-06-25 sweep).
Publish only `>0`-confirmed slugs in enums; never list a guessed slug.

**Keywords crush volume — a verified FACT about the Apollo engine, NOT a rule for the
refine prompt.** Verified: `q_keywords="SaaS"` → 86 vs
`q_organization_keyword_tags=["software"]` → 128,274 (1,490×), same intent. This lives in
`APOLLO_UNDOCUMENTED_FILTERS_ENCART` (and thus in `/search/filters-prompt`) as observed
engine behaviour that any caller LLM should know. It is NOT a prescription in the
refine-loop system prompt: the "prefer keyword-tags over `q_keywords`" / "never add a
redundant keyword" rules were REMOVED 2026-07-28 (they helped the model justify dropping a
stated sector — see the refine-objective section). `q_keywords` + technology UIDs are
always available; the model picks its own mechanism, judged against the count and the
sample its choice actually returns. There is no relaxation ORDER anymore — the loop
explores alternative encodings of the same target, it does not shed constraints in a
ranked sequence.

**Verified 2026-06-25 — undocumented TARGETING filters People Search also honors
(same baseline `CEO + United States` = 521,875).** The headline is the
volume-friendly industry/vertical filter that replaces the volume-killing
free-text `q_keywords` (verified: `q_keywords="SaaS"` → **86** vs
`q_organization_keyword_tags=["software"]` → **128,274**):

- `q_organization_keyword_tags` `string[]` — employer keyword/industry tags by
  NAME (fintech → 2,137,121). **Prefer this for a sector/vertical** — `q_keywords`
  and technology UIDs stay available but are the harshest volume reducers, so use
  them consciously (knowing they slash the count), not reflexively.
- `q_not_organization_keyword_tags` `string[]` — EXCLUDE those tags (the plain
  `not_organization_keyword_tags` spelling is DEAD; use the `q_`-prefixed form).
- `included_organization_keyword_fields` `string[]` — which employer fields the
  keyword tags match. Honored: `tags | name | social_media_description`
  (`seo_description` is silently ignored). Omit to default to ~`tags`.
- `organization_trading_status` `string[]` — only `private` / `public` filter
  (delisted/acquired/ipo/subsidiary/otc silently dropped).
- `person_functions` `string[]` — lowercase_underscore. Honored: accounting,
  administrative, arts_and_design, business_development, consulting, data_science,
  education, engineering, entrepreneurship, finance, human_resources,
  information_technology, legal, marketing, operations, product_management, sales,
  support. An unknown slug returns **0 matches** (not a 422).
- `person_department_or_subdepartments` `string[]` — department (`master_*`) or
  subdepartment (leaf) slug. Honored `master_*`: master_engineering_technical,
  master_information_technology, master_finance, master_sales, master_operations,
  master_marketing, master_human_resources, master_legal. Leaf slugs (e.g.
  `sales`, `information_technology`) also work; unknown slug → 0.
- `q_person_name` `string` — free-text on the person's full name.
- `person_not_titles` `string[]` — EXCLUDE these current titles.

These are intentionally **beyond the official doc**. The durable copy of these
rules (for caller LLMs + the refine loop) lives in
`APOLLO_UNDOCUMENTED_FILTERS_ENCART` (`src/lib/filters-prompt.ts`), appended to
both `/search/filters-prompt` and the audience-refine system prompt. If you ever
"re-sync `SearchFiltersSchema` to the official Apollo doc", **keep these fields +
the encart** — they are not in the doc by design, but they work.

## U+0000 in provider data is stripped at the DRIVER, never per field

Postgres rejects NUL in text (`invalid byte sequence 0x00`) and in json/jsonb
(`22P05 \u0000 cannot be converted to text`). One LinkedIn profile (treg body)
with a NUL in a position description 500'd every `/search/next` of its audience
(2026-10-04; #353 stripped that path, which also cleans the served engagers). `src/lib/nul-strip.ts` wraps the postgres.js serializers for
text/varchar/bpchar/json/jsonb once in `getSql()`, so every write (drizzle or raw
`sql`) is clean; the `json replacer` in `src/index.ts` strips served strings too.
Do not add more per-path sanitizers or catch-and-skip 22P05. Accessor properties keep
the wrap alive when a later `drizzle()` re-assigns the json serializers.

## Architecture

- `src/schemas.ts` — Zod schemas + OpenAPI registry (source of truth for validation + OpenAPI)
- `src/routes/search.ts` — Search and enrichment endpoints (POST /search, GET /searches/:runId, GET /enrichments/:runId, POST /stats)
- `src/routes/validate.ts` — Batch validation endpoint (POST /validate)
- `src/routes/reference.ts` — Reference data endpoints (GET /reference/industries, GET /reference/employee-ranges)
- `src/routes/health.ts` — Health check endpoints
- `src/middleware/auth.ts` — Clerk org-id authentication middleware
- `src/lib/apollo-client.ts` — Apollo.io API client
- `src/lib/keys-client.ts` — BYOK key retrieval via key-service
- `src/lib/runs-client.ts` — Runs-service client for cost tracking
- `src/lib/reference-cache.ts` — 24h in-memory cache for reference data
- `src/lib/validators.ts` — Shared validation utilities
- `src/db/schema.ts` — Drizzle ORM database schema
- `src/db/index.ts` — Database connection setup
- `src/config.ts` — Environment config
- `tests/` — Test files (`*.test.ts`)
- `openapi.json` — Auto-generated from Zod schemas, do NOT edit manually

## Waterfall enrichment — canonical pattern

> **DISABLED 2026-05-28** — Apollo waterfall vendor email quality was unreliable.
> Direct Apollo `/people/match` only (1 credit per email). Revive checklist
> in `src/lib/waterfall.ts` header. The pattern below is preserved for that
> revive; current code paths bypass it entirely.

Apollo's waterfall (third-party email lookup vendors) is async on Apollo's side but **synchronous from the caller's perspective in this service**. Both `/match` and `/enrich` MUST follow this pattern when the immediate Apollo response has no email and `waterfall.status === "accepted"`:

1. **Authorize** `WATERFALL_MAX_CREDITS` upfront (platform key only). Cost can be up to 20 credits, not 1.
2. **Provision** a cost line `qty: WATERFALL_MAX_CREDITS, status: "provisioned"` on the enrichment run, store the cost id in `apolloPeopleEnrichments.provisionedCostId`.
3. **Insert** the enrichment row with `waterfallStatus: "pending"`, `waterfallRequestId`, `provisionedCostId`.
4. **Poll** the row synchronously (default 60s, 3s interval) until `email` is set, `waterfallStatus` becomes `completed`/`failed`, or timeout.
5. **Resolve**:
   - Email found in poll → cancel provisioned (webhook will add actual). Return person.
   - Webhook said no email → cancel provisioned. Return null person.
   - Timeout → mark `waterfallStatus: "timeout"`, run `failed`, leave provisioned cost in place (webhook reconciles when it eventually arrives — Apollo retries 5xx). Return 504.
6. **Webhook** (`POST /webhook/waterfall`) is the source of truth for actual cost: cancels the provisioned cost and adds `creditsConsumed` as actual on the original enrichment run. Idempotent on `waterfallStatus IN ('pending','timeout')`.
7. **Lazy cleanup on cache lookup**: if a cached row is `pending` and older than 24h (webhook never arrived), cancel provisioned + add `WATERFALL_MAX_CREDITS` actual + mark `expired`.

Negative cache (24h TTL) prevents duplicate Apollo calls for the same person/name+domain that just failed waterfall.

Do not ship an async/fire-and-forget variant of this — the caller (lead-service workflows) expects a single synchronous response with email present or definitively absent.
