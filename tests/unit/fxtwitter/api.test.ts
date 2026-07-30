import { beforeEach, describe, expect, it, vi } from "vitest";

import { FxTwitterApi } from "@/fxtwitter/api";
import { SocialThread } from "@/fxtwitter/generated/model";
import { HttpResponseError } from "@/infrastructure/http/orvalFetch";

vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/fxtwitter/generated/default", () => ({
  get2StatusId: vi.fn(),
}));

import { get2StatusId } from "@/fxtwitter/generated/default";

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
});
