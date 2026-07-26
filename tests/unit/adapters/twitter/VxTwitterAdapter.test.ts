import { beforeEach, describe, expect, it, vi } from "vitest";
import { mediaUrl } from "../../../fixtures/testMediaUrl";

import type { VxTwitterApi } from "@/vxtwitter/api";
import { VxTwitterServerError } from "@/vxtwitter/api";
import type { VxTwitter, MediaExtended } from "@/vxtwitter/vxtwitter";
import { VxTwitterAdapter } from "@/adapters/twitter/VxTwitterAdapter";

vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const createVxTwitterData = (
  overrides: Partial<VxTwitter> = {},
): VxTwitter => ({
  communityNote: null,
  conversationID: "123456789",
  date: "Sun Jan 01 00:00:00 +0000 2024",
  date_epoch: 1704067200,
  hashtags: [],
  likes: 100,
  mediaURLs: [],
  media_extended: [],
  qrt: null,
  possibly_sensitive: false,
  qrtURL: null,
  replies: 10,
  retweets: 50,
  text: "This is a test tweet",
  tweetID: "123456789",
  tweetURL: "https://x.com/test_user/status/123456789",
  user_name: "Test User",
  user_profile_image_url: mediaUrl("icon.jpg"),
  user_screen_name: "test_user",
  ...overrides,
});

// ---------------------------------------------------------------------------
// 動的テストパターン生成: メディアの種類・個数の組み合わせ
// ---------------------------------------------------------------------------

interface VxMediaPattern {
  name: string;
  /** media_extended のエントリ（undefined でフィールド自体が存在しない状態を表現） */
  mediaExtended?: MediaExtended[];
  /** mediaURLs の配列 */
  mediaURLs: string[];
  /** 期待される media 配列 */
  expected: { count: number; types: string[] };
}

/**
 * type 文字列から TweetMedia.type へのマッピング
 * vxTwitter の media_extended.type の値を internal な型に変換する
 */
function vxTypeToTweetType(type: string): "photo" | "video" {
  return type === "video" || type === "animated_gif" ? "video" : "photo";
}

function createMediaExtended(type: string, idx: number): MediaExtended {
  const isVideo = type === "video";
  const isGif = type === "animated_gif";
  return {
    altText: null,
    size: { height: 720, width: 960 },
    thumbnail_url: isVideo || isGif ? mediaUrl(`thumb_${idx}.jpg`) : mediaUrl(`photo_${idx}.jpg`),
    type,
    url: isVideo
      ? mediaUrl(`video_${idx}.mp4`)
      : isGif
        ? mediaUrl(`gif_${idx}.mp4`)
        : mediaUrl(`photo_${idx}.jpg`),
  };
}

/**
 * メディアパターンを動的に生成する。
 * types の各要素が media_extended の type になり、
 * 同時に mediaURLs も同数生成（フォールバック確認用）。
 * mediaExtendedMissing=true で media_extended フィールド自体を未定義にする。
 */
function* generateVxMediaPatterns(): Generator<VxMediaPattern> {
  // (A) media_extended が存在するケース
  const typeCombos: string[][] = [
    [],            // メディアなし
    ["image"],     // 写真1枚
    ["image", "image"], // 写真2枚
    ["video"],     // 動画1個
    ["video", "video"], // 動画2個
    ["animated_gif"], // animated_gif
    ["image", "video"], // 写真 + 動画
    ["image", "animated_gif"], // 写真 + animated_gif
    ["video", "animated_gif"], // 動画 + animated_gif
    ["image", "video", "image"], // 写真2 + 動画1
  ];

  for (const types of typeCombos) {
    const extended = types.map((t, i) => createMediaExtended(t, i));
    const expectedTypes = types.map((t) => vxTypeToTweetType(t));
    const urls = types.map((_, i) =>
      types[i] === "video"
        ? mediaUrl(`video_${i}.mp4`)
        : types[i] === "animated_gif"
          ? mediaUrl(`gif_${i}.mp4`)
          : mediaUrl(`photo_${i}.jpg`),
    );

    yield {
      name: `media_extended: [${types.join(", ") || "empty"}]`,
      mediaExtended: extended,
      mediaURLs: urls,
      expected: { count: types.length, types: expectedTypes },
    };
  }

  // (B) media_extended がない（undefined）→ mediaURLs にフォールバック
  const urlCounts = [0, 1, 3, 5];
  for (const count of urlCounts) {
    const urls = Array.from({ length: count }, (_, i) => mediaUrl(`fallback_${i}.jpg`));
    yield {
      name: `media_extended undefined, mediaURLs[${count}]`,
      mediaExtended: undefined,
      mediaURLs: urls,
      expected: { count, types: urls.map(() => "photo") },
    };
  }

  // (C) media_extended が空配列 → mediaURLs にフォールバック
  const urlCounts2 = [0, 1, 2];
  for (const count of urlCounts2) {
    const urls = Array.from({ length: count }, (_, i) => mediaUrl(`fallback_empty_${i}.jpg`));
    yield {
      name: `media_extended empty[], mediaURLs[${count}]`,
      mediaExtended: [],
      mediaURLs: urls,
      expected: { count, types: urls.map(() => "photo") },
    };
  }
}

// 全パターンを先に生成しておく（テストランナーの表示順を固定）
const VX_MEDIA_PATTERNS = Array.from(generateVxMediaPatterns());

describe("VxTwitterAdapter", () => {
  let mockApi: { getPostInformation: ReturnType<typeof vi.fn> };
  let adapter: VxTwitterAdapter;

  beforeEach(() => {
    mockApi = { getPostInformation: vi.fn() };
    adapter = new VxTwitterAdapter(mockApi as VxTwitterApi);
  });

  describe("fetchTweet", () => {
    it("正常なレスポンスからTweetモデルを生成できる", async () => {
      const vxData = createVxTwitterData();
      mockApi.getPostInformation.mockResolvedValue(vxData);

      const result = await adapter.fetchTweet(
        "https://x.com/test_user/status/123456789",
      );

      expect(result).toBeDefined();
      expect(result?.url).toBe("https://x.com/test_user/status/123456789");
      expect(result?.text).toBe("This is a test tweet");
      expect(result?.author.name).toBe("Test User(@test_user)");
      expect(result?.author.url).toBe("https://x.com/test_user");
      expect(result?.metrics.likes).toBe(100);
      expect(result?.metrics.replies).toBe(10);
      expect(result?.metrics.retweets).toBe(50);
    });

    it("投票情報を重複と順序を保持してTweetモデルへ変換できる", async () => {
      const vxData = createVxTwitterData({
        pollData: {
          options: [
            { name: "千冬ちゃん", votes: 2, percent: 50 },
            { name: "千冬ちゃん", votes: 2, percent: 50 },
          ],
        },
      });
      mockApi.getPostInformation.mockResolvedValue(vxData);

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result?.poll).toEqual({
        options: [
          { label: "千冬ちゃん", votes: 2, percentage: 50 },
          { label: "千冬ちゃん", votes: 2, percentage: 50 },
        ],
      });
    });

    it("投票情報がない場合 poll は undefined になる", async () => {
      mockApi.getPostInformation.mockResolvedValue(createVxTwitterData({ pollData: null }));

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result?.poll).toBeUndefined();
    });

    it("有効な選択肢がない場合 poll は undefined になる", async () => {
      const vxData = createVxTwitterData({
        pollData: {
          options: [{ name: "得票情報なし" }, { votes: 1, percent: 100 }],
        },
      });
      mockApi.getPostInformation.mockResolvedValue(vxData);

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result?.poll).toBeUndefined();
    });

    it("URL を vxtwitter 形式に変換してリクエストする", async () => {
      mockApi.getPostInformation.mockResolvedValue(createVxTwitterData());

      await adapter.fetchTweet("https://x.com/user/status/123");

      expect(mockApi.getPostInformation).toHaveBeenCalledWith(
        "https://api.vxtwitter.com/user/status/123",
      );
    });

    it("twitter.com の URL も変換できる", async () => {
      mockApi.getPostInformation.mockResolvedValue(createVxTwitterData());

      await adapter.fetchTweet("https://twitter.com/user/status/123");

      expect(mockApi.getPostInformation).toHaveBeenCalledWith(
        "https://api.vxtwitter.com/user/status/123",
      );
    });

    it("画像メディアを含むツイートを変換できる", async () => {
      const vxData = createVxTwitterData({
        mediaURLs: [mediaUrl("photo.jpg")],
        media_extended: [
          {
            altText: null,
            size: { height: 900, width: 1200 },
            thumbnail_url: mediaUrl("photo.jpg"),
            type: "image",
            url: mediaUrl("photo.jpg"),
          },
        ],
      });
      mockApi.getPostInformation.mockResolvedValue(vxData);

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result?.media).toHaveLength(1);
      expect(result?.media[0].type).toBe("photo");
      expect(result?.media[0].url).toBe(mediaUrl("photo.jpg"));
    });

    it("動画メディアを含むツイートを変換できる", async () => {
      const vxData = createVxTwitterData({
        mediaURLs: [mediaUrl("video.mp4")],
        media_extended: [
          {
            altText: null,
            size: { height: 720, width: 960 },
            thumbnail_url: mediaUrl("thumb.jpg"),
            type: "video",
            url: mediaUrl("video.mp4"),
          },
        ],
      });
      mockApi.getPostInformation.mockResolvedValue(vxData);

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result?.media).toHaveLength(1);
      expect(result?.media[0].type).toBe("video");
      expect(result?.media[0].thumbnailUrl).toBe(
        mediaUrl("thumb.jpg"),
      );
    });

    it("引用ツイート（qrt）を含む場合 quote が設定される", async () => {
      const quotedData = createVxTwitterData({
        tweetURL: "https://x.com/quoted_user/status/999",
        user_screen_name: "quoted_user",
        user_name: "Quoted User",
        text: "Original tweet",
      });
      const vxData = createVxTwitterData({
        qrt: quotedData,
        text: "Check this out!",
      });
      mockApi.getPostInformation.mockResolvedValue(vxData);

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result?.quote).toBeDefined();
      expect(result?.quote?.url).toBe("https://x.com/quoted_user/status/999");
      expect(result?.quote?.text).toBe("Original tweet");
    });

    it("qrt が入れ子 2階層目は変換しない（depth 制限）", async () => {
      const deepQrt = createVxTwitterData({ text: "deep nested" });
      const quotedData = createVxTwitterData({
        qrt: deepQrt,
        text: "level 1 quote",
      });
      const vxData = createVxTwitterData({ qrt: quotedData });
      mockApi.getPostInformation.mockResolvedValue(vxData);

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result?.quote).toBeDefined();
      expect(result?.quote?.quote).toBeUndefined();
    });

    it("API が undefined を返す場合 undefined を返す", async () => {
      mockApi.getPostInformation.mockResolvedValue(undefined);

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result).toBeUndefined();
    });

    it("VxTwitterServerError は再スローする", async () => {
      mockApi.getPostInformation.mockRejectedValue(
        new VxTwitterServerError(500, "Internal Server Error"),
      );

      await expect(
        adapter.fetchTweet("https://x.com/user/status/123"),
      ).rejects.toThrow(VxTwitterServerError);
    });

    it("一般エラーは undefined を返す", async () => {
      mockApi.getPostInformation.mockRejectedValue(new Error("network error"));

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // メディア変換の網羅的テスト（動的パターン生成）
  // -----------------------------------------------------------------------
  describe("media conversion", () => {
    it.each(VX_MEDIA_PATTERNS)(
      "$name",
      async ({ mediaExtended, mediaURLs, expected }: VxMediaPattern) => {
        // mediaExtended が undefined の場合はフィールドごと削除した状態を模倣
        const vxData = createVxTwitterData({
          mediaURLs,
          ...(mediaExtended !== undefined
            ? { media_extended: mediaExtended }
            : { media_extended: undefined }),
        });
        mockApi.getPostInformation.mockResolvedValue(vxData);

        const result = await adapter.fetchTweet(
          "https://x.com/user/status/123",
        );

        expect(result).toBeDefined();
        expect(result!.media).toHaveLength(expected.count);

        for (let i = 0; i < expected.count; i++) {
          expect(result!.media[i].type).toBe(expected.types[i]);
        }
      },
    );
  });

  // -----------------------------------------------------------------------
  // 引用ツイート内のメディア変換
  // -----------------------------------------------------------------------
  describe("quote media conversion", () => {
    it("引用ツイートの media_extended も正しく変換される", async () => {
      const quotedData = createVxTwitterData({
        tweetURL: "https://x.com/quoted_user/status/999",
        text: "Quoted tweet with media",
        mediaURLs: [mediaUrl("qt_photo.jpg")],
        media_extended: [
          {
            altText: null,
            size: { height: 900, width: 1200 },
            thumbnail_url: mediaUrl("qt_photo.jpg"),
            type: "image",
            url: mediaUrl("qt_photo.jpg"),
          },
        ],
      });
      const vxData = createVxTwitterData({
        qrt: quotedData,
        text: "Check this out!",
      });
      mockApi.getPostInformation.mockResolvedValue(vxData);

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result?.quote?.media).toHaveLength(1);
      expect(result?.quote?.media[0].type).toBe("photo");
    });

    it("引用ツイートに media_extended がない場合 mediaURLs にフォールバックする", async () => {
      const quotedData = createVxTwitterData({
        tweetURL: "https://x.com/quoted_user/status/999",
        text: "Quoted tweet",
        mediaURLs: [mediaUrl("qt_fallback.jpg")],
        media_extended: undefined,
      });
      const vxData = createVxTwitterData({
        qrt: quotedData,
        text: "Check this out!",
      });
      mockApi.getPostInformation.mockResolvedValue(vxData);

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result?.quote?.media).toHaveLength(1);
      expect(result?.quote?.media[0].type).toBe("photo");
      expect(result?.quote?.media[0].url).toBe(mediaUrl("qt_fallback.jpg"));
    });
  });
});
