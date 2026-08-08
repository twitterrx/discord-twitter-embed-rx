import { readFileSync } from "node:fs";
import { join } from "node:path";

import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

/**
 * OpenAPI 3.0 で「null になりうる $ref」を書く方法は
 * { "nullable": true, "allOf": [{ "$ref": ... }] } の一択。
 * ここから外れた2つの書き方が、実レスポンスを弾いて Embed を止めてきた。
 *
 *   1. { "$ref": ..., "nullable": true }
 *      Reference Object は $ref 以外のプロパティを許さない（3.0 仕様）。
 *      orval 8.22.0 は意図通り nullish を生むが、標準準拠のツールは sibling を無視する。
 *      https://spec.openapis.org/oas/v3.0.0.html#reference-object
 *
 *   2. { "allOf": [{ "$ref": ... }, { "nullable": true }] }
 *      orval がこの nullable を落とす。APIUser.and(zod.unknown().nullable()) となり
 *      null が弾かれる。動画ツイートの publisher と community.admin / creator が
 *      これで落ちていた。
 *
 * 一般的な validator（@apidevtools/swagger-parser 等）は dereference してから検証するため
 * どちらも検出できない。実際、修正前のスペックも通ってしまった。だから構造として禁じる。
 */
const SPEC_DIR = join(__dirname, "../../../openapi");

const SPEC_FILES = ["fxtwitter.openapi.json", "fxtwitter.status-only.openapi.json", "vxtwitter.openapi.yaml"];

const loadSpec = (fileName: string): unknown => {
  const raw = readFileSync(join(SPEC_DIR, fileName), "utf-8");
  return fileName.endsWith(".yaml") ? load(raw) : JSON.parse(raw);
};

const isRecord = (node: unknown): node is Record<string, unknown> =>
  node !== null && typeof node === "object" && !Array.isArray(node);

/** スペックを走査し、violate に当てはまる箇所を JSON Pointer で列挙する */
const collect = (node: unknown, violate: (node: Record<string, unknown>) => string | undefined, path = ""): string[] => {
  if (Array.isArray(node)) {
    return node.flatMap((item, index) => collect(item, violate, `${path}/${index}`));
  }
  if (!isRecord(node)) {
    return [];
  }

  const reason = violate(node);
  const self = reason === undefined ? [] : [`${path} (${reason})`];

  return [...self, ...Object.entries(node).flatMap(([key, value]) => collect(value, violate, `${path}/${key}`))];
};

/** $ref と同じオブジェクトに他のキーがある */
const refWithSiblings = (node: Record<string, unknown>): string | undefined => {
  const siblings = Object.keys(node).filter((key) => key !== "$ref");
  return "$ref" in node && siblings.length > 0 ? siblings.join(", ") : undefined;
};

/** allOf の要素として裸の { nullable: true } が並んでいる */
const nullableInsideAllOf = (node: Record<string, unknown>): string | undefined => {
  if (!Array.isArray(node.allOf)) {
    return undefined;
  }
  const bare = node.allOf.some(
    (member) => isRecord(member) && member.nullable === true && Object.keys(member).length === 1
  );
  return bare ? "allOf の要素に裸の nullable" : undefined;
};

describe("OpenAPI spec: nullable な $ref の書き方", () => {
  describe("$ref に sibling を置かない", () => {
    it.each(SPEC_FILES)("%s", (fileName) => {
      expect(collect(loadSpec(fileName), refWithSiblings)).toEqual([]);
    });

    it("違反を検出できる", () => {
      // 検出器そのものが壊れて緑になるのを防ぐ
      const broken = { schemas: { A: { $ref: "#/components/schemas/B", nullable: true } } };

      expect(collect(broken, refWithSiblings)).toEqual(["/schemas/A (nullable)"]);
    });
  });

  describe("allOf の要素に裸の nullable を置かない", () => {
    it.each(SPEC_FILES)("%s", (fileName) => {
      expect(collect(loadSpec(fileName), nullableInsideAllOf)).toEqual([]);
    });

    it("違反を検出できる", () => {
      const broken = { schemas: { A: { allOf: [{ $ref: "#/components/schemas/B" }, { nullable: true }] } } };

      expect(collect(broken, nullableInsideAllOf)).toEqual(["/schemas/A (allOf の要素に裸の nullable)"]);
    });
  });
});
