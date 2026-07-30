import { beforeEach, describe, expect, it, vi } from "vitest";

import { ANNOUNCEMENT_DLQ_STREAM_KEY } from "@rx-twitter/shared";

vi.mock("@/db/init", () => ({
  redis: {
    sAdd: vi.fn(),
    sIsMember: vi.fn(),
    expire: vi.fn(),
    incr: vi.fn(),
    del: vi.fn(),
    xAdd: vi.fn(),
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

  describe("isDelivered", () => {
    it("Set にメンバーが存在すれば true を返す", async () => {
      (redis.sIsMember as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      const result = await repo.isDelivered("ann-1", "guild-1");

      expect(result).toBe(true);
      expect(redis.sIsMember).toHaveBeenCalledWith("app:announcement:ann-1:delivered", "guild-1");
    });

    it("Set にメンバーが無ければ false を返す", async () => {
      (redis.sIsMember as ReturnType<typeof vi.fn>).mockResolvedValue(0);
      expect(await repo.isDelivered("ann-1", "guild-2")).toBe(false);
    });
  });

  describe("markDelivered", () => {
    it("Set に guildId を追加し、TTL を設定する", async () => {
      (redis.sAdd as ReturnType<typeof vi.fn>).mockResolvedValue(1);
      (redis.expire as ReturnType<typeof vi.fn>).mockResolvedValue(1);

      await repo.markDelivered("ann-1", "guild-1");

      expect(redis.sAdd).toHaveBeenCalledWith("app:announcement:ann-1:delivered", "guild-1");
      expect(redis.expire).toHaveBeenCalledWith("app:announcement:ann-1:delivered", expect.any(Number));
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

  describe("recordDeadLetter", () => {
    it("DLQ ストリームへ理由・ペイロード・試行回数を XADD する", async () => {
      (redis.xAdd as ReturnType<typeof vi.fn>).mockResolvedValue("1-0");

      await repo.recordDeadLetter({
        streamEntryId: "42-0",
        reason: "invalid JSON",
        payload: "{ broken",
        attempts: 2,
      });

      expect(redis.xAdd).toHaveBeenCalledWith(
        ANNOUNCEMENT_DLQ_STREAM_KEY,
        "*",
        expect.objectContaining({
          streamEntryId: "42-0",
          reason: "invalid JSON",
          payload: "{ broken",
          attempts: "2",
        })
      );
    });

    it("attempts 未指定なら 0 として記録する", async () => {
      (redis.xAdd as ReturnType<typeof vi.fn>).mockResolvedValue("1-0");

      await repo.recordDeadLetter({ streamEntryId: "42-0", reason: "poison", payload: "x" });

      expect(redis.xAdd).toHaveBeenCalledWith(
        ANNOUNCEMENT_DLQ_STREAM_KEY,
        "*",
        expect.objectContaining({ attempts: "0" })
      );
    });
  });
});
