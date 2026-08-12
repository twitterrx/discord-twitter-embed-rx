import { describe, expect, it } from "vitest";

import { FxTwitterAdapter } from "#/adapters/twitter/FxTwitterAdapter.js";
import { SocialThread } from "#/fxtwitter/generated/model/index.js";

import { TEST_URLS } from "../fixtures/test-urls.js";

/**
 * FxTwitter の実 API とスキーマの契約テスト。
 *
 * tests/unit/fxtwitter/socialThreadFixtures.test.ts は保存済み payload を検証するため
 * 「自スキーマの回帰」しか守れない。上流が required なフィールドを落としたり型を変えたりする
 * ドリフトは、実 API を叩かないと検知できない。
 *
 * ネットワーク依存で不安定になるため既定では skip し、RUN_LIVE_API_TESTS=1 でオプトインする。
 *   RUN_LIVE_API_TESTS=1 npx vitest run tests/integration/fxtwitterContract.test.ts
 */
const RUN = process.env.RUN_LIVE_API_TESTS === "1";

const TIMEOUT = process.env.CI === "true" ? 30000 : 15000;

const extractId = (url: string): string => {
  const id = url.match(/\/status\/(\d{2,20})/)?.[1];
  if (!id) {
    throw new Error(`tweet id を抽出できない: ${url}`);
  }
  return id;
};

const fetchStatus = async (url: string): Promise<unknown> => {
  const response = await fetch(`https://api.fxtwitter.com/2/status/${extractId(url)}`);
  expect(response.ok).toBe(true);
  return response.json();
};

describe.skipIf(!RUN)("FxTwitter 実 API との契約", () => {
  /**
   * 形の違うツイートを並べる。ここに載っていない形は検証できないため、
   * 上流ドリフトで壊れた形が見つかったら fixture と合わせてここにも追加する。
   */
  const CASES: [name: string, url: string][] = [
    ["通常のツイート", TEST_URLS.NORMAL_TWEET],
    ["引用ツイート", TEST_URLS.QUOTE_TWEET],
    ["動画ツイート", TEST_URLS.VIDEO_SMALL],
  ];

  it.each(CASES)(
    "%s のレスポンスがスキーマに適合する",
    async (_name, url) => {
      const result = SocialThread.safeParse(await fetchStatus(url));

      // 失敗時に原因フィールドが分かるよう issues を露出させる
      expect(result.error?.issues ?? []).toEqual([]);
      expect(result.success).toBe(true);
    },
    TIMEOUT
  );

  it.each(CASES)(
    "%s を FxTwitterAdapter が Tweet に変換できる",
    async (_name, url) => {
      const tweet = await new FxTwitterAdapter().fetchTweet(url);

      expect(tweet).toBeDefined();
      expect(tweet?.text).toBeTruthy();
      expect(tweet?.author.name).toBeTruthy();
      expect(tweet?.timestamp).toBeInstanceOf(Date);
    },
    TIMEOUT
  );
});
