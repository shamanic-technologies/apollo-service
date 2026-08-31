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
- **The refine loop is a strong model, a plain goal, a real budget, and its own
  final answer. It is deliberately UNDER-instructed — do not add rules to it.**
  The model gets three things: the audience description, the Apollo filter catalog
  (`buildFiltersPrompt`), and the goal — find the filter set that best answers this
  description. Each proposal is dry-run and the result comes back to it. Up to
  **10** attempts (`MAX_REAL_ATTEMPTS`), plus a SEPARATE `MAX_INVALID_RETRIES` (3)
  budget for malformed output, which must never eat a real attempt.
  - **The set the model returns with `action:"final"` IS the result.** No code
    re-ranks, scores, filters or arbitrates. If the budget runs out before it
    answers, its most recent proposal stands — that is still its own latest
    answer, not a selection. There is no `pickBest`, no max-count rule, no
    minimum-encodings gate, no premature-confirm rejection.
  - **Each dry-run returns a COUNT and a SAMPLE of who matched** (`dryRunSample`):
    ~20 people drawn from up to 2 RANDOM pages (`SAMPLE_PAGES` × `SAMPLE_PER_PAGE`,
    clamped to Apollo's 500-page cap), each rendered as company — title — city,
    country. Random pages, never the head: Apollo RANKS results, so page 1 is
    biased in the direction that hides the bug (a set leaking into Romandie shows
    clean German-Swiss shops on page 1 while Geneva sits on page 40). The sample
    is what REPLACES the deleted rules — the model sees Procter & Gamble and Rolex
    in a "drugstores" audience and draws its own conclusion, and sees a sample thin
    out when it invented a headcount clamp. Do NOT re-add the rules alongside it.
  - **ONE closing question, and it decides NOTHING.** `matchesRequest` on the
    `final` turn ("does this set match what was asked?") populates the response's
    `degraded` flag. It is read AFTER the set is chosen; an omitted answer, or an
    exhausted budget, is also `degraded: true`. It must never influence selection —
    that non-influence is the entire point (the model both issuing a verdict and
    benefiting from it is what produced #225/#230). `degraded` stays on the
    response: human-service reads it and the dashboard renders it.
  - **Degrade, never throw, except for real errors.** chat-service or Apollo
    unreachable, missing config, and a chosen set that matches NOBODY (`count === 0`)
    still throw. Everything else returns a usable set with the flag.
  - **A degraded or failed run logs its FULL trace** (`logRefineTrace`): every
    attempt's filters, count, sample and reasoning, in one structured `console.warn`.
    Nothing on the happy path. Without it, an over-strict judgement is
    indistinguishable from a broken call and the only option is a revert (#227).
  - **The loop runs on `provider:"google", model:"pro"`, schemaless JSON, reasoning ON.**
    `anthropic`/`opus` was the target and its JSON shape IS solved — chat-service REJECTS
    Anthropic JSON mode without a `responseSchema` (`400 "Anthropic JSON mode requires
    responseSchema"`; the OpenAPI text implying plain `responseFormat:"json"` suffices is
    wrong for that provider), and an Anthropic schema must be STRICT (every property in
    `required`, `additionalProperties:false`), which cannot describe the SPARSE filter
    object the model emits — so the filter set is sent as a JSON STRING, which a strict
    schema describes exactly. What blocks opus is not the shape but the platform Anthropic
    account: it is usage-capped (`"You have reached your specified API usage limits"`, prod
    2026-08-31), so every refine call 500s. Flipping back is one provider/model pair plus
    the strict `responseSchema` — `chatComplete` already forwards `responseSchema`, and the
    decision guard already accepts `filters` as an object OR a JSON string. Do NOT set
    `disableThinking` or a thinkingLevel floor: judgement is the whole job here.
  - **DO NOT re-add:** the MECE vocabulary and its restated invariant, the
    "maximize volume among the MECE sets" objective, the `reachesOffTarget` /
    `leavesTargetUnreached` self-grading fields, `pickBest`, `MIN_ENCODINGS_BEFORE_CONFIRM`,
    the 0-count "never drop the concept" rule, the "never invent a firmographic
    constraint" rule, the frozen-count "wrong lever" rule, or any floor, ambition,
    target band or scoring function. Every one of them was added after a specific
    incident, and the pile is what made the results a lottery: the same request
    produced 2,640 (correct, 19 German-speaking cantons), 161 (an invented headcount
    clamp) and 1,222 (geography collapsed to bare `Switzerland`) in one day. If a
    fix adds an instruction to this prompt, it is the wrong fix — the model has the
    count, the sample and its own judgement, which is the whole design.
- **Endpoints:** `POST /audiences/suggest-from-segment`, `GET /audiences/{id}`,
  `POST /audiences/{id}/dry-run`. A serve-next-by-audience-id endpoint is a
  later wave (designed with human-service) — do NOT build it here yet.
- **Env vars (NEW consumer of chat-service):** `CHAT_SERVICE_URL` +
  `CHAT_SERVICE_API_KEY` (shared fleet values) are required by the audience
  endpoints. They are read lazily inside the handler, so their absence does NOT
  break boot or any existing endpoint — only `/audiences/suggest-from-segment`
  would 500 until they are set.

## Running out of Apollo credits raises a STAFF EMAIL — never let it stay silent

Apollo signals credit exhaustion two ways, and BOTH used to be silent here: a
200 response whose `email` is the `email_not_unlocked@domain.com` sentinel (an
email exists but the plan/credits cannot reveal it) and an outright 402/403/429.
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
  cursor paging past the 50k cap — issue #131), so neither "402/403/429 only" nor
  "422 means exhausted" works. `looksLikeApolloCreditExhaustion(status, body)` in
  `src/lib/apollo-client.ts` alerts when the status is 402/403/429 (credit-related
  by definition) OR the body matches a narrow out-of-credits pattern (every
  pattern requires the word "credit"/"credits"). Keep the patterns narrow — a
  detector that fires on ordinary errors trains staff to ignore the alert.
  (Cost: the 2026-07-28 and 2026-08-22 exhaustions were both fleet-wide, lasted
  days, and raised nothing — the status-only detector could not see the one
  signal Apollo sends.)
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
