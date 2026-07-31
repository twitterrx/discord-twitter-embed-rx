import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { resolveFallbackPolicies } from "@/config/fallbackPolicy";
import logger from "@/utils/logger";

describe("resolveFallbackPolicies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("未設定なら両方とも allow", () => {
    expect(resolveFallbackPolicies({})).toEqual({
      redisDown: "allow",
      configNotFound: "allow",
    });
  });

  it("空文字は未設定として扱う", () => {
    expect(resolveFallbackPolicies({ REDIS_DOWN_FALLBACK: "" })).toEqual({
      redisDown: "allow",
      configNotFound: "allow",
    });
  });

  it("deny を明示した場合のみ deny になる", () => {
    expect(
      resolveFallbackPolicies({
        REDIS_DOWN_FALLBACK: "deny",
        CONFIG_NOT_FOUND_FALLBACK: "deny",
      }),
    ).toEqual({ redisDown: "deny", configNotFound: "deny" });
  });

  it("2つの変数は独立して解釈される", () => {
    expect(
      resolveFallbackPolicies({ CONFIG_NOT_FOUND_FALLBACK: "deny" }),
    ).toEqual({ redisDown: "allow", configNotFound: "deny" });
  });

  it("大文字・前後空白を正規化する", () => {
    expect(
      resolveFallbackPolicies({
        REDIS_DOWN_FALLBACK: " DENY ",
        CONFIG_NOT_FOUND_FALLBACK: "Allow",
      }),
    ).toEqual({ redisDown: "deny", configNotFound: "allow" });
  });

  it("正規化できた値では警告を出さない", () => {
    resolveFallbackPolicies({ REDIS_DOWN_FALLBACK: " DENY " });

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("解釈できない値は既定の allow に倒す", () => {
    expect(resolveFallbackPolicies({ REDIS_DOWN_FALLBACK: "maybe" })).toEqual({
      redisDown: "allow",
      configNotFound: "allow",
    });
  });

  it("解釈できない値を変数名と実際の値つきで警告する", () => {
    resolveFallbackPolicies({ REDIS_DOWN_FALLBACK: "maybe" });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message] = vi.mocked(logger.warn).mock.calls[0] as unknown as [string];
    expect(message).toContain("REDIS_DOWN_FALLBACK");
    expect(message).toContain("maybe");
  });

  it("引数を省略した場合は process.env を読む", () => {
    vi.stubEnv("REDIS_DOWN_FALLBACK", "deny");

    expect(resolveFallbackPolicies().redisDown).toBe("deny");

    vi.unstubAllEnvs();
  });
});
