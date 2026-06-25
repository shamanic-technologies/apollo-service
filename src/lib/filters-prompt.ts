import { createHash } from "crypto";
import { z } from "zod";
import { getOpenApiMetadata } from "@asteasolutions/zod-to-openapi";

interface FieldShape {
  typeStr: "string" | "string[]" | "boolean" | "integer" | "object";
  enumValues: string[] | null;
}

function unwrapToInner(node: any): any {
  // Walk past optional / nullable / default until we hit the primary type node.
  let cur = node;
  while (cur?.def && (cur.def.type === "optional" || cur.def.type === "nullable" || cur.def.type === "default")) {
    cur = cur.def.innerType;
  }
  return cur;
}

function describeFieldShape(fieldName: string, node: any): FieldShape {
  const inner = unwrapToInner(node);
  const innerType = inner?.def?.type;

  if (innerType === "string") {
    return { typeStr: "string", enumValues: null };
  }

  if (innerType === "boolean") {
    return { typeStr: "boolean", enumValues: null };
  }

  // z.number() and z.number().int() — both render as a numeric scalar. The
  // example line carries the concrete shape, so we don't distinguish int/float.
  if (innerType === "number" || innerType === "int") {
    return { typeStr: "integer", enumValues: null };
  }

  // Range / record objects (e.g. {min,max}). The example shows the exact shape,
  // so we emit a generic "object" type and let the example + description carry
  // the structure — keeps one faithful vocabulary without per-field prompt code.
  if (innerType === "object" || innerType === "record") {
    return { typeStr: "object", enumValues: null };
  }

  if (innerType === "array") {
    const element = inner.def.element;
    const elementType = element?.def?.type;
    if (elementType === "enum") {
      const entries = element.def.entries as Record<string, string>;
      return { typeStr: "string[]", enumValues: Object.keys(entries) };
    }
    if (elementType === "string") {
      return { typeStr: "string[]", enumValues: null };
    }
    throw new Error(
      `[apollo-service] filters-prompt: field "${fieldName}" has unsupported array element type "${elementType}". Supported: string, enum.`
    );
  }

  if (innerType === "enum") {
    const entries = inner.def.entries as Record<string, string>;
    return { typeStr: "string", enumValues: Object.keys(entries) };
  }

  throw new Error(
    `[apollo-service] filters-prompt: field "${fieldName}" has unsupported type "${innerType}". Supported: string, string[], boolean, integer, object, enum, enum[].`
  );
}

function renderField(fieldName: string, node: any): string {
  const meta = getOpenApiMetadata(node);
  const description = meta?.description;
  const example = meta?.example;

  if (!description) {
    throw new Error(
      `[apollo-service] filters-prompt: field "${fieldName}" is missing .openapi({ description }). Add description to SearchFiltersSchema.`
    );
  }
  if (example === undefined || example === null) {
    throw new Error(
      `[apollo-service] filters-prompt: field "${fieldName}" is missing .openapi({ example }). Add example to SearchFiltersSchema.`
    );
  }

  const shape = describeFieldShape(fieldName, node);
  const lines: string[] = [];
  lines.push(`- ${fieldName}: ${shape.typeStr}`);
  if (shape.enumValues) {
    lines.push(`  enum: ${shape.enumValues.join(" | ")}`);
  }
  lines.push(`  ex: ${JSON.stringify(example)}`);
  lines.push(`  ${description}`);
  return lines.join("\n");
}

export function buildFiltersPrompt<T extends z.ZodObject<any>>(schema: T): string {
  const blocks: string[] = [];
  for (const [fieldName, node] of Object.entries(schema.shape)) {
    blocks.push(renderField(fieldName, node));
  }
  return blocks.join("\n");
}

export function computeFiltersPromptVersion(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex").slice(0, 12);
}

/**
 * UNDOCUMENTED-but-verified Apollo People-Search filter rules.
 *
 * These rules are NOT derivable from the Zod schema / official Apollo doc, so
 * they live here as a hardcoded block appended to every filters-prompt surface
 * (the /search/filters-prompt response AND the audience-refine LLM system
 * prompt). Keeping them in a dedicated constant — separate from the
 * auto-generated `buildFiltersPrompt` catalog — means a future "re-sync the
 * schema to the official Apollo doc" pass will NOT silently erase them.
 *
 * Verified live 2026-06-25 via the FREE Apollo dry-run (per_page=1, zero
 * credits). DO NOT delete on a doc re-sync — see CLAUDE.md.
 */
export const APOLLO_UNDOCUMENTED_FILTERS_ENCART = [
  "=== UNDOCUMENTED-BUT-VERIFIED APOLLO PEOPLE-SEARCH RULES (do NOT remove on a doc re-sync) ===",
  "Apollo's published People Search parameter list omits the org-funding filters",
  "below (they are documented only for Organization Search), but the People Search",
  "endpoint (mixed_people/api_search) DOES honor them. Verified live via the free",
  "dry-run, baseline `CEO + United States` = 521,871 matches:",
  "- total_funding_range {min,max} integer USD — honored (min=100M -> 10,258).",
  "- latest_funding_amount_range {min,max} integer USD — honored (min=50M -> 8,642).",
  "- latest_funding_date_range {min,max} ISO date — honored (2024+ -> 25,022).",
  "- organization_latest_funding_stage_cd string[] — honored, but ONLY Apollo NUMERIC",
  "  stage codes filter. Label strings (\"Series A\") are silently treated as \"has any",
  "  funding stage\" and do NOT discriminate. Code map (CERTIFIED via enrichment):",
  "    \"1\"=Angel  \"2\"=Series A  \"3\"=Series B  \"4\"=Series C  \"5\"=Series D",
  "    \"6\"=Series E  \"7\"=Series F  \"8\"=Series G  \"9\"=Series H",
  "    \"10\"=Venture (Round not Specified)  \"11\"=Private Equity  \"12\"=Other",
  "    \"13\"=Debt Financing  \"14\"=Equity Crowdfunding  \"15\"=Convertible Note",
  "  NOTE: Seed is code \"0\" in Apollo, but People Search does NOT filter on it",
  "  (code 0 returns the \"has any stage\" fallback) — Seed is NOT addressable here.",
  "",
  "--- VOLUME-FRIENDLY TARGETING FILTERS (verified honored, undocumented for People Search) ---",
  "KEYWORDS CRUSH VOLUME — use them CONSCIOUSLY. Free-text q_keywords and technology",
  "UIDs are the harshest volume reducers. Verified: q_keywords=\"SaaS\" -> 86 matches;",
  "the SAME intent via q_organization_keyword_tags=[\"software\"] -> 128,274 (~1,490x).",
  "q_keywords and technology UIDs stay FULLY AVAILABLE — use them when the request",
  "genuinely needs that precision, but KNOW they will slash the count, and prefer the",
  "keyword-tag / industry filter below to express a sector / vertical whenever volume",
  "matters. When a count is too low, RELAX q_keywords + technologies FIRST (they cost",
  "the most volume per constraint), before touching seniority / titles / industry.",
  "- q_organization_keyword_tags string[] — employer keyword/industry tags by NAME",
  "  (e.g. [\"software\"], [\"fintech\"], [\"financial services\"]). The volume-friendly way",
  "  to target a sector. Verified: fintech -> 2,137,121; financial services -> 84,018.",
  "- q_not_organization_keyword_tags string[] — EXCLUDE those tags (the plain",
  "  not_organization_keyword_tags spelling is DEAD; use this q_-prefixed form).",
  "- included_organization_keyword_fields string[] — which employer fields the keyword",
  "  tags match. Honored: tags | name | social_media_description (seo_description is",
  "  silently ignored). Omit to default to ~tags.",
  "- organization_trading_status string[] — only \"private\" (65.7M) and \"public\" (17.5M)",
  "  filter; delisted / acquired / ipo / subsidiary / otc are silently dropped.",
  "- person_functions string[] — broad role family, lowercase_underscore. Verified:",
  "  accounting, administrative, arts_and_design, business_development, consulting,",
  "  data_science, education, engineering, entrepreneurship, finance, human_resources,",
  "  information_technology, legal, marketing, operations, product_management, sales,",
  "  support. An unknown slug returns 0 matches (not an error).",
  "- person_department_or_subdepartments string[] — department (master_* slug) or",
  "  subdepartment (leaf slug). Verified master_*: master_engineering_technical,",
  "  master_information_technology, master_finance, master_sales, master_operations,",
  "  master_marketing, master_human_resources, master_legal. Leaf slugs (e.g. \"sales\",",
  "  \"information_technology\") also work; an unknown slug returns 0.",
  "- q_person_name string — free-text on the person's full name.",
  "- person_not_titles string[] — EXCLUDE these current titles.",
  "RULE: Apollo silently DROPS unknown params (a nonsense param returns the baseline",
  "count unchanged, no 422). A wrong field name is a DEAD filter, not an error — never",
  "trust that a new People-Search filter works because it compiles; confirm it with a",
  "free dry-run count delta first.",
  "=== END UNDOCUMENTED RULES ===",
].join("\n");
