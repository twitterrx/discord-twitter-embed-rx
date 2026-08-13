import { describe, it, expect } from "vitest";
import { TEST_URLS, TEST_MESSAGES } from "../../fixtures/test-urls.js";
import { TweetProcessor } from "#/core/services/TweetProcessor.js";
import { mediaUrl } from "../../fixtures/testMediaUrl.js";

describe("TweetProcessor", () => {
  const processor = new TweetProcessor();

  describe("extractUrls", () => {
    it("通常のツイートURLを抽出できる", () => {
      const text = `Check this out: ${TEST_URLS.NORMAL_TWEET}`;
      const urls = processor.extractUrls(text);

      expect(urls).toEqual([TEST_URLS.NORMAL_TWEET]);
    });

    it("twitter.comとx.comの両方のURLを抽出できる", () => {
      const text = "https://twitter.com/user/status/123 and https://x.com/user/status/456";
      const urls = processor.extractUrls(text);

      expect(urls).toHaveLength(2);
      expect(urls).toContain("https://twitter.com/user/status/123");
      expect(urls).toContain("https://x.com/user/status/456");
    });

    it("複数のURLを抽出できる", () => {
      const urls = processor.extractUrls(TEST_MESSAGES.MULTIPLE_URLS);

      expect(urls).toHaveLength(2);
      expect(urls).toContain(TEST_URLS.NORMAL_TWEET);
      expect(urls).toContain(TEST_URLS.VIDEO_SMALL);
    });

    it("重複したURLを除去する", () => {
      const urls = processor.extractUrls(TEST_MESSAGES.DUPLICATE_URLS);

      expect(urls).toHaveLength(1);
      expect(urls[0]).toBe(TEST_URLS.NORMAL_TWEET);
    });

    it("URLが含まれない場合は空配列を返す", () => {
      const text = "This is just a normal message without URLs";
      const urls = processor.extractUrls(text);

      expect(urls).toEqual([]);
    });

    it("スポイラータグ内のURLも抽出できる", () => {
      const urls = processor.extractUrls(TEST_MESSAGES.SPOILER_SINGLE);

      expect(urls).toHaveLength(1);
      expect(urls[0]).toBe(TEST_URLS.NORMAL_TWEET);
    });

    it("記事本体URLを抽出できる", () => {
      const articleUrl = "https://x.com/i/article/2079240895006904322";

      expect(processor.extractUrls(`記事: ${articleUrl}`)).toEqual([articleUrl]);
    });

    it("記事本体URLのクエリとフラグメントは抽出結果に含めない", () => {
      const articleUrl = "https://twitter.com/i/article/2079240895006904322";

      expect(processor.extractUrls(`${articleUrl}?s=20#section`)).toEqual([articleUrl]);
    });
  });

  describe("extractArticleId", () => {
    it.each([
      ["https://x.com/i/article/2079240895006904322", "2079240895006904322"],
      ["https://twitter.com/i/article/2079240895006904322?s=20", "2079240895006904322"],
    ])("記事本体URLから記事IDを抽出できる: %s", (url, expected) => {
      expect(processor.extractArticleId(url)).toBe(expected);
    });

    it("ポストURLではundefinedを返す", () => {
      expect(processor.extractArticleId("https://x.com/user/status/123")).toBeUndefined();
    });
  });

  describe("categorizeBySpoiler", () => {
    it("スポイラータグで囲まれたURLを判定できる", () => {
      const urls = [TEST_URLS.NORMAL_TWEET];
      const result = processor.categorizeBySpoiler(urls, TEST_MESSAGES.SPOILER_SINGLE);

      expect(result.spoiler).toEqual([TEST_URLS.NORMAL_TWEET]);
      expect(result.normal).toEqual([]);
    });

    it("通常のURLとスポイラーURLを正しく分類する", () => {
      const urls = [TEST_URLS.VIDEO_SMALL, TEST_URLS.NORMAL_TWEET];
      const result = processor.categorizeBySpoiler(urls, TEST_MESSAGES.SPOILER_MIXED);

      expect(result.normal).toEqual([TEST_URLS.VIDEO_SMALL]);
      expect(result.spoiler).toEqual([TEST_URLS.NORMAL_TWEET]);
    });

    it("すべて通常のURLの場合", () => {
      const urls = [TEST_URLS.NORMAL_TWEET, TEST_URLS.VIDEO_SMALL];
      const result = processor.categorizeBySpoiler(urls, TEST_MESSAGES.MULTIPLE_URLS);

      expect(result.normal).toEqual(urls);
      expect(result.spoiler).toEqual([]);
    });

    it("クエリパラメータ付きURLでも正しく判定できる", () => {
      const urlWithQuery = TEST_URLS.QUOTE_TWEET;
      const content = `||${urlWithQuery}||`;
      const urls = [urlWithQuery];
      const result = processor.categorizeBySpoiler(urls, content);

      expect(result.spoiler).toEqual([urlWithQuery]);
      expect(result.normal).toEqual([]);
    });
  });

  describe("hasMedia", () => {
    it("メディアが含まれる場合trueを返す", () => {
      const tweet = {
        url: "https://x.com/test/status/123",
        author: { id: "test", name: "Test", url: "https://x.com/test", iconUrl: "" },
        text: "test",
        metrics: { replies: 0, likes: 0, retweets: 0 },
        media: [{ url: mediaUrl("video.mp4"), thumbnailUrl: "", type: "video" as const }],
        timestamp: new Date(),
      };

      expect(processor.hasMedia(tweet)).toBe(true);
    });

    it("メディアが含まれない場合falseを返す", () => {
      const tweet = {
        url: "https://x.com/test/status/123",
        author: { id: "test", name: "Test", url: "https://x.com/test", iconUrl: "" },
        text: "test",
        metrics: { replies: 0, likes: 0, retweets: 0 },
        media: [],
        timestamp: new Date(),
      };

      expect(processor.hasMedia(tweet)).toBe(false);
    });
  });

  describe("hasQuote", () => {
    it("引用ツイートが含まれる場合trueを返す", () => {
      const tweet = {
        url: "https://x.com/test/status/123",
        author: { id: "test", name: "Test", url: "https://x.com/test", iconUrl: "" },
        text: "test",
        metrics: { replies: 0, likes: 0, retweets: 0 },
        media: [],
        timestamp: new Date(),
        quote: {
          url: "https://x.com/quoted/status/456",
          author: { id: "quoted", name: "Quoted", url: "https://x.com/quoted", iconUrl: "" },
          text: "quoted tweet",
          metrics: { replies: 0, likes: 0, retweets: 0 },
          media: [],
          timestamp: new Date(),
        },
      };

      expect(processor.hasQuote(tweet)).toBe(true);
    });

    it("引用ツイートが含まれない場合falseを返す", () => {
      const tweet = {
        url: "https://x.com/test/status/123",
        author: { id: "test", name: "Test", url: "https://x.com/test", iconUrl: "" },
        text: "test",
        metrics: { replies: 0, likes: 0, retweets: 0 },
        media: [],
        timestamp: new Date(),
      };

      expect(processor.hasQuote(tweet)).toBe(false);
    });
  });

  describe("getVideoUrls", () => {
    it("動画URLのみを抽出できる", () => {
      const tweet = {
        url: "https://x.com/test/status/123",
        author: { id: "test", name: "Test", url: "https://x.com/test", iconUrl: "" },
        text: "test",
        metrics: { replies: 0, likes: 0, retweets: 0 },
        media: [
          { url: mediaUrl("photo.jpg"), thumbnailUrl: "", type: "photo" as const },
          { url: mediaUrl("video.mp4"), thumbnailUrl: "", type: "video" as const },
          { url: mediaUrl("video2.mp4"), thumbnailUrl: "", type: "video" as const },
        ],
        timestamp: new Date(),
      };

      const videoUrls = processor.getVideoUrls(tweet);

      expect(videoUrls).toHaveLength(2);
      expect(videoUrls).toContain(mediaUrl("video.mp4"));
      expect(videoUrls).toContain(mediaUrl("video2.mp4"));
    });

    it("動画がない場合は空配列を返す", () => {
      const tweet = {
        url: "https://x.com/test/status/123",
        author: { id: "test", name: "Test", url: "https://x.com/test", iconUrl: "" },
        text: "test",
        metrics: { replies: 0, likes: 0, retweets: 0 },
        media: [{ url: mediaUrl("photo.jpg"), thumbnailUrl: "", type: "photo" as const }],
        timestamp: new Date(),
      };

      const videoUrls = processor.getVideoUrls(tweet);

      expect(videoUrls).toEqual([]);
    });
  });
});
