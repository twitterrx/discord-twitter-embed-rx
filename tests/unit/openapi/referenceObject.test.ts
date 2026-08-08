import { readFileSync } from "node:fs";
import { join } from "node:path";

import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

/**
 * OpenAPI 3.0 の Reference Object は $ref 以外のプロパティを許さない。
 * https://spec.openapis.org/oas/v3.0.0.html#reference-object
 *
 * { "$ref": ..., "nullable": true } は orval 8.22.0 では意図通り nullish を生むが、
 * 標準準拠のツールは sibling を無視する。無視されると publisher: null のような
 * 実レスポンスが再び弾かれ、Embed 全体が止まる。3.0 で nullable な参照を表すには
 * { "nullable": true, "allOf": [{ "$ref": ... }] } を使う。
 *
 * なお @apidevtools/swagger-parser のような一般的な validator は dereference して
 * から検証するためこの sibling を検出できない。だから構造として明示的に禁じる。
 */
const SPEC_DIR = join(__dirname, "../../../openapi");

const SPEC_FILES = ["fxtwitter.openapi.json", "fxtwitter.status-only.openapi.json", "vxtwitter.openapi.yaml"];

const loadSpec = (fileName: string): unknown => {
  const raw = readFileSync(join(SPEC_DIR, fileName), "utf-8");
  return fileName.endsWith(".yaml") ? load(raw) : JSON.parse(raw);
};

/** $ref と同じオブジェクトに他のキーがある箇所を JSON Pointer で列挙する */
const findRefsWithSiblings = (node: unknown, path = ""): string[] => {
  if (Array.isArray(node)) {
    return node.flatMap((item, index) => findRefsWithSiblings(item, `${path}/${index}`));
  }
  if (node === null || typeof node !== "object") {
    return [];
  }

  const entries = Object.entries(node as Record<string, unknown>);
  const siblings = entries.filter(([key]) => key !== "$ref").map(([key]) => key);
  const self = "$ref" in node && siblings.length > 0 ? [`${path} (${siblings.join(", ")})`] : [];

  return [...self, ...entries.flatMap(([key, value]) => findRefsWithSiblings(value, `${path}/${key}`))];
};

describe("OpenAPI spec: Reference Object", () => {
  it.each(SPEC_FILES)("%s は $ref に sibling を持たない", (fileName) => {
    expect(findRefsWithSiblings(loadSpec(fileName))).toEqual([]);
  });

  it("sibling を持つ $ref を検出できる", () => {
    // 検出器そのものが壊れて緑になるのを防ぐ
    const broken = { components: { schemas: { A: { $ref: "#/components/schemas/B", nullable: true } } } };

    expect(findRefsWithSiblings(broken)).toEqual(["/components/schemas/A (nullable)"]);
  });
});
