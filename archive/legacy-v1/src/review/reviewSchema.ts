import { z } from "zod";
import { reviewSuggestions, riskLevels } from "../domain/types.js";

type JsonSchema = boolean | number | string | null | readonly JsonSchema[] | JsonSchemaObject;

interface JsonSchemaObject {
  [key: string]: JsonSchema | undefined;
}

const nonEmptyString = z.string().trim().min(1);

const ReviewFocusItemSchema = z.strictObject({
  title: nonEmptyString,
  detail: nonEmptyString
});

export const ContractReviewResultSchema = z.strictObject({
  contract_type: nonEmptyString,
  risk_level: z.enum(riskLevels),
  suggestion: z.enum(reviewSuggestions),
  confidence: z.number().min(0).max(1),
  must_focus: z.array(ReviewFocusItemSchema).min(1).max(8),
  actions: z.array(nonEmptyString).min(1).max(8),
  tips: z.array(nonEmptyString).min(1).max(5)
});

export type ContractReviewResult = z.infer<typeof ContractReviewResultSchema>;

const nonEmptyStringSchema = { type: "string", minLength: 1, pattern: "\\S" } as const;
const reviewFocusItemSchema = {
  type: "object",
  properties: {
    title: nonEmptyStringSchema,
    detail: nonEmptyStringSchema
  },
  required: ["title", "detail"],
  additionalProperties: false
} as const;

export function toClaudeJsonSchema(): JsonSchemaObject {
  return {
    type: "object",
    properties: {
      contract_type: nonEmptyStringSchema,
      risk_level: { type: "string", enum: [...riskLevels] },
      suggestion: { type: "string", enum: [...reviewSuggestions] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      must_focus: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: reviewFocusItemSchema
      },
      actions: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: nonEmptyStringSchema
      },
      tips: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: nonEmptyStringSchema
      }
    },
    required: [
      "contract_type",
      "risk_level",
      "suggestion",
      "confidence",
      "must_focus",
      "actions",
      "tips"
    ],
    additionalProperties: false
  };
}
