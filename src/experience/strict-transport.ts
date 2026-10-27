/** Groq strict-output transport. The trusted Zod contracts remain unchanged. */
type JsonSchema = Record<string, unknown>;
export type CompatibilityIssue = { path: string; code: string };

const supported = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "anyOf", "$defs", "$ref", "description", "minimum", "maximum"]);
const types = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
const object = (value: unknown): value is JsonSchema => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const record = (value: unknown): JsonSchema => object(value) ? value : {};

function nullable(schema: JsonSchema): JsonSchema {
  if (typeof schema.type === "string") return { ...schema, type: [schema.type, "null"] };
  return { anyOf: [schema, { type: "null" }] };
}

function acceptsNull(schema: JsonSchema): boolean {
  if (schema.type === "null" || (Array.isArray(schema.type) && schema.type.includes("null"))) return true;
  return (Array.isArray(schema.anyOf) && schema.anyOf.some(item => acceptsNull(record(item))))
    || (Array.isArray(schema.oneOf) && schema.oneOf.some(item => acceptsNull(record(item))));
}

function disjointVariants(variants: JsonSchema[]): boolean {
  if (variants.length < 2 || variants.some(variant => !object(variant.properties))) return false;
  const keys = Object.keys(record(variants[0].properties));
  return keys.some(key => {
    const seen = new Set<unknown>();
    return variants.every(variant => {
      const tag = record(record(variant.properties)[key]);
      const values = "const" in tag ? [tag.const] : Array.isArray(tag.enum) ? tag.enum : [];
      if (!values.length || values.some(value => seen.has(value))) return false;
      values.forEach(value => seen.add(value));
      return true;
    });
  });
}

/** Converts only documented strict-mode constructs; unsupported lossy cases fail closed. */
export function groqStrictTransportSchema(source: object): { ok: true; schema: JsonSchema } | { ok: false; issues: CompatibilityIssue[] } {
  const issues: CompatibilityIssue[] = [];
  function convert(value: unknown, path: string): JsonSchema {
    if (!object(value)) { issues.push({ path, code: "schema.invalid" }); return {}; }
    if ("$ref" in value) {
      if (typeof value.$ref !== "string" || !value.$ref.startsWith("#/$defs/")) issues.push({ path, code: "reference.unsupported" });
      return { $ref: value.$ref };
    }
    const result: JsonSchema = {};
    if ("description" in value && typeof value.description === "string") result.description = value.description;
    if ("const" in value) result.enum = [value.const];
    else if ("enum" in value) result.enum = value.enum;
    if ("type" in value) result.type = value.type;
    if (typeof value.minimum === "number" && Number.isFinite(value.minimum)) result.minimum = value.minimum;
    if (typeof value.maximum === "number" && Number.isFinite(value.maximum)) result.maximum = value.maximum;
    if ("oneOf" in value || "anyOf" in value) {
      const key = "oneOf" in value ? "oneOf" : "anyOf";
      const variants = value[key];
      if (!Array.isArray(variants)) issues.push({ path, code: "union.invalid" });
      else {
        if (key === "oneOf" && !disjointVariants(variants.map(record))) issues.push({ path, code: "union.not-disjoint" });
        result.anyOf = variants.map((item, index) => convert(item, `${path}/${key}/${index}`));
      }
    }
    if (object(value.$defs)) result.$defs = Object.fromEntries(Object.entries(value.$defs).map(([key, item]) => [key, convert(item, `${path}/$defs/${key}`)]));
    if ("items" in value) result.items = convert(value.items, `${path}/items`);
    if (value.type === "object" || object(value.properties) || "additionalProperties" in value) {
      const properties = record(value.properties);
      if (object(value.additionalProperties)) {
        if (Object.keys(properties).length) issues.push({ path, code: "record.mixed-object" });
        else return { type: "array", items: { type: "object", properties: { key: { type: "string" }, value: convert(value.additionalProperties, `${path}/additionalProperties`) }, required: ["key", "value"], additionalProperties: false } };
      }
      const required = Array.isArray(value.required) ? value.required : [];
      const converted: JsonSchema = {};
      for (const [key, item] of Object.entries(properties)) {
        const child = convert(item, `${path}/properties/${key}`);
        if (!required.includes(key)) {
          if (acceptsNull(record(item))) issues.push({ path: `${path}/properties/${key}`, code: "optional-null-ambiguous" });
          converted[key] = nullable(child);
        } else converted[key] = child;
      }
      result.type = "object";
      result.properties = converted;
      result.required = Object.keys(properties);
      result.additionalProperties = false;
    }
    return result;
  }
  const schema = convert(source, "#");
  issues.push(...inspectGroqStrictSchema(schema));
  return issues.length ? { ok: false, issues } : { ok: true, schema };
}

export function inspectGroqStrictSchema(schema: unknown): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  function visit(value: unknown, path: string, depth: number) {
    if (!object(value) || depth > 32) { issues.push({ path, code: "schema.invalid-or-deep" }); return; }
    for (const key of Object.keys(value)) if (!supported.has(key)) issues.push({ path: `${path}/${key}`, code: "keyword.unsupported" });
    if (!("type" in value) && !("anyOf" in value) && !("$ref" in value)) issues.push({ path, code: "schema.type-missing" });
    if ("type" in value) {
      const declared = Array.isArray(value.type) ? value.type : [value.type];
      if (!declared.length || declared.some(item => typeof item !== "string" || !types.has(item))) issues.push({ path, code: "schema.type-unsupported" });
    }
    if (value.type === "object") {
      if (object(value.additionalProperties)) issues.push({ path, code: "record.dynamic" });
      else if (value.additionalProperties !== false) issues.push({ path, code: "object.open" });
      const properties = record(value.properties);
      const required = Array.isArray(value.required) ? value.required : [];
      for (const key of Object.keys(properties)) if (!required.includes(key)) issues.push({ path: `${path}/properties/${key}`, code: "property.optional" });
      for (const key of required) if (typeof key !== "string" || !(key in properties)) issues.push({ path, code: "required.unknown" });
      for (const [key, item] of Object.entries(properties)) visit(item, `${path}/properties/${key}`, depth + 1);
    }
    if (Array.isArray(value.anyOf)) value.anyOf.forEach((item, index) => visit(item, `${path}/anyOf/${index}`, depth + 1));
    if (Array.isArray(value.oneOf)) value.oneOf.forEach((item, index) => visit(item, `${path}/oneOf/${index}`, depth + 1));
    for (const keyword of ["allOf", "not", "if", "then", "else"]) {
      const nested = value[keyword];
      if (Array.isArray(nested)) nested.forEach((item, index) => visit(item, `${path}/${keyword}/${index}`, depth + 1));
      else if (object(nested)) visit(nested, `${path}/${keyword}`, depth + 1);
    }
    if ("items" in value) visit(value.items, `${path}/items`, depth + 1);
    if (object(value.$defs)) for (const [key, item] of Object.entries(value.$defs)) visit(item, `${path}/$defs/${key}`, depth + 1);
    if (typeof value.$ref === "string" && !value.$ref.startsWith("#/$defs/")) issues.push({ path, code: "reference.unsupported" });
  }
  visit(schema, "#", 0);
  return issues;
}

class NormalizationError extends Error {
  constructor(readonly code: string, readonly path: string) { super(code); }
}

function matchesVariant(value: unknown, schema: JsonSchema) {
  if (schema.type === "null") return value === null;
  if (schema.type === "array") return Array.isArray(value);
  if (schema.type === "object" || object(schema.properties)) {
    if (!object(value)) return false;
    const tags = Object.entries(record(schema.properties)).filter(([, field]) => "const" in record(field) || Array.isArray(record(field).enum));
    return tags.length === 0 || tags.every(([key, field]) => {
      const tag = record(field);
      return "const" in tag ? value[key] === tag.const : (tag.enum as unknown[]).includes(value[key]);
    });
  }
  return typeof value === schema.type;
}

/** Null on an originally optional field means absent; empty strings/arrays remain present. */
export function normalizeGroqStrictOutput(value: unknown, source: object): { ok: true; value: unknown } | { ok: false; diagnostic: string; path: string } {
  const root = source as JsonSchema;
  function fail(code: string, path: string): never { throw new NormalizationError(code, path); }
  function resolve(schema: JsonSchema, path: string): JsonSchema {
    const seen = new Set<string>();
    while (typeof schema.$ref === "string") {
      const ref = schema.$ref;
      if (!ref.startsWith("#/$defs/") || seen.has(ref)) fail("transport.reference-invalid", path);
      seen.add(ref);
      let target: unknown = root;
      for (const encoded of ref.slice(2).split("/")) {
        const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
        if (!object(target) || !Object.hasOwn(target, key)) fail("transport.reference-unresolved", path);
        target = target[key];
      }
      if (!object(target)) fail("transport.reference-unresolved", path);
      schema = target;
    }
    return schema;
  }
  function normalize(item: unknown, original: JsonSchema, path: string, depth = 0): unknown {
    if (depth > 32) fail("transport.schema-too-deep", path);
    const schema = resolve(original, path);
    const variants = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : null;
    if (variants) {
      const selected = variants.map(record).filter(variant => matchesVariant(item, resolve(variant, path)));
      if (selected.length !== 1) fail("transport.union-unmatched-or-ambiguous", path);
      return normalize(item, selected[0], path, depth + 1);
    }
    if (schema.type === "array") {
      if (!Array.isArray(item)) fail("transport.expected-array", path);
      return item.map((entry, index) => normalize(entry, record(schema.items), `${path}/${index}`, depth + 1));
    }
    if (schema.type !== "object") return item;
    if (object(schema.additionalProperties) && !object(schema.properties)) {
      if (!Array.isArray(item)) fail("transport.expected-record-entries", path);
      const result: Record<string, unknown> = Object.create(null);
      for (const entry of item) {
        if (!object(entry) || Object.keys(entry).sort().join(",") !== "key,value" || typeof entry.key !== "string" || Object.hasOwn(result, entry.key)) fail("transport.invalid-record-entry", path);
        result[entry.key] = normalize(entry.value, schema.additionalProperties, path, depth + 1);
      }
      return result;
    }
    if (!object(item)) fail("transport.expected-object", path);
    const properties = record(schema.properties);
    const required = Array.isArray(schema.required) ? schema.required : [];
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, field] of Object.entries(properties)) {
      if (!Object.hasOwn(item, key)) fail("transport.missing-field", `${path}/${key}`);
      if (!required.includes(key) && item[key] === null) continue;
      result[key] = normalize(item[key], record(field), `${path}/${key}`, depth + 1);
    }
    for (const key of Object.keys(item)) if (!Object.hasOwn(properties, key)) fail("transport.unknown-field", path);
    return result;
  }
  try { return { ok: true, value: normalize(value, source as JsonSchema, "#") }; }
  catch (error) { return error instanceof NormalizationError
    ? { ok: false, diagnostic: error.code, path: error.path }
    : { ok: false, diagnostic: "transport.normalization-failed", path: "#" }; }
}
