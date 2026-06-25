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
  dry-run (per_page=1, zero credits) for live count feedback.
- **Endpoints:** `POST /audiences/suggest-from-segment`, `GET /audiences/{id}`,
  `POST /audiences/{id}/dry-run`. A serve-next-by-audience-id endpoint is a
  later wave (designed with human-service) — do NOT build it here yet.
- **Env vars (NEW consumer of chat-service):** `CHAT_SERVICE_URL` +
  `CHAT_SERVICE_API_KEY` (shared fleet values) are required by the audience
  endpoints. They are read lazily inside the handler, so their absence does NOT
  break boot or any existing endpoint — only `/audiences/suggest-from-segment`
  would 500 until they are set.

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

## Apollo pagination hard cap (DO NOT remove the cursor clamp)

Apollo People Search serves at most **50,000 records** via pagination
(100/page × 500 pages). Requesting a page beyond that window returns
`422 "Page * per page number is over threshold."`, NOT an empty page. The
`/search/next` cursor MUST clamp `totalPages` to `min(ceil(total/per_page), 500)`
(`APOLLO_MAX_SEARCH_RESULTS` in `src/routes/search.ts`) so a >50k search exhausts
cleanly. The 500-page cap is Apollo's documented ceiling — it is NOT an artificial
limit to be removed (a prior "no artificial cap" test made that mistake and caused
prod 422→500s, #129).

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

**Keywords are the harshest volume killer — express sector/vertical via keyword
tags, never `q_keywords`/technology UIDs.** Verified: `q_keywords="SaaS"` → 86 vs
`q_organization_keyword_tags=["software"]` → 128,274 (1,490×). The refine loop's
relaxation order must shed `q_keywords` + technology UIDs FIRST. This is why the
audience builder produced 14–67-match audiences before — it had no industry filter
and fell back to `q_keywords`.

**Verified 2026-06-25 — undocumented TARGETING filters People Search also honors
(same baseline `CEO + United States` = 521,875).** The headline is the
volume-friendly industry/vertical filter that replaces the volume-killing
free-text `q_keywords` (verified: `q_keywords="SaaS"` → **86** vs
`q_organization_keyword_tags=["software"]` → **128,274**):

- `q_organization_keyword_tags` `string[]` — employer keyword/industry tags by
  NAME (fintech → 2,137,121). **Always express a sector/vertical with this, never
  `q_keywords` or a technology UID** — those are the harshest volume reducers.
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
