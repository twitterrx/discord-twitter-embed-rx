import { describe, expect, it } from "vitest";

import { SocialThread } from "@/fxtwitter/generated/model";

describe("SocialThread schema", () => {
  it("nullable な status と author を受理する", () => {
    const result = SocialThread.safeParse({
      code: 200,
      status: null,
      thread: null,
      author: null,
    });

    expect(result.success).toBe(true);
  });

  it("必須フィールドが欠けた Twitter status を拒否する", () => {
    const result = SocialThread.safeParse({
      code: 200,
      status: { type: "status" },
      thread: null,
      author: null,
    });

    expect(result.success).toBe(false);
  });
  /**
   * 仕様上のすべての必須フィールドを満たす status。
   * ここから1つだけ落とすことで、失敗の原因を特定できる形にする。
   */
  const createValidStatus = () => ({
    type: "status",
    id: "123",
    url: "https://x.com/u/status/123",
    text: "hello",
    created_at: "2024-01-01T00:00:00.000Z",
    created_timestamp: 1704067200,
    likes: 1,
    reposts: 1,
    quotes: 1,
    replies: 1,
    author: {
      type: "profile",
      id: "u",
      name: "U",
      screen_name: "u",
      avatar_url: null,
      banner_url: null,
      description: "",
      raw_description: { text: "", facets: [] },
      location: "",
      url: "https://x.com/u",
      protected: false,
      followers: 0,
      following: 0,
      statuses: 0,
      media_count: 0,
      likes: 0,
      joined: "2020-01-01T00:00:00.000Z",
      website: null,
    },
    media: {},
    raw_text: { text: "hello", display_text_range: [0, 5], facets: [] },
    lang: "en",
    possibly_sensitive: false,
    replying_to: null,
    source: "Twitter Web App",
    embed_card: "tweet",
    provider: "twitter",
    is_note_tweet: false,
    community_note: null,
    reposted_by: null,
  });

  const wrap = (status: unknown) => ({ code: 200, status, thread: null, author: null });

  const parseWithout = (...fields: string[]) => {
    const status = createValidStatus() as Record<string, unknown>;
    for (const field of fields) {
      delete status[field];
    }
    return SocialThread.safeParse(wrap(status));
  };

  it("前提: 完全な status は受理される", () => {
    // この土台が通らないと、以降の失敗が個々のフィールド由来だと言えない
    expect(SocialThread.safeParse(wrap(createValidStatus())).success).toBe(true);
  });

  describe("provider の欠落", () => {
    it("provider を欠く status を拒否する", () => {
      expect(parseWithout("provider").success).toBe(false);
    });

    it("拒否の理由として provider を報告する", () => {
      // 別のフィールド起因で落ちていないことを確かめる
      const paths = JSON.stringify(parseWithout("provider").error?.issues ?? []);
      expect(paths).toContain("provider");
    });
  });

  describe("type の欠落", () => {
    /**
     * type と provider の組が plain union のブランチ選択を一意にしている。
     * ここが緩むと誤ったブランチで通ってしまうため、必須のまま維持する。
     */
    it("type を欠く status を拒否する", () => {
      expect(parseWithout("type").success).toBe(false);
    });

    it("拒否の理由として type を報告する", () => {
      const paths = JSON.stringify(parseWithout("type").error?.issues ?? []);
      expect(paths).toContain("type");
    });
  });

  /**
   * 上流 FxEmbed は possibly_sensitive を必須と宣言しているが、Twitter GraphQL の
   * legacy.possibly_sensitive が無いと undefined 代入でキーごと消える。
   * 自コードでは読んでいないフィールドなので、欠落で Embed 全体を落としてはいけない。
   */
  describe("読んでいないフィールドの欠落は受理する", () => {
    const UNUSED_FIELDS = [
      "possibly_sensitive",
      "created_timestamp",
      "quotes",
      "raw_text",
      "lang",
      "replying_to",
      "source",
      "embed_card",
      "is_note_tweet",
      "community_note",
      "reposted_by",
    ];

    it.each(UNUSED_FIELDS)("%s を欠く status を受理する", (field) => {
      const result = parseWithout(field);

      expect(result.error?.issues ?? []).toEqual([]);
      expect(result.success).toBe(true);
    });

    it("読んでいないフィールドをすべて欠いても受理する", () => {
      const result = parseWithout(...UNUSED_FIELDS);

      expect(result.error?.issues ?? []).toEqual([]);
      expect(result.success).toBe(true);
    });

    /**
     * media は読んでいるが、convertToTweet が fxData.media?.all と optional chaining で
     * 読んでおりコード側が既に不在を許容している。スキーマだけ厳しくしても意味がない。
     */
    it("media を欠く status を受理する", () => {
      const result = parseWithout("media");

      expect(result.error?.issues ?? []).toEqual([]);
      expect(result.success).toBe(true);
    });
  });

  describe("author は読んでいるフィールドだけ必須", () => {
    const parseWithAuthorWithout = (...fields: string[]) => {
      const status = createValidStatus();
      const author = status.author as Record<string, unknown>;
      for (const field of fields) {
        delete author[field];
      }
      return SocialThread.safeParse(wrap(status));
    };

    it.each(["banner_url", "description", "raw_description", "location", "url", "protected", "followers", "following", "statuses", "media_count", "likes", "joined", "website"])(
      "author.%s を欠いても受理する",
      (field) => {
        expect(parseWithAuthorWithout(field).success).toBe(true);
      }
    );

    it.each(["type", "id", "name", "screen_name", "avatar_url"])(
      "author.%s を欠く status は拒否する",
      (field) => {
        expect(parseWithAuthorWithout(field).success).toBe(false);
      }
    );
  });

  /**
   * 実レスポンスでは media.videos[].publisher / media.all[].publisher が null になる。
   * orval が allOf + nullable の nullable を落としていたため、動画ツイートが全滅していた。
   */
  describe("media の publisher が null", () => {
    const createVideoMedia = () => ({
      type: "video" as const,
      url: "https://video.twimg.com/v.mp4",
      width: 1280,
      height: 720,
      duration: 10,
      formats: [{ url: "https://video.twimg.com/v.mp4" }],
      publisher: null,
    });

    it("publisher が null の動画を受理する", () => {
      const status = createValidStatus();
      const result = SocialThread.safeParse(
        wrap({
          ...status,
          media: { all: [createVideoMedia()], videos: [createVideoMedia()] },
        })
      );

      expect(result.error?.issues ?? []).toEqual([]);
      expect(result.success).toBe(true);
    });
  });

  describe("tombstone", () => {
    /**
     * isTombstone は type しか見ていない。reason / message が増減しただけで
     * 検証全体が落ちるのは損なので、type 以外は必須にしない。
     */
    it("type だけの tombstone を受理する", () => {
      const result = SocialThread.safeParse(wrap({ type: "tombstone" }));

      expect(result.error?.issues ?? []).toEqual([]);
      expect(result.success).toBe(true);
    });

    it("未知の reason を持つ tombstone を受理する", () => {
      const result = SocialThread.safeParse(
        wrap({ type: "tombstone", provider: "twitter", reason: "brand_new_reason", message: "x" })
      );

      expect(result.error?.issues ?? []).toEqual([]);
      expect(result.success).toBe(true);
    });
  });
});
