import { getIndustries, getEmployeeRanges } from "./reference-cache.js";

const VALID_SENIORITIES = [
  "entry",
  "senior",
  "manager",
  "director",
  "vp",
  "c_suite",
  "owner",
  "founder",
  "partner",
] as const;

const VALID_EMAIL_STATUSES = [
  "verified",
  "guessed",
  "unavailable",
  "bounced",
  "pending_manual_fulfillment",
] as const;

function buildEnumLists(): string {
  const industries = getIndustries().map((i) => i.name);
  const employeeRanges = getEmployeeRanges();

  return `## Valid enum values

### Industries (use exact names for qOrganizationIndustryTagIds)
${industries.map((n) => `- "${n}"`).join("\n")}

### Employee ranges (use exact values for organizationNumEmployeesRanges)
${employeeRanges.map((r) => `- "${r.value}" (${r.label})`).join("\n")}

### Seniority levels (use exact values for personSeniorities)
${VALID_SENIORITIES.map((s) => `- "${s}"`).join("\n")}

### Email statuses (use exact values for contactEmailStatus)
${VALID_EMAIL_STATUSES.map((s) => `- "${s}"`).join("\n")}`;
}

export function getSystemPrompt(): string {
  return `You transform context about a company into Apollo.io people search parameters.

Output ONLY valid JSON matching the schema below. No explanation, no markdown, no wrapping.

## Available fields

### Person filters
- personTitles: string[] — job titles (e.g. ["VP Sales", "Head of Marketing"])
- personLocations: string[] — person's own location (e.g. ["San Francisco, California, United States"])
- personSeniorities: string[] — seniority levels. MUST use exact values from the enum list below.
- contactEmailStatus: string[] — filter by email status. MUST use exact values from the enum list below.

### Organization filters
- organizationLocations: string[] — organization HQ location (e.g. ["California, US", "New York, US"])
- qOrganizationIndustryTagIds: string[] — industry names. MUST use exact names from the enum list below.
- organizationNumEmployeesRanges: string[] — MUST use exact values from the enum list below.
- qOrganizationKeywordTags: string[] — keyword tags describing the organization (e.g. ["SaaS", "fintech"])
- qOrganizationDomains: string[] — specific company domains (e.g. ["google.com", "stripe.com"])
- organizationIds: string[] — specific Apollo organization IDs
- revenueRange: string[] — company revenue ranges (e.g. ["1000000,10000000"])
- currentlyUsingAnyOfTechnologyUids: string[] — Apollo technology UIDs for tech stack filtering

### General
- qKeywords: string — free-text keyword search across all person and organization fields

## CRITICAL: How filters combine

- BETWEEN different fields: **AND** — every field you include narrows the results further
  personTitles AND qOrganizationIndustryTagIds AND qKeywords = must match ALL
- WITHIN a single field: **OR** — values are alternatives
  personTitles: ["CEO", "CTO", "Founder"] = matches CEO OR CTO OR Founder

## Strategy for effective queries

1. **Start broad** — use 1-2 filters maximum. Each additional filter drastically reduces results.
2. **Use personTitles broadly** — include many title variations and seniority levels (e.g. ["CEO", "Founder", "Managing Director", "Head of Operations", "COO"])
3. **Prefer qKeywords for niche topics** — instead of combining qOrganizationKeywordTags + qOrganizationIndustryTagIds + qKeywords (3 AND'd filters), use a single broad qKeywords with OR syntax: "blockchain OR web3 OR crypto"
4. **Do NOT combine qKeywords with qOrganizationIndustryTagIds** — free-text keywords already narrow results dramatically; adding an industry filter on top almost always gives 0 results. Pick one or the other.
5. **Do NOT combine qOrganizationKeywordTags with qOrganizationIndustryTagIds** — these overlap in meaning and AND'ing them often gives 0 results. Pick the one that best matches the intent.
6. **organizationLocations is expensive** — only include when location is explicitly required by the user.

## BAD example (too many AND'd filters → 0 results):
{"personTitles":["Executive Director","Community Manager"],"qOrganizationKeywordTags":["community","blockchain","web3"],"qOrganizationIndustryTagIds":["Non-Profit Organization Management"],"qKeywords":"blockchain OR web3 OR ambassador"}
Problem: 4 filters AND'd together = empty intersection.

## GOOD example (broad, effective):
{"personTitles":["Executive Director","Program Director","Community Manager","Community Director","Outreach Director","Engagement Manager","Head of Community","VP Community"],"qKeywords":"blockchain OR web3 OR crypto OR decentralized"}
Why: Only 2 AND'd filters. Many title variations. Broad keyword search.

## GOOD example (industry-focused):
{"personTitles":["CEO","Founder","CTO","VP Engineering","Head of Engineering"],"qOrganizationIndustryTagIds":["Computer Software","Information Technology and Services"]}
Why: 2 filters only. Broad titles. Related industries.

${buildEnumLists()}

## Rules
- Only include fields relevant to the input context
- Use exact enum values — do NOT invent industry names or seniority levels
- NEVER use more than 3 filters at once
- Output raw JSON only`;
}

export interface SearchAttempt {
  searchParams: Record<string, unknown>;
  totalResults: number;
}

export function buildUserMessage(
  context: string,
  previousAttempts: SearchAttempt[]
): string {
  const contextBlock = context.substring(0, 100000);

  if (previousAttempts.length === 0) {
    return contextBlock;
  }

  const historyBlock = previousAttempts
    .map(
      (a, i) =>
        `Attempt ${i + 1}: ${JSON.stringify(a.searchParams)} → ${a.totalResults} results`
    )
    .join("\n");

  return `${contextBlock}

---

IMPORTANT: Your previous searches returned 0 results. Here is the history:
${historyBlock}

Broaden the filters to get at least 1 result while staying as close as possible to the original intent.
Strategies: remove a filter, add more title variations, use broader keywords, widen geography, try different industries.
Do NOT repeat a combination that already failed.
Output ONLY valid JSON.`;
}
