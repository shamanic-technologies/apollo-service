import { z } from "zod";
import { getIndustries, getEmployeeRanges } from "./reference-cache.js";

/**
 * Valid Apollo employee range values (comma-separated min,max format)
 */
const VALID_EMPLOYEE_RANGES = [
  "1,10",
  "11,20",
  "21,50",
  "51,100",
  "101,200",
  "201,500",
  "501,1000",
  "1001,2000",
  "2001,5000",
  "5001,10000",
  "10001,",
] as const;

/**
 * Static Zod schema for people search params (camelCase input format).
 * Industry tag IDs require async validation — handled separately.
 */
export const peopleSearchSchema = z.object({
  personTitles: z.array(z.string().min(1)).optional(),
  qOrganizationKeywordTags: z.array(z.string().min(1)).optional(),
  organizationLocations: z.array(z.string().min(1)).optional(),
  organizationNumEmployeesRanges: z
    .array(z.enum(VALID_EMPLOYEE_RANGES))
    .optional(),
  qOrganizationIndustryTagIds: z.array(z.string().min(1)).optional(),
  qKeywords: z.string().optional(),
  page: z.number().int().min(1).max(500).optional(),
  perPage: z.number().int().min(1).max(100).optional(),
});

/**
 * Schema for people enrich (people/match)
 */
export const peopleEnrichSchema = z.object({
  id: z.string().min(1, "Apollo person ID is required"),
});

/**
 * Schema for bulk people enrich (people/bulk_match)
 */
export const bulkPeopleEnrichSchema = z.object({
  personIds: z
    .array(z.string().min(1))
    .min(1, "At least one person ID required")
    .max(10, "Maximum 10 person IDs per request"),
});

export type EndpointType = "search" | "enrich" | "bulk-enrich";

const schemaByEndpoint: Record<EndpointType, z.ZodTypeAny> = {
  search: peopleSearchSchema,
  enrich: peopleEnrichSchema,
  "bulk-enrich": bulkPeopleEnrichSchema,
};

export interface ValidationError {
  field: string;
  message: string;
  value: unknown;
}

export interface ValidationResult {
  index: number;
  valid: boolean;
  endpoint: EndpointType;
  errors: ValidationError[];
}

function formatZodErrors(error: z.ZodError, input: unknown): ValidationError[] {
  return error.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
    value: issue.path.reduce(
      (obj: any, key) => obj?.[key],
      input
    ),
  }));
}

/**
 * Validate industry tag IDs against Apollo's live /industries endpoint.
 * Returns errors for any invalid IDs.
 */
async function validateIndustryTagIds(
  tagIds: string[],
  apiKey: string,
  orgId: string
): Promise<ValidationError[]> {
  const industries = await getIndustries(apiKey, orgId);
  const validTagIds = new Set(industries.map((i) => i.tag_id));

  return tagIds
    .filter((id) => !validTagIds.has(id))
    .map((id) => ({
      field: "qOrganizationIndustryTagIds",
      message: `Invalid industry tag ID: "${id}"`,
      value: id,
    }));
}

/**
 * Validate a batch of items against the specified endpoint schema.
 * Includes async industry tag ID validation for search endpoint.
 */
export async function validateBatch(
  endpoint: EndpointType,
  items: unknown[],
  apiKey: string,
  orgId: string
): Promise<ValidationResult[]> {
  const schema = schemaByEndpoint[endpoint];

  const results: ValidationResult[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const parsed = schema.safeParse(item);
    const errors: ValidationError[] = [];

    if (!parsed.success) {
      errors.push(...formatZodErrors(parsed.error, item));
    }

    // Async: validate industry tag IDs for search endpoint
    if (endpoint === "search" && parsed.success) {
      const data = parsed.data as z.infer<typeof peopleSearchSchema>;
      if (data.qOrganizationIndustryTagIds?.length) {
        const industryErrors = await validateIndustryTagIds(
          data.qOrganizationIndustryTagIds,
          apiKey,
          orgId
        );
        errors.push(...industryErrors);
      }
    }

    results.push({
      index: i,
      valid: errors.length === 0,
      endpoint,
      errors,
    });
  }

  return results;
}
