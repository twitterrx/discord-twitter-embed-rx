import { readFileSync } from "node:fs";
import { join } from "node:path";

import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

/**
 * OpenAPI 3.1 は nullable キーワードを廃止し、null を型として表す。
 *
 *   { "type": ["string", "null"] }
 *   { "anyOf": [{ "$ref": ... }, { "type": "null" }] }
 *
 * 3.0 では「null になりうる $ref」の書き方が実質1つしかなく、外れると orval が
 * 静かに間違った Zod を吐いた。この事故を3回繰り返している（#598）。
 *
 *   { "$ref": ..., "nullable": true }               → 標準準拠のツールが sibling を無視する
 *   { "allOf": [{ "$ref": ... }, { "nullable": true }] } → orval が nullable を落とす
 *
 * 3.1 ではどちらも書く動機が消える。nullable が1つも残っていないことを検査すれば、
 * 両方の入口をまとめて塞げる。
 */
const SPEC_DIR = join(__dirname, "../../../openapi");

const SPEC_FILES = ["fxtwitter.openapi.json", "fxtwitter.status-only.openapi.json", "vxtwitter.openapi.yaml"];

const loadSpec = (fileName: string): unknown => {
  const raw = readFileSync(join(SPEC_DIR, fileName), "utf-8");
  return fileName.endsWith(".yaml") ? load(raw) : JSON.parse(raw);
};

/** nullable キーワードが現れる箇所を JSON Pointer で列挙する */
const findNullable = (node: unknown, path = ""): string[] => {
  if (Array.isArray(node)) {
    return node.flatMap((item, index) => findNullable(item, `${path}/${index}`));
  }
  if (node === null || typeof node !== "object") {
    return [];
  }

  const entries = Object.entries(node as Record<string, unknown>);
  const self = entries.some(([key]) => key === "nullable") ? [`${path}/nullable`] : [];

  return [...self, ...entries.flatMap(([key, value]) => findNullable(value, `${path}/${key}`))];
};

describe("OpenAPI spec: 3.1", () => {
  it.each(SPEC_FILES)("%s は 3.1 を宣言している", (fileName) => {
    const spec = loadSpec(fileName) as { openapi?: string };

    expect(spec.openapi).toMatch(/^3\.1\.\d+$/);
  });

  it.each(SPEC_FILES)("%s に nullable キーワードが残っていない", (fileName) => {
    expect(findNullable(loadSpec(fileName))).toEqual([]);
  });

  it("nullable を検出できる", () => {
    // 検出器そのものが壊れて緑になるのを防ぐ
    const broken = { schemas: { A: { type: "string", nullable: true } } };

    expect(findNullable(broken)).toEqual(["/schemas/A/nullable"]);
  });
});
