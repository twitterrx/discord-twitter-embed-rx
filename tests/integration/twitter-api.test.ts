import { describe, it, expect } from "vitest";
import { TEST_URLS } from "../fixtures/test-urls";
import { TwitterAdapter } from "@/adapters/twitter/TwitterAdapter";

/**
 * vxTwitter / FxTwitter の実 API に対する統合テスト。
 *
 * アダプタの変換ロジックとフォールバックの分岐自体は tests/unit/adapters/twitter/ が
 * モックで網羅している。ここでしか見られないのは、実 API が実際に応答し、
 * 期待する形のデータを返すことである。
 *
 * 外部サービスの都合（障害・レート制限・対象ツイートの削除）で落ちるため既定では
 * skip し、RUN_LIVE_API_TESTS=1 でオプトインする。
 *   RUN_LIVE_API_TESTS=1 npx vitest run tests/integration/twitter-api.test.ts
 */
const RUN = process.env.RUN_LIVE_API_TESTS === "1";

describe.skipIf(!RUN)("Twitter API統合テスト", () => {
  const adapter = TwitterAdapter.createDefault();

  // CI環境では外部APIへのアクセスが遅い可能性があるため、タイムアウトを長めに設定
  const TIMEOUT = process.env.CI === "true" ? 30000 : 15000;

  describe("VxTwitter/FxTwitter API", () => {
    it(
      "通常のツイートを取得できる",
      async () => {
        const tweet = await adapter.fetchTweet(TEST_URLS.NORMAL_TWEET);

        expect(tweet).toBeDefined();
        expect(tweet?.url).toMatch(/https:\/\/(x|twitter)\.com/);
        expect(tweet?.author).toBeDefined();
        expect(tweet?.author.id).toBeTruthy();
        expect(tweet?.author.name).toBeTruthy();
        expect(tweet?.text).toBeTruthy();
        expect(tweet?.metrics).toBeDefined();
        expect(tweet?.timestamp).toBeInstanceOf(Date);
      },
      TIMEOUT
    );

    it(
      "引用ツイートの情報も取得できる",
      async () => {
        const tweet = await adapter.fetchTweet(TEST_URLS.QUOTE_TWEET);

        expect(tweet).toBeDefined();
        if (tweet?.quote) {
          expect(tweet.quote).toBeDefined();
          expect(tweet.quote.url).toBeTruthy();
          expect(tweet.quote.author).toBeDefined();
          expect(tweet.quote.text).toBeTruthy();
        }
      },
      TIMEOUT
    );

    it(
      "動画付きツイート（小）を取得できる",
      async () => {
        const tweet = await adapter.fetchTweet(TEST_URLS.VIDEO_SMALL);

        expect(tweet).toBeDefined();
        expect(tweet?.media).toBeDefined();
        expect(tweet?.media.length).toBeGreaterThan(0);

        const hasVideo = tweet?.media.some((m) => m.type === "video");
        expect(hasVideo).toBe(true);
      },
      TIMEOUT
    );

    // NOTE: 大きな動画のURLは削除されている可能性があるため、スキップ
    it.skip(
      "動画付きツイート（大）を取得できる",
      async () => {
        const tweet = await adapter.fetchTweet(TEST_URLS.VIDEO_LARGE);

        expect(tweet).toBeDefined();
        expect(tweet?.media).toBeDefined();
        expect(tweet?.media.length).toBeGreaterThan(0);

        const hasVideo = tweet?.media.some((m) => m.type === "video");
        expect(hasVideo).toBe(true);
      },
      TIMEOUT
    );

    it(
      "存在しないツイートはundefinedを返す",
      async () => {
        const tweet = await adapter.fetchTweet(TEST_URLS.INVALID);

        expect(tweet).toBeUndefined();
      },
      TIMEOUT
    );

    it(
      "twitter.comとx.comのURLの両方に対応している",
      async () => {
        const xUrl = TEST_URLS.NORMAL_TWEET;
        const twitterUrl = xUrl.replace("x.com", "twitter.com");

        const tweetFromX = await adapter.fetchTweet(xUrl);
        const tweetFromTwitter = await adapter.fetchTweet(twitterUrl);

        expect(tweetFromX).toBeDefined();
        expect(tweetFromTwitter).toBeDefined();
      },
      TIMEOUT
    );
  });

  describe("フォールバック機能", () => {
    it(
      "VxTwitterが失敗した場合でもFxTwitterで取得を試みる",
      async () => {
        // TwitterAdapterのデフォルト実装はVxTwitter -> FxTwitterの順で試行する
        const tweet = await adapter.fetchTweet(TEST_URLS.NORMAL_TWEET);

        // 少なくともどちらかのAPIで取得できることを確認
        expect(tweet).toBeDefined();
      },
      TIMEOUT
    );
  });

  describe("メディア情報", () => {
    it(
      "メディアURLとサムネイルURLが取得できる",
      async () => {
        const tweet = await adapter.fetchTweet(TEST_URLS.VIDEO_SMALL);

        expect(tweet).toBeDefined();
        if (tweet && tweet.media.length > 0) {
          const media = tweet.media[0];
          expect(media.url).toBeTruthy();
          expect(media.thumbnailUrl).toBeTruthy();
          expect(media.type).toMatch(/^(photo|video)$/);
        }
      },
      TIMEOUT
    );
  });

  describe("メトリクス情報", () => {
    it(
      "リプライ、いいね、リツイート数が取得できる",
      async () => {
        const tweet = await adapter.fetchTweet(TEST_URLS.NORMAL_TWEET);

        expect(tweet).toBeDefined();
        expect(tweet?.metrics).toBeDefined();
        expect(typeof tweet?.metrics.replies).toBe("number");
        expect(typeof tweet?.metrics.likes).toBe("number");
        expect(typeof tweet?.metrics.retweets).toBe("number");
      },
      TIMEOUT
    );
  });
});
