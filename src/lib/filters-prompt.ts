import { createHash } from "crypto";
import { z } from "zod";
import { getOpenApiMetadata } from "@asteasolutions/zod-to-openapi";

interface FieldShape {
  typeStr: "string" | "string[]";
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
    `[apollo-service] filters-prompt: field "${fieldName}" has unsupported type "${innerType}". Supported: string, string[], enum, enum[].`
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
