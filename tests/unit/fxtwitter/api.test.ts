import { beforeEach, describe, expect, it, vi } from "vitest";

import { FxTwitterApi } from "#/fxtwitter/api.js";
import { SocialThread } from "#/fxtwitter/generated/model/index.js";
import { HttpResponseError, ResponseContentTypeError } from "#/infrastructure/http/orvalFetch.js";

vi.mock("#/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("#/fxtwitter/generated/default.js", () => ({
  get2StatusId: vi.fn(),
}));

import { get2StatusId } from "#/fxtwitter/generated/default.js";
import logger from "#/utils/logger.js";

const mockGet2StatusId = vi.mocked(get2StatusId);

// SocialThread は zod スキーマ（値）と入力型の両方が同名で export されている。
// ここで欲しいのは型のほうなので、型位置の SocialThread をそのまま使う。
// 中身は safeParse をモックするため最小限の部分データで足りる。
const validThread = {
  code: 200,
  status: { type: "status", text: "hello" },
} as unknown as SocialThread;

describe("FxTwitterApi", () => {
  let api: FxTwitterApi;

  beforeEach(() => {
    api = new FxTwitterApi();
    vi.clearAllMocks();
    vi.spyOn(SocialThread, "safeParse").mockReturnValue({
      success: true,
      data: validThread,
    } as never);
  });

  it("正常なレスポンスを検証して返す", async () => {
    mockGet2StatusId.mockResolvedValue(validThread as never);

    const result = await api.getPostInformation("https://x.com/user/status/123");

    expect(result).toBeDefined();
    expect(mockGet2StatusId).toHaveBeenCalledWith("123");
  });

  it("404 は undefined を返す", async () => {
    mockGet2StatusId.mockRejectedValue(new HttpResponseError(404, "Not Found", "https://api.fxtwitter.com"));

    const result = await api.getPostInformation("https://x.com/user/status/123");

    expect(result).toBeUndefined();
  });

  it("検証に失敗したレスポンスは undefined を返す", async () => {
    vi.spyOn(SocialThread, "safeParse").mockReturnValue({ success: false, error: { issues: [] } } as never);
    mockGet2StatusId.mockResolvedValue({ code: 200 } as never);

    const result = await api.getPostInformation("https://x.com/user/status/123");

    expect(result).toBeUndefined();
  });

  describe("検証失敗のログ", () => {
    /**
     * status は 6 ブランチの plain union なので、素の issues では全ブランチ分が並んで
     * 原因が埋もれる。type / provider から絞った issue が記録されることを固定する。
     */
    const invalidTwitterStatus = {
      code: 200,
      // id を欠く Twitter status
      status: {
        type: "status",
        provider: "twitter",
        url: "https://x.com/u/status/123",
        text: "hello",
        created_at: "2024-01-01T00:00:00.000Z",
        likes: 1,
        reposts: 1,
        replies: 1,
        author: { type: "profile", id: "u", name: "U", screen_name: "u", avatar_url: null },
        media: {},
      },
    };

    const errorMeta = async () => {
      // 実スキーマで落とすため safeParse のモックを外す
      vi.mocked(SocialThread.safeParse).mockRestore();
      mockGet2StatusId.mockResolvedValue(invalidTwitterStatus as never);

      await api.getPostInformation("https://x.com/user/status/123");

      const [, meta] = vi.mocked(logger.error).mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      return meta;
    };

    it("該当ブランチの issue に絞って記録する", async () => {
      const meta = await errorMeta();

      expect(meta.issues).toHaveLength(1);
      expect(JSON.stringify(meta.issues)).toContain('"id"');
    });

    it("判別に使った type と provider を添える", async () => {
      const meta = await errorMeta();

      expect(meta.type).toBe("status");
      expect(meta.provider).toBe("twitter");
    });
  });

  it("id を抽出できない URL は undefined を返す", async () => {
    const result = await api.getPostInformation("https://example.com/foo/bar");

    expect(result).toBeUndefined();
    expect(mockGet2StatusId).not.toHaveBeenCalled();
  });

  it("通信エラー時は undefined を返す", async () => {
    mockGet2StatusId.mockRejectedValue(new Error("network error"));

    const result = await api.getPostInformation("https://x.com/user/status/123");

    expect(result).toBeUndefined();
  });
  describe("JSON 以外のレスポンス", () => {
    const contentTypeError = () =>
      new ResponseContentTypeError(
        "text/html; charset=utf-8",
        "https://api.fxtwitter.com/2/status/123",
      );

    it("undefined を返す", async () => {
      mockGet2StatusId.mockRejectedValue(contentTypeError());

      const result = await api.getPostInformation("https://x.com/user/status/123");

      expect(result).toBeUndefined();
    });

    it("error ではなく warn で記録する", async () => {
      mockGet2StatusId.mockRejectedValue(contentTypeError());

      await api.getPostInformation("https://x.com/user/status/123");

      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it("フォールバックの有無に言及しない文言で記録する", async () => {
      mockGet2StatusId.mockRejectedValue(contentTypeError());

      await api.getPostInformation("https://x.com/user/status/123");

      // このクラスは自身がフォールバック連鎖のどこにいるか知らない。
      // 後続が実行されると読める文言を残さないことを固定する。
      const [message] = vi.mocked(logger.warn).mock.calls[0] as unknown as [string];
      expect(message).toBe("FxTwitterApi: Non-JSON response received");
      expect(message).not.toMatch(/fallback/i);
    });

    it("content-type を含め、スタックトレースは含めない", async () => {
      mockGet2StatusId.mockRejectedValue(contentTypeError());

      await api.getPostInformation("https://x.com/user/status/123");

      // logger.warn は winston の (infoObject) overload に解決されるため、
      // 実際の呼び出し形（message, meta）へ明示的に読み替える
      const [, meta] = vi.mocked(logger.warn).mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(meta.contentType).toBe("text/html; charset=utf-8");
      expect(meta).not.toHaveProperty("stack");
    });
  });
});
