import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { INPUT_SCHEMA as BUY_SERVICE_SCHEMA } from "../src/mcp/buyServiceTool.js";
import { INPUT_SCHEMA as SUBMIT_TASK_SCHEMA } from "../src/mcp/submitTaskTool.js";
import { TASK_STATUS_INPUT_SCHEMA } from "../src/mcp/taskStatusTool.js";

// Every `daski_<tool> arguments:` JSON block in SKILL.md must parse and
// validate against the LIVE tool schema. The 2026-07-25 review found the
// demo teaching a fresh-wallet purchase with no `name` and a one-field
// register-domain payload — the exact call shape every observed agent
// then made. Concrete examples outweigh distant prose; this test makes a
// wrong example a failing build, permanently.

const SKILL_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "static",
  "SKILL.md",
);

const SCHEMAS: Record<string, z.ZodRawShape> = {
  daski_buy_service: BUY_SERVICE_SCHEMA,
  daski_submit_task: SUBMIT_TASK_SCHEMA,
  daski_get_task_status: TASK_STATUS_INPUT_SCHEMA,
};

interface Example {
  tool: string;
  json: string;
  line: number;
}

function extractExamples(markdown: string): Example[] {
  const examples: Example[] = [];
  const pattern = /^```json tool=(daski_\w+)\r?\n([\s\S]*?)```/gm;
  for (const match of markdown.matchAll(pattern)) {
    examples.push({
      tool: match[1],
      json: match[2],
      line: markdown.slice(0, match.index).split("\n").length,
    });
  }
  return examples;
}

describe("SKILL.md examples validate against live tool schemas", () => {
  const markdown = readFileSync(SKILL_PATH, "utf8");
  const examples = extractExamples(markdown);

  it("finds the demo's example blocks", () => {
    const tools = examples.map((e) => e.tool);
    expect(tools).toContain("daski_buy_service");
    expect(tools).toContain("daski_submit_task");
    expect(tools).toContain("daski_get_task_status");
  });

  it.each(extractExamples(readFileSync(SKILL_PATH, "utf8")))(
    "$tool example at line $line is schema-valid",
    ({ tool, json }) => {
      const shape = SCHEMAS[tool];
      expect(shape, `no schema registered for ${tool}`).toBeDefined();
      const parsed = JSON.parse(json);
      // strict(): a key the schema does not know is doc drift, even if
      // the server would tolerate it.
      const result = z.object(shape).strict().safeParse(parsed);
      expect(
        result.success,
        result.success ? "" : JSON.stringify(result.error.issues, null, 2),
      ).toBe(true);
    },
  );

  it("the fresh-wallet buy example carries an explicit identity choice", () => {
    const buy = examples.find((e) => {
      if (e.tool !== "daski_buy_service") return false;
      return Boolean(
        (JSON.parse(e.json) as Record<string, unknown>).registration,
      );
    });
    expect(buy).toBeDefined();
    const parsed = JSON.parse(buy!.json) as Record<string, unknown>;
    expect(
      Boolean(parsed.name) !== Boolean(parsed.useWalletDerivedName),
      "demo first purchase must pass exactly one of name/useWalletDerivedName",
    ).toBe(true);
    const serviceArgs = parsed.serviceArgs as Record<string, unknown>;
    expect(Object.keys(serviceArgs).length).toBeGreaterThan(0);
  });

  it("bounds A2A identifiers and requires an opaque gateway task handle", () => {
    const schema = z.object(SUBMIT_TASK_SCHEMA);
    const common = {
      providerA2AUrl: "https://provider.example/a2a",
      skillId: "check",
      paymentId: "0",
      chainId: 84532 as const,
    };
    for (const field of ["messageId", "contextId"] as const) {
      expect(
        schema.safeParse({ ...common, [field]: "x".repeat(257) }).success,
      ).toBe(false);
    }
    expect(schema.safeParse({ taskId: "task-1" }).success).toBe(false);
    expect(
      schema.safeParse({
        messageId: "message-1",
        contextId: "context-1",
        taskId: "GATEWAY_TASK_ID_0123456789abcdefghijklmnopq",
      }).success,
    ).toBe(true);
  });
});
