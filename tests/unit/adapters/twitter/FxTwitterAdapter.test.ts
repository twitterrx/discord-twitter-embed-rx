import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { mediaUrl } from "../../../fixtures/testMediaUrl";

import type { FxTwitterApi } from "@/fxtwitter/api";
import type {
  SocialThreadOutput,
  APITwitterStatus,
  APITwitterStatusArticle,
  APIUser,
  APITwitterStatusMedia,
} from "@/fxtwitter/generated/model";
import { APITwitterStatus as APITwitterStatusSchema } from "@/fxtwitter/generated/model";
import { FxTwitterAdapter } from "@/adapters/twitter/FxTwitterAdapter";
import logger from "@/utils/logger";

vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * API が返すのは Zod で検証済みのデータなので、入力型 SocialThread ではなく
 * 出力型 SocialThreadOutput を使う。
 *
 * なお SocialThread["status"]（入力型）は unknown へ潰れる。orval が再帰スキーマに
 * 付ける zod.ZodType<APITwitterStatus> は Input 型引数が省略されており、
 * zod v4 では既定の unknown になるため。出力型側は正しい union に解決される。
 *
 * また status の判別子 type は Bluesky/Mastodon など他プラットフォームでも "status" のため、
 * type だけでは Twitter を特定できない。ここでは Twitter の型を直接指す。
 */
type TwitterStatus = APITwitterStatus;

const createFxAuthor = (overrides: Partial<APIUser> = {}): APIUser => ({
  type: "profile",
  id: "test_user",
  name: "Test User",
  screen_name: "test_user",
  avatar_url: mediaUrl("icon.jpg"),
  banner_url: mediaUrl("banner.jpg"),
  description: "test bio",
  raw_description: { text: "test bio", facets: [] },
  location: "Tokyo",
  url: "https://x.com/test_user",
  protected: false,
  followers: 100,
  following: 50,
  statuses: 10,
  media_count: 5,
  likes: 20,
  joined: "2020-01-01T00:00:00.000Z",
  website: null,
  ...overrides,
});

const createFxMediaItem = (overrides: Partial<APITwitterStatusMedia["all"] extends (infer T)[] | undefined ? T : never> = {}): NonNullable<APITwitterStatusMedia["all"]>[number] => ({
  type: "photo",
  id: "12345",
  url: mediaUrl("photo.jpg"),
  width: 1920,
  height: 1080,
  ...overrides,
});

const createFxStatus = (overrides: Partial<APITwitterStatus> = {}): TwitterStatus => ({
  type: "status",
  id: "123456789",
  url: "https://x.com/test_user/status/123456789",
  text: "This is a test tweet",
  created_at: "2024-01-01T00:00:00.000Z",
  created_timestamp: 1704067200,
  likes: 100,
  reposts: 50,
  quotes: 5,
  replies: 10,
  author: createFxAuthor(),
  media: {},
  raw_text: { text: "This is a test tweet", display_text_range: [0, 20], facets: [] },
  lang: "en",
  possibly_sensitive: false,
  replying_to: null,
  source: "Twitter Web App",
  embed_card: "tweet",
  provider: "twitter",
  is_note_tweet: false,
  community_note: null,
  reposted_by: null,
  ...overrides,
});

/**
 * media.all を含まない Media オブジェクトを作る（古いAPIレスポンスの模倣）
 */
const createFxMediaWithoutAll = (
  photos: NonNullable<APITwitterStatusMedia["photos"]> = [],
  videos: NonNullable<APITwitterStatusMedia["videos"]> = [],
): APITwitterStatusMedia => ({
  photos,
  videos,
});

const createFxPhoto = (overrides: Partial<NonNullable<APITwitterStatusMedia["photos"]>[number]> = {}): NonNullable<APITwitterStatusMedia["photos"]>[number] => ({
  type: "photo",
  id: "12345",
  url: mediaUrl("photo.jpg"),
  width: 1920,
  height: 1080,
  ...overrides,
});

const createFxVideo = (overrides: Partial<NonNullable<APITwitterStatusMedia["videos"]>[number]> = {}): NonNullable<APITwitterStatusMedia["videos"]>[number] => ({
  id: "67890",
  url: mediaUrl("video.mp4"),
  thumbnail_url: mediaUrl("thumb.jpg"),
  type: "video",
  width: 1920,
  height: 1080,
  duration: 30,
  formats: [],
  ...overrides,
});

const createFxResponse = (status: TwitterStatus): SocialThreadOutput => ({
  code: 200,
  status,
  thread: null,
  author: null,
});

const createFxArticle = (overrides: Partial<APITwitterStatusArticle> = {}): APITwitterStatusArticle => ({
  created_at: "2024-01-01T00:00:00.000Z",
  id: "2079240895006904322",
  title: "記事タイトル",
  preview_text: "記事のプレビュー",
  cover_media: {
    id: "cover-id",
    media_key: "media-key",
    media_id: "media-id",
    media_info: {
      __typename: "ApiImage",
      original_img_height: 1080,
      original_img_width: 1920,
      original_img_url: mediaUrl("article-cover.jpg"),
      color_info: { palette: [] },
    },
  },
  content: {},
  media_entities: [],
  ...overrides,
});

// ---------------------------------------------------------------------------
// 動的テストパターン生成: メディアの種類・個数の組み合わせ
// ---------------------------------------------------------------------------

interface FxMediaPattern {
  name: string;
  /** メディアオブジェクト（undefined で media フィールド自体なし） */
  media: APITwitterStatusMedia | undefined;
  /** 期待される media 配列 */
  expected: { count: number; types: string[] };
}

/**
 * type 文字列から TweetMedia.type へのマッピング
 */
function fxTypeToTweetType(type: string): "photo" | "video" {
  return type === "video" || type === "gif" ? "video" : "photo";
}

function createMediaItemForType(type: string, idx: number): NonNullable<APITwitterStatusMedia["all"]>[number] {
  const isVideo = type === "video";
  const isGif = type === "gif";
  return {
    type,
    id: `${idx}`,
    url: isVideo
      ? mediaUrl(`video_${idx}.mp4`)
      : isGif
        ? mediaUrl(`gif_${idx}.mp4`)
        : mediaUrl(`photo_${idx}.jpg`),
    ...(isVideo || isGif ? { thumbnail_url: mediaUrl(`thumb_${idx}.jpg`) } : {}),
    width: 1920,
    height: 1080,
  } as NonNullable<APITwitterStatusMedia["all"]>[number];
}

function generateFxMediaPatterns(): FxMediaPattern[] {
  const patterns: FxMediaPattern[] = [];

  // (A) media.all が存在するケース
  const typeCombos: string[][] = [
    [],            // メディアなし
    ["photo"],     // 写真1枚
    ["photo", "photo"], // 写真2枚
    ["video"],     // 動画1個
    ["video", "video"], // 動画2個
    ["gif"],       // gif
    ["photo", "video"], // 写真 + 動画
    ["photo", "gif"],   // 写真 + gif
    ["video", "gif"],   // 動画 + gif
    ["photo", "video", "gif"], // 写真 + 動画 + gif
  ];

  for (const types of typeCombos) {
    const items = types.map((t, i) => createMediaItemForType(t, i));
    const expectedTypes = types.map((t) => fxTypeToTweetType(t));
    patterns.push({
      name: `media.all: [${types.join(", ") || "empty"}]`,
      media: { all: items, photos: [], videos: [] },
      expected: { count: types.length, types: expectedTypes },
    });
  }

  // (B) media.all がなく photos + videos のみ（フォールバック）
  const fallbackCombos: {
    photos: NonNullable<APITwitterStatusMedia["photos"]>[number]["type"][];
    videos: NonNullable<APITwitterStatusMedia["videos"]>[number]["type"][];
  }[] = [
    { photos: [], videos: [] },
    { photos: ["photo"], videos: [] },
    { photos: ["photo", "photo"], videos: [] },
    { photos: [], videos: ["video"] },
    { photos: [], videos: ["video", "video"] },
    { photos: ["photo"], videos: ["video"] },
    { photos: ["photo", "photo"], videos: ["video"] },
  ];

  for (const combo of fallbackCombos) {
    const photos = combo.photos.map(
      (type, i) => createFxPhoto({ url: mediaUrl(`fb_photo_${i}.jpg`), type }),
    );
    const videos = combo.videos.map(
      (type, i) =>
        createFxVideo({
          url: mediaUrl(`fb_video_${i}.mp4`),
          thumbnail_url: mediaUrl(`fb_thumb_${i}.jpg`),
          type,
        }),
    );
    const expectedTypes = [
      ...combo.photos.map(() => "photo" as const),
      ...combo.videos.map(() => "video" as const),
    ];
    patterns.push({
      name: `media.all undefined, photos[${combo.photos.length}] + videos[${combo.videos.length}]`,
      media: createFxMediaWithoutAll(photos, videos),
      expected: { count: expectedTypes.length, types: expectedTypes },
    });
  }

  // (C) media が undefined（メディアなし）
  patterns.push({
    name: "media undefined (no media)",
    media: undefined,
    expected: { count: 0, types: [] },
  });

  return patterns;
}

const FX_MEDIA_PATTERNS = generateFxMediaPatterns();

describe("FxTwitterAdapter", () => {
  let mockApi: { getPostInformation: Mock<FxTwitterApi["getPostInformation"]> };
  let adapter: FxTwitterAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockApi = { getPostInformation: vi.fn<FxTwitterApi["getPostInformation"]>() };
    // adapter が利用するのは getPostInformation のみのため、部分実装を注入する
    adapter = new FxTwitterAdapter(mockApi as unknown as FxTwitterApi);
  });

  describe("fetchTweet", () => {
    it("未知の記事entityMap要素が含まれても記事レスポンスを検証できる", () => {
      const article = createFxArticle({
        content: {
          entityMap: [
            {
              key: "2",
              value: {
                type: "LINK",
                mutability: "MUTABLE",
                data: { url: "https://example.com" },
              },
            },
          ],
        } as unknown as APITwitterStatusArticle["content"],
      });

      const status = {
        ...createFxStatus({
          article,
          author: createFxAuthor({
            description: "",
            raw_description: { text: "", facets: [] },
            location: "",
            url: "https://x.com/test_user",
            protected: false,
            followers: 0,
            following: 0,
            statuses: 0,
            media_count: 0,
            likes: 0,
            joined: "2024-01-01T00:00:00.000Z",
            website: null,
          }),
        }),
        quotes: 0,
        media: { all: [], photos: [], videos: [] },
        raw_text: {
          text: "",
          display_text_range: [0, 0],
          facets: [],
        },
        lang: null,
        possibly_sensitive: false,
        replying_to: null,
        source: null,
        embed_card: "tweet",
        provider: "twitter",
        is_note_tweet: false,
        community_note: null,
        reposted_by: null,
      };

      const result = APITwitterStatusSchema.safeParse(status);

      expect(result.success).toBe(true);
    });

    it("正常なレスポンスからTweetモデルを生成できる", async () => {
      mockApi.getPostInformation.mockResolvedValue(
        createFxResponse(createFxStatus()),
      );

      const result = await adapter.fetchTweet(
        "https://x.com/test_user/status/123456789",
      );

      expect(result).toBeDefined();
      expect(result?.url).toBe("https://x.com/test_user/status/123456789");
      expect(result?.text).toBe("This is a test tweet");
      expect(result?.author.name).toBe("Test User(@test_user)");
      expect(result?.metrics.likes).toBe(100);
      expect(result?.metrics.replies).toBe(10);
      expect(result?.metrics.retweets).toBe(50);
    });

    it("投票情報を順序どおりTweetモデルへ変換できる", async () => {
      const status = createFxStatus({
        poll: {
          choices: [
            { label: "選択肢A", count: 3, percentage: 75 },
            { label: "選択肢B", count: 1, percentage: 25 },
          ],
          total_votes: 4,
          ends_at: "2026-07-26T03:42:53Z",
          time_left_en: "Final results",
        },
      });
      mockApi.getPostInformation.mockResolvedValue(createFxResponse(status));

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result?.poll).toEqual({
        options: [
          { label: "選択肢A", votes: 3, percentage: 75 },
          { label: "選択肢B", votes: 1, percentage: 25 },
        ],
      });
    });

    it("投票情報がない場合 poll は undefined になる", async () => {
      mockApi.getPostInformation.mockResolvedValue(createFxResponse(createFxStatus({ poll: undefined })));

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result?.poll).toBeUndefined();
    });

    it("選択肢が空の場合 poll は undefined になる", async () => {
      const status = createFxStatus({
        poll: {
          choices: [],
          total_votes: 0,
          ends_at: "2026-07-26T03:42:53Z",
          time_left_en: "Final results",
        },
      });
      mockApi.getPostInformation.mockResolvedValue(createFxResponse(status));

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result?.poll).toBeUndefined();
    });

    it("記事情報をTweetモデルへ変換できる", async () => {
      mockApi.getPostInformation.mockResolvedValue(
        createFxResponse(createFxStatus({ article: createFxArticle() })),
      );

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result?.article).toEqual({
        id: "2079240895006904322",
        title: "記事タイトル",
        previewText: "記事のプレビュー",
        imageUrl: mediaUrl("article-cover.jpg"),
      });
    });

    it("動画カバーの記事情報をTweetモデルへ変換できる", async () => {
      const videoCover = createFxArticle().cover_media;
      videoCover.media_info = {
        __typename: "ApiVideo",
        type: "video",
        id: "video-id",
        id_str: "video-id",
        ext_alt_text: null,
        ext_media_color: { palette: [] },
        media_url: mediaUrl("article-cover.jpg"),
        media_url_https: mediaUrl("article-cover.jpg"),
        url: "https://t.co/cover",
        display_url: "pic.x.com/cover",
        expanded_url: "https://x.com/cover",
        original_info: { height: 1080, width: 1920 },
        sizes: { original: { h: 1080, resize: "fit", w: 1920 } },
        video_info: {
          aspect_ratio: [16, 9],
          duration_millis: 10_000,
          variants: [],
        },
      };
      mockApi.getPostInformation.mockResolvedValue(
        createFxResponse(createFxStatus({ article: createFxArticle({ cover_media: videoCover }) })),
      );

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result?.article?.imageUrl).toBe(mediaUrl("article-cover.jpg"));
    });

    it("URL を fxtwitter 形式に変換してリクエストする", async () => {
      mockApi.getPostInformation.mockResolvedValue(
        createFxResponse(createFxStatus()),
      );

      await adapter.fetchTweet("https://x.com/user/status/123");

      expect(mockApi.getPostInformation).toHaveBeenCalledWith(
        "https://api.fxtwitter.com/user/status/123",
      );
    });

    it("twitter.com の URL も変換できる", async () => {
      mockApi.getPostInformation.mockResolvedValue(
        createFxResponse(createFxStatus()),
      );

      await adapter.fetchTweet("https://twitter.com/user/status/123");

      expect(mockApi.getPostInformation).toHaveBeenCalledWith(
        "https://api.fxtwitter.com/user/status/123",
      );
    });

    it("画像メディアを含むツイートを変換できる", async () => {
      const status = createFxStatus({
        media: { all: [createFxMediaItem()], photos: [], videos: [] },
      });
      mockApi.getPostInformation.mockResolvedValue(createFxResponse(status));

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result?.media).toHaveLength(1);
      expect(result?.media[0].type).toBe("photo");
      expect(result?.media[0].url).toBe(mediaUrl("photo.jpg"));
      expect(result?.media[0].thumbnailUrl).toBe(mediaUrl("photo.jpg"));
    });

    it("複数の画像メディアを変換できる", async () => {
      const status = createFxStatus({
        media: {
          all: [
            createFxMediaItem({ url: mediaUrl("photo1.jpg") }),
            createFxMediaItem({ url: mediaUrl("photo2.jpg") }),
          ],
          photos: [],
          videos: [],
        },
      });
      mockApi.getPostInformation.mockResolvedValue(createFxResponse(status));

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result?.media).toHaveLength(2);
    });

    it("動画メディアを含むツイートを変換できる", async () => {
      const status = createFxStatus({
        media: {
          all: [
            createFxMediaItem({
              type: "video",
              url: mediaUrl("video.mp4"),
              thumbnail_url: mediaUrl("thumb.jpg"),
            }),
          ],
          photos: [],
          videos: [],
        },
      });
      mockApi.getPostInformation.mockResolvedValue(createFxResponse(status));

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result?.media).toHaveLength(1);
      expect(result?.media[0].type).toBe("video");
      expect(result?.media[0].url).toBe(mediaUrl("video.mp4"));
      expect(result?.media[0].thumbnailUrl).toBe(mediaUrl("thumb.jpg"));
    });

    it("メディアがない場合 media は空配列になる", async () => {
      mockApi.getPostInformation.mockResolvedValue(
        createFxResponse(createFxStatus({ media: undefined })),
      );

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result?.media).toEqual([]);
    });

    it("引用ツイートが含まれる場合 quote が設定される", async () => {
      const quotedStatus = createFxStatus({
        url: "https://x.com/quoted_user/status/999",
        author: createFxAuthor({
          screen_name: "quoted_user",
          name: "Quoted User",
        }),
        text: "Original tweet",
      });
      const status = createFxStatus({ quote: quotedStatus, text: "Check this!" });
      mockApi.getPostInformation.mockResolvedValue(createFxResponse(status));

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result?.quote).toBeDefined();
      expect(result?.quote?.url).toBe("https://x.com/quoted_user/status/999");
      expect(result?.quote?.text).toBe("Original tweet");
    });

    it("quote が入れ子 2階層目は変換しない（depth 制限）", async () => {
      const deepQuote = createFxStatus({ text: "deep nested" });
      const quotedStatus = createFxStatus({
        quote: deepQuote,
        text: "level 1 quote",
      });
      const status = createFxStatus({ quote: quotedStatus });
      mockApi.getPostInformation.mockResolvedValue(createFxResponse(status));

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result?.quote).toBeDefined();
      expect(result?.quote?.quote).toBeUndefined();
    });

    it("API が undefined を返す場合 undefined を返す", async () => {
      mockApi.getPostInformation.mockResolvedValue(undefined);

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result).toBeUndefined();
    });

    it("レスポンスに status が含まれない場合 undefined を返す", async () => {
      // status を含まない不正レスポンスを意図的に流し込む
      mockApi.getPostInformation.mockResolvedValue({ code: 404 } as unknown as SocialThreadOutput);

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result).toBeUndefined();
    });

    it("API がエラーを投げた場合 undefined を返す", async () => {
      mockApi.getPostInformation.mockRejectedValue(new Error("network error"));

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // メディア変換の網羅的テスト（動的パターン生成）
  // -----------------------------------------------------------------------
  describe("media conversion", () => {
    it.each(FX_MEDIA_PATTERNS)(
      "$name",
      async ({ media, expected }: FxMediaPattern) => {
        const status = createFxStatus({ media });
        mockApi.getPostInformation.mockResolvedValue(createFxResponse(status));

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
    it("引用ツイートの media.all が正しく変換される", async () => {
      const quotedStatus = createFxStatus({
        url: "https://x.com/quoted_user/status/999",
        author: createFxAuthor({ screen_name: "quoted_user" }),
        text: "Quoted tweet with media",
        media: {
          all: [createFxMediaItem({ url: mediaUrl("qt_photo.jpg") })],
          photos: [],
          videos: [],
        },
      });
      const status = createFxStatus({ quote: quotedStatus, text: "Check this!" });
      mockApi.getPostInformation.mockResolvedValue(createFxResponse(status));

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result?.quote?.media).toHaveLength(1);
      expect(result?.quote?.media[0].type).toBe("photo");
      expect(result?.quote?.media[0].url).toBe(mediaUrl("qt_photo.jpg"));
    });

    it("引用ツイートに media.all がない場合 photos からフォールバックする", async () => {
      const quotedStatus = createFxStatus({
        url: "https://x.com/quoted_user/status/999",
        author: createFxAuthor({ screen_name: "quoted_user" }),
        text: "Quoted tweet",
        media: createFxMediaWithoutAll(
          [createFxPhoto({ url: mediaUrl("qt_fb_photo.jpg") })],
          [],
        ),
      });
      const status = createFxStatus({ quote: quotedStatus, text: "Check this!" });
      mockApi.getPostInformation.mockResolvedValue(createFxResponse(status));

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result?.quote?.media).toHaveLength(1);
      expect(result?.quote?.media[0].type).toBe("photo");
      expect(result?.quote?.media[0].url).toBe(mediaUrl("qt_fb_photo.jpg"));
    });
  });
  describe("Twitter 以外の status の扱い", () => {
    /** 判別子 type は他プラットフォームでも "status" のため、provider で判別する */
    const createBlueskyStatus = () =>
      ({
        ...createFxStatus(),
        provider: "bluesky",
      }) as unknown as TwitterStatus;

    const createTombstone = () =>
      ({
        type: "tombstone",
        provider: "twitter",
        reason: "deleted",
      }) as unknown as TwitterStatus;

    it("provider が twitter でない status は展開しない", async () => {
      mockApi.getPostInformation.mockResolvedValue(createFxResponse(createBlueskyStatus()));

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result).toBeUndefined();
    });

    it("Twitter 以外の provider は想定外として warn で記録する", async () => {
      mockApi.getPostInformation.mockResolvedValue(createFxResponse(createBlueskyStatus()));

      await adapter.fetchTweet("https://x.com/user/status/123");

      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [, meta] = vi.mocked(logger.warn).mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(meta.provider).toBe("bluesky");
    });

    it("tombstone は展開せず、日常的な事象として debug で記録する", async () => {
      mockApi.getPostInformation.mockResolvedValue(createFxResponse(createTombstone()));

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result).toBeUndefined();
      expect(logger.debug).toHaveBeenCalledTimes(1);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("provider を欠く status は展開しない", async () => {
      // 通常は Zod 検証（tests/unit/fxtwitter/generatedSchema.test.ts で固定）で
      // 弾かれる形だが、ガード単体でも拒否することを境界として明示しておく
      const status = createFxStatus();
      delete (status as { provider?: unknown }).provider;
      mockApi.getPostInformation.mockResolvedValue(createFxResponse(status));

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [, meta] = vi.mocked(logger.warn).mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(meta.provider).toBeUndefined();
    });

    it("正常な Twitter status では警告を出さない", async () => {
      mockApi.getPostInformation.mockResolvedValue(createFxResponse(createFxStatus()));

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result).toBeDefined();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("引用が tombstone の場合、本体は展開し引用のみ落とす", async () => {
      const status = createFxStatus({
        text: "Check this!",
        quote: createTombstone() as never,
      });
      mockApi.getPostInformation.mockResolvedValue(createFxResponse(status));

      const result = await adapter.fetchTweet("https://x.com/user/status/123");

      expect(result).toBeDefined();
      expect(result?.text).toBe("Check this!");
      expect(result?.quote).toBeUndefined();
    });
  });
});
