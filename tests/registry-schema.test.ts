import { describe, it, expect, afterAll } from "vitest";
import { z } from "zod";
import {
  zodToJsonSchema,
  register,
  unregister,
  registerTools,
  listTools,
} from "../src/tools/registry.js";

/**
 * Recursively walk a JSON Schema node, invoking `visit` on every plain-object
 * node (the node itself and any nested schema reachable via `properties`,
 * `items`, `additionalProperties`, or `anyOf`).
 */
function walkSchema(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return;
  const obj = node as Record<string, unknown>;
  visit(obj);
  if (obj.properties && typeof obj.properties === "object") {
    for (const child of Object.values(obj.properties as Record<string, unknown>)) {
      walkSchema(child, visit);
    }
  }
  if (obj.items) walkSchema(obj.items, visit);
  if (obj.additionalProperties && typeof obj.additionalProperties === "object") {
    walkSchema(obj.additionalProperties, visit);
  }
  // ZodUnion / ZodNullable emit `anyOf: [...variant schemas]`; recurse into
  // each variant so nested nodes are still reached by the guard.
  if (Array.isArray(obj.anyOf)) {
    for (const child of obj.anyOf) walkSchema(child, visit);
  }
}

describe("zodToJsonSchema — handled variants", () => {
  it("ZodObject produces type/object with properties and required", () => {
    const out = zodToJsonSchema(z.object({ a: z.string(), b: z.number().optional() }));
    expect(out.type).toBe("object");
    expect(out.properties).toMatchObject({ a: { type: "string" }, b: { type: "number" } });
    expect(out.required).toEqual(["a"]);
  });

  it("empty ZodObject produces type/object with empty properties and no required", () => {
    const out = zodToJsonSchema(z.object({}));
    expect(out.type).toBe("object");
    expect(out.properties).toEqual({});
    expect(out.required).toBeUndefined();
  });

  it("ZodString produces type/string", () => {
    expect(zodToJsonSchema(z.string())).toEqual({ type: "string" });
  });

  it("ZodNumber produces type/number", () => {
    expect(zodToJsonSchema(z.number())).toEqual({ type: "number" });
  });

  it("ZodBoolean produces type/boolean", () => {
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: "boolean" });
  });

  it("ZodArray produces type/array with items", () => {
    expect(zodToJsonSchema(z.array(z.string()))).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  it("ZodEnum produces type/string with enum options", () => {
    expect(zodToJsonSchema(z.enum(["x", "y"]))).toEqual({
      type: "string",
      enum: ["x", "y"],
    });
  });

  it("ZodOptional unwraps to the inner schema", () => {
    expect(zodToJsonSchema(z.string().optional())).toEqual({ type: "string" });
  });

  it("ZodDefault unwraps to the inner schema", () => {
    expect(zodToJsonSchema(z.number().default(5))).toEqual({ type: "number" });
  });

  it("ZodEffects (refine/transform) unwraps to the inner schema", () => {
    const refined = z.string().refine((s) => s.length > 0);
    expect(zodToJsonSchema(refined)).toEqual({ type: "string" });
  });
});

describe("zodToJsonSchema — ZodRecord", () => {
  it("enum-keyed record emits type/object, additionalProperties and propertyNames.enum", () => {
    const out = zodToJsonSchema(z.record(z.enum(["a", "b"]), z.number()));
    expect(out.type).toBe("object");
    expect(out.additionalProperties).toEqual({ type: "number" });
    expect(out.propertyNames).toEqual({ enum: ["a", "b"] });
  });

  it("string-keyed record emits NO propertyNames", () => {
    const out = zodToJsonSchema(z.record(z.string(), z.number()));
    expect(out.type).toBe("object");
    expect(out.additionalProperties).toEqual({ type: "number" });
    expect(out.propertyNames).toBeUndefined();
  });

  it("record-of-object recurses into the value schema", () => {
    const out = zodToJsonSchema(z.record(z.string(), z.object({ n: z.number() })));
    expect(out.type).toBe("object");
    expect(out.additionalProperties).toMatchObject({
      type: "object",
      properties: { n: { type: "number" } },
    });
  });

  it("record-of-array recurses into the value schema", () => {
    const out = zodToJsonSchema(z.record(z.string(), z.array(z.boolean())));
    expect(out.type).toBe("object");
    expect(out.additionalProperties).toEqual({
      type: "array",
      items: { type: "boolean" },
    });
  });
});

describe("zodToJsonSchema — ZodLiteral", () => {
  it("string literal produces { const: <string> }", () => {
    expect(zodToJsonSchema(z.literal("chars-div-3.5"))).toEqual({ const: "chars-div-3.5" });
  });

  it("number literal produces { const: <number> }", () => {
    expect(zodToJsonSchema(z.literal(2))).toEqual({ const: 2 });
  });
});

describe("zodToJsonSchema — ZodUnion", () => {
  it("union of primitives produces anyOf of the variant schemas", () => {
    expect(zodToJsonSchema(z.union([z.string(), z.number()]))).toEqual({
      anyOf: [{ type: "string" }, { type: "number" }],
    });
  });

  it("union of literals produces anyOf of const schemas", () => {
    expect(zodToJsonSchema(z.union([z.literal(2), z.literal(3)]))).toEqual({
      anyOf: [{ const: 2 }, { const: 3 }],
    });
  });
});

describe("zodToJsonSchema — ZodNullable", () => {
  it("nullable primitive produces anyOf of [inner, { type: null }]", () => {
    expect(zodToJsonSchema(z.string().nullable())).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
    });
  });

  it("nullable object recurses into the inner schema", () => {
    expect(zodToJsonSchema(z.object({ n: z.number() }).nullable())).toEqual({
      anyOf: [
        { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
        { type: "null" },
      ],
    });
  });
});

describe("zodToJsonSchema — unsupported types throw", () => {
  it("throws on ZodTuple, naming the Zod type", () => {
    expect(() => zodToJsonSchema(z.tuple([z.string(), z.number()]))).toThrow(/ZodTuple/);
  });

  it("throws on ZodSet, naming the Zod type", () => {
    expect(() => zodToJsonSchema(z.set(z.string()))).toThrow(/ZodSet/);
  });
});

describe("listTools — registered tools produce valid JSON Schema", () => {
  it("regression guard: every tool's inputSchema is a deeply-valid object schema", () => {
    registerTools();
    const tools = listTools();
    expect(tools.length).toBeGreaterThan(0);

    for (const t of tools) {
      const root = t.inputSchema as Record<string, unknown>;
      expect(root.type, `${t.name} root must declare a type`).toBe("object");
      walkSchema(root, (node) => {
        // Every schema node must positively declare its shape: a `type`, a
        // `const` (ZodLiteral), or an `anyOf` (ZodUnion / ZodNullable). A bare
        // `{}` with none of these is exactly the vacuous-schema regression
        // this guards — previously emitted by the unhandled literal/nullable
        // fields on the record_run tool's RunRecord schema.
        const declaresShape =
          node.type !== undefined || "const" in node || Array.isArray(node.anyOf);
        expect(
          declaresShape,
          `node in ${t.name} inputSchema is missing a "type"/"const"/"anyOf" key`,
        ).toBe(true);
      });
    }
  });

  it("apply_consolidation_rules.weights resolves to a proper record schema", () => {
    registerTools();
    const tool = listTools().find((t) => t.name === "apply_consolidation_rules");
    expect(tool).toBeDefined();
    const weights = (tool!.inputSchema as { properties: Record<string, unknown> }).properties
      .weights as Record<string, unknown>;
    expect(weights.type).toBe("object");
    expect(weights.additionalProperties).toBeDefined();
    expect(weights.additionalProperties).toMatchObject({ type: "number" });
    expect(weights.propertyNames).toMatchObject({ enum: expect.any(Array) });
  });

  it("score_rubric.weights resolves to a proper record schema", () => {
    registerTools();
    const tool = listTools().find((t) => t.name === "score_rubric");
    expect(tool).toBeDefined();
    const weights = (tool!.inputSchema as { properties: Record<string, unknown> }).properties
      .weights as Record<string, unknown>;
    expect(weights.type).toBe("object");
    expect(weights.additionalProperties).toBeDefined();
    expect(weights.additionalProperties).toMatchObject({ type: "number" });
    expect(weights.propertyNames).toMatchObject({ enum: expect.any(Array) });
  });
});

// Kept LAST: registering a fake tool with an unsupported-type schema mutates
// the module-private tools Map. Running it after the positive assertions above
// keeps the leak from polluting them.
describe("listTools — throw propagation through listTools()", () => {
  // The registry is a module-level singleton; drop the throwaway tool so a
  // later test file in the same worker can still call listTools().
  afterAll(() => unregister("__fake_unsupported_schema_tool__"));

  it("listTools() throws when a registered tool has an unsupported-type schema", () => {
    register({
      name: "__fake_unsupported_schema_tool__",
      description: "test-only tool with an unsupported Zod schema",
      // ZodTuple is intentionally unhandled by zodToJsonSchema — union and
      // literal are now supported, so a genuinely-unhandled type is required.
      schema: z.tuple([z.string(), z.number()]),
      handler: () => null,
    });
    expect(() => listTools()).toThrow(/ZodTuple/);
  });
});
