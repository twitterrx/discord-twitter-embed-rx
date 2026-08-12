import { describe, expect, it } from "vitest";

import { SocialThread } from "#/fxtwitter/generated/model/index.js";
import { describeSocialThreadFailure } from "#/fxtwitter/statusValidationError.js";

/**
 * 検証失敗の診断。union 6 ブランチ分の issue に埋もれず、原因フィールドが分かることを担保する。
 */
describe("describeSocialThreadFailure", () => {
  const createValidStatus = () => ({
    type: "status",
    provider: "twitter",
    id: "123",
    url: "https://x.com/u/status/123",
    text: "hello",
    created_at: "2024-01-01T00:00:00.000Z",
    likes: 1,
    reposts: 1,
    replies: 1,
    author: {
      type: "profile",
      id: "u",
      name: "U",
      screen_name: "u",
      avatar_url: null,
    },
    media: {},
  });

  const describeFailureOf = (data: unknown) => {
    const parsed = SocialThread.safeParse(data);
    if (parsed.success) {
      throw new Error("検証が成功してしまった。テストの前提が崩れている");
    }
    return { failure: describeSocialThreadFailure(data, parsed.error), unionIssues: parsed.error.issues };
  };

  it("前提: 完全な status は受理される", () => {
    expect(SocialThread.safeParse({ status: createValidStatus() }).success).toBe(true);
  });

  describe("provider から Twitter ブランチを特定できる場合", () => {
    const missingId = () => {
      const status = createValidStatus() as Record<string, unknown>;
      delete status.id;
      return { status };
    };

    it("該当ブランチの issue だけを返す", () => {
      const { failure } = describeFailureOf(missingId());

      expect(failure.issues).toHaveLength(1);
      expect(failure.issues[0]?.path).toEqual(["status", "id"]);
    });

    it("union 全体より issue が少ない", () => {
      const { failure, unionIssues } = describeFailureOf(missingId());

      // union は 6 ブランチ分をまとめて 1 件の invalid_union にする。
      // その中身と比べて、絞り込めていることを示す
      expect(JSON.stringify(failure.issues).length).toBeLessThan(JSON.stringify(unionIssues).length);
    });

    it("type と provider を添える", () => {
      const { failure } = describeFailureOf(missingId());

      expect(failure.type).toBe("status");
      expect(failure.provider).toBe("twitter");
    });
  });

  it("tombstone は tombstone ブランチの issue を返す", () => {
    const { failure } = describeFailureOf({ status: { type: "tombstone", id: 123 } });

    expect(failure.type).toBe("tombstone");
    expect(failure.issues).toHaveLength(1);
    expect(failure.issues[0]?.path).toEqual(["status", "id"]);
  });

  describe("ブランチを特定できない場合", () => {
    it("provider を欠くときは union 全体の issue にフォールバックする", () => {
      const status = createValidStatus() as Record<string, unknown>;
      delete status.provider;

      const { failure, unionIssues } = describeFailureOf({ status });

      expect(failure.issues).toEqual(unionIssues);
      expect(failure.provider).toBeUndefined();
    });

    it("未知の provider のときも union 全体の issue にフォールバックする", () => {
      const { failure, unionIssues } = describeFailureOf({
        status: { ...createValidStatus(), provider: "unknown_service" },
      });

      expect(failure.issues).toEqual(unionIssues);
      expect(failure.provider).toBe("unknown_service");
    });

    it("status がオブジェクトでないときも union 全体の issue にフォールバックする", () => {
      const { failure, unionIssues } = describeFailureOf({ status: "not an object" });

      expect(failure.issues).toEqual(unionIssues);
      expect(failure.type).toBeUndefined();
    });
  });

  it("status は通るが別の場所で落ちているときは union 全体の issue を返す", () => {
    // thread の要素側で落とす。status に原因があると誤報告しないこと
    const { failure, unionIssues } = describeFailureOf({
      status: createValidStatus(),
      thread: [{ type: "status", provider: "twitter" }],
    });

    expect(failure.issues).toEqual(unionIssues);
  });
});
