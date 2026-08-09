import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SocialThread } from "@/fxtwitter/generated/model";

/**
 * api.fxtwitter.com から実際に取得したレスポンスを検証する。
 *
 * 手書きのモックではスキーマの思い込みをそのままテストしてしまうため、
 * 実 API の payload をそのまま置いている。取得方法は README ではなく以下の通り:
 *   curl -s "https://api.fxtwitter.com/2/status/<id>" | python3 -m json.tool > <name>.json
 *
 * なお静的な fixture は「自スキーマの回帰」しか守れない。上流の変更を検知したい場合は
 * tests/integration/fxtwitterContract.test.ts（実 API を叩くオプトイン契約テスト）を使う。
 */
const FIXTURE_DIR = join(__dirname, "../../fixtures/fxtwitter");

const loadFixture = (fileName: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURE_DIR, fileName), "utf-8"));

describe("SocialThread schema: 実レスポンス fixture", () => {
  const fixtureNames = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith(".json"));

  it("fixture が存在する", () => {
    // fixture ディレクトリが空のまま緑になるのを防ぐ
    expect(fixtureNames.length).toBeGreaterThan(0);
  });

  it.each(fixtureNames)("%s を受理する", (fileName) => {
    const result = SocialThread.safeParse(loadFixture(fileName));

    // 失敗時に原因フィールドが分かるよう issues を露出させる
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
  });

  describe("possibly_sensitive の有無", () => {
    /**
     * 上流 FxEmbed は possibly_sensitive を必須と宣言しているが、実際には
     * Twitter GraphQL の legacy.possibly_sensitive が無いとキーごと消える。
     * どちらの形も受理できていることを fixture で固定する。
     */
    const statusOf = (fileName: string): Record<string, unknown> =>
      (loadFixture(fileName) as { status: Record<string, unknown> }).status;

    it("possibly_sensitive を欠く実レスポンスが存在する", () => {
      expect(statusOf("status-photo-no-possibly-sensitive.json")).not.toHaveProperty(
        "possibly_sensitive"
      );
    });

    it("possibly_sensitive を持つ実レスポンスも存在する", () => {
      expect(statusOf("status-with-possibly-sensitive.json")).toHaveProperty("possibly_sensitive");
    });
  });
});
