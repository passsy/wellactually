import { z } from "zod";

type JsonSchema = {
  additionalProperties?: boolean;
  type?: string | string[];
  anyOf?: JsonSchema[];
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minimum?: number;
  minItems?: number;
  maxItems?: number;
};

/** Keep the Findings core's JSON schemas intact on this Zod-based MCP. */
export function zodSchema(raw: unknown): z.ZodType {
  const schema = raw as JsonSchema;
  let result: z.ZodType;
  if (schema.anyOf) {
    const choices=schema.anyOf.map(zodSchema);
    result=choices.length===1 ? choices[0]! : z.union(choices as [z.ZodType,z.ZodType,...z.ZodType[]]);
  } else if (Array.isArray(schema.type)) {
    const choices=schema.type.map(type=>zodSchema({...schema,type}));
    result=choices.length===1 ? choices[0]! : z.union(choices as [z.ZodType,z.ZodType,...z.ZodType[]]);
  } else if (schema.enum?.every((value) => typeof value === "string") && schema.enum.length > 0) {
    result = z.enum(schema.enum as [string, ...string[]]);
  } else if (schema.type === "string") result = z.string();
  else if (schema.type === "integer") {
    result = z.number().int();
    if (schema.minimum !== undefined) result = (result as z.ZodNumber).min(schema.minimum);
  } else if (schema.type === "boolean") result = z.boolean();
  else if (schema.type === "null") result = z.null();
  else if (schema.type === "array") {
    let array = z.array(zodSchema(schema.items ?? {}));
    if (schema.minItems !== undefined) array = array.min(schema.minItems);
    if (schema.maxItems !== undefined) array = array.max(schema.maxItems);
    result = array;
  } else if (schema.type === "object") {
    const required = new Set(schema.required ?? []);
    const shape = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, property]) => {
      const child = zodSchema(property);
      return [name, required.has(name) ? child : child.optional()];
    }));
    result = schema.additionalProperties === true ? z.object(shape).passthrough() : schema.additionalProperties === false ? z.object(shape).strict() : z.object(shape);
  } else result = z.unknown();
  return schema.description ? result.describe(schema.description) : result;
}
