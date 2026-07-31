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
  describe("provider の欠落", () => {
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

    it("前提: 完全な status は受理される", () => {
      // この土台が通らないと、以降の失敗が provider 由来だと言えない
      expect(SocialThread.safeParse(wrap(createValidStatus())).success).toBe(true);
    });

    it("provider を欠く status を拒否する", () => {
      const status = createValidStatus();
      delete (status as { provider?: unknown }).provider;

      const result = SocialThread.safeParse(wrap(status));

      expect(result.success).toBe(false);
    });

    it("拒否の理由として provider を報告する", () => {
      const status = createValidStatus();
      delete (status as { provider?: unknown }).provider;

      const result = SocialThread.safeParse(wrap(status));

      // 別のフィールド起因で落ちていないことを確かめる
      const paths = JSON.stringify(result.error?.issues ?? []);
      expect(paths).toContain("provider");
    });
  });
});
