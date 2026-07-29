import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/db/init", () => ({
  redis: {
    sAdd: vi.fn(),
    sRem: vi.fn(),
    expire: vi.fn(),
    incr: vi.fn(),
    del: vi.fn(),
  },
}));

vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { redis } from "@/db/init";
import { RedisAnnouncementRepository } from "@/infrastructure/db/RedisAnnouncementRepository";

describe("RedisAnnouncementRepository", () => {
  let repo: RedisAnnouncementRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new RedisAnnouncementRepository();
  });

  describe("claimGuild", () => {
    it("SADD が新規追加(1)なら claim 成功で true を返し、TTL を設定する", async () => {
      (redis.sAdd as ReturnType<typeof vi.fn>).mockResolvedValue(1);
      (redis.expire as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      const result = await repo.claimGuild("ann-1", "guild-1");

      expect(result).toBe(true);
      expect(redis.sAdd).toHaveBeenCalledWith("app:announcement:ann-1:delivered", "guild-1");
      expect(redis.expire).toHaveBeenCalledWith("app:announcement:ann-1:delivered", expect.any(Number));
    });

    it("SADD が既存(0)なら claim 失敗で false を返す", async () => {
      (redis.sAdd as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      (redis.expire as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      const result = await repo.claimGuild("ann-1", "guild-1");

      expect(result).toBe(false);
    });
  });

  describe("releaseGuild", () => {
    it("Set から guildId を削除する", async () => {
      (redis.sRem as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      await repo.releaseGuild("ann-1", "guild-1");

      expect(redis.sRem).toHaveBeenCalledWith("app:announcement:ann-1:delivered", "guild-1");
    });
  });

  describe("incrementAttempts", () => {
    it("INCR の結果を返し、TTL を設定する", async () => {
      (redis.incr as ReturnType<typeof vi.fn>).mockResolvedValue(3);
      (redis.expire as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      const result = await repo.incrementAttempts("1699999999999-0");

      expect(result).toBe(3);
      expect(redis.incr).toHaveBeenCalledWith("app:announcement:attempts:1699999999999-0");
      expect(redis.expire).toHaveBeenCalledWith("app:announcement:attempts:1699999999999-0", expect.any(Number));
    });
  });

  describe("clearAttempts", () => {
    it("試行回数キーを削除する", async () => {
      (redis.del as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      await repo.clearAttempts("1699999999999-0");

      expect(redis.del).toHaveBeenCalledWith("app:announcement:attempts:1699999999999-0");
    });
  });
});
