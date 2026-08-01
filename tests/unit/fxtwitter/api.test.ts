import { beforeEach, describe, expect, it, vi } from "vitest";

import { FxTwitterApi } from "@/fxtwitter/api";
import { SocialThread } from "@/fxtwitter/generated/model";
import { HttpResponseError, ResponseContentTypeError } from "@/infrastructure/http/orvalFetch";

vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/fxtwitter/generated/default", () => ({
  get2StatusId: vi.fn(),
}));

import { get2StatusId } from "@/fxtwitter/generated/default";
import logger from "@/utils/logger";

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
