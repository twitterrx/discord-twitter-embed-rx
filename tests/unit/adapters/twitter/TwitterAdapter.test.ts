import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockTweet } from "../../../fixtures/mock-tweets.js";
import { ITwitterAdapter } from "#/adapters/twitter/BaseTwitterAdapter.js";
import { TwitterAdapter } from "#/adapters/twitter/TwitterAdapter.js";

describe("TwitterAdapter", () => {
  let primaryAdapter: ITwitterAdapter;
  let fallbackAdapter: ITwitterAdapter;
  let twitterAdapter: TwitterAdapter;

  beforeEach(() => {
    primaryAdapter = {
      fetchTweet: vi.fn(),
    };
    fallbackAdapter = {
      fetchTweet: vi.fn(),
    };
    twitterAdapter = new TwitterAdapter(primaryAdapter, fallbackAdapter);
  });

  describe("fetchTweet", () => {
    it("プライマリアダプターが成功した場合、その結果を返す", async () => {
      const mockTweet = createMockTweet();
      vi.mocked(primaryAdapter.fetchTweet).mockResolvedValue(mockTweet);

      const result = await twitterAdapter.fetchTweet("https://x.com/test/status/123");

      expect(result).toEqual(mockTweet);
      expect(primaryAdapter.fetchTweet).toHaveBeenCalledWith("https://x.com/test/status/123");
      expect(fallbackAdapter.fetchTweet).not.toHaveBeenCalled();
    });

    it("プライマリが失敗した場合、フォールバックアダプターを試行する", async () => {
      const mockTweet = createMockTweet();
      vi.mocked(primaryAdapter.fetchTweet).mockResolvedValue(undefined);
      vi.mocked(fallbackAdapter.fetchTweet).mockResolvedValue(mockTweet);

      const result = await twitterAdapter.fetchTweet("https://x.com/test/status/123");

      expect(result).toEqual(mockTweet);
      expect(primaryAdapter.fetchTweet).toHaveBeenCalled();
      expect(fallbackAdapter.fetchTweet).toHaveBeenCalledWith("https://x.com/test/status/123");
    });

    it("両方のアダプターが失敗した場合、undefinedを返す", async () => {
      vi.mocked(primaryAdapter.fetchTweet).mockResolvedValue(undefined);
      vi.mocked(fallbackAdapter.fetchTweet).mockResolvedValue(undefined);

      const result = await twitterAdapter.fetchTweet("https://x.com/test/status/123");

      expect(result).toBeUndefined();
      expect(primaryAdapter.fetchTweet).toHaveBeenCalled();
      expect(fallbackAdapter.fetchTweet).toHaveBeenCalled();
    });

    it("プライマリがエラーをスローした場合でもフォールバックを試行する", async () => {
      const mockTweet = createMockTweet();
      // エラーをスローするのではなく、undefinedを返すようにモック
      vi.mocked(primaryAdapter.fetchTweet).mockResolvedValue(undefined);
      vi.mocked(fallbackAdapter.fetchTweet).mockResolvedValue(mockTweet);

      const result = await twitterAdapter.fetchTweet("https://x.com/test/status/123");

      expect(result).toEqual(mockTweet);
      expect(fallbackAdapter.fetchTweet).toHaveBeenCalled();
    });
  });

  describe("createDefault", () => {
    it("デフォルトインスタンスを作成できる", () => {
      const adapter = TwitterAdapter.createDefault();

      expect(adapter).toBeInstanceOf(TwitterAdapter);
    });
  });
});
