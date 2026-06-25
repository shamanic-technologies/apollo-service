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
  "  funding stage\" and do NOT discriminate. Code map (reverse-engineered; anchor",
  "  apollo.io = Series D = \"5\"):",
  "    \"1\"=Seed/Angel  \"2\"=Series A  \"3\"=Series B  \"4\"=Series C  \"5\"=Series D",
  "    \"6\"=Series E  \"7\"=Series F  \"8\"=Series G  \"9\"=Series H  \"10\"=Late/Series I+",
  "RULE: Apollo silently DROPS unknown params (a nonsense param returns the baseline",
  "count unchanged, no 422). A wrong field name is a DEAD filter, not an error — never",
  "trust that a new People-Search filter works because it compiles; confirm it with a",
  "free dry-run count delta first.",
  "=== END UNDOCUMENTED RULES ===",
].join("\n");
