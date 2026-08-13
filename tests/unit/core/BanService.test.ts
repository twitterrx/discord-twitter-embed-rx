import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BanEntry, IBanRepository } from "#/core/models/BanEntry.js";
import { BanService } from "#/core/services/BanService.js";

vi.mock("#/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const createMockRepo = (): IBanRepository => ({
  addBan: vi.fn(),
  removeBan: vi.fn(),
  isBanned: vi.fn(),
  listBans: vi.fn(),
  getBan: vi.fn(),
});

const createBanEntry = (overrides: Partial<BanEntry> = {}): BanEntry => ({
  targetId: "target-1",
  targetType: "user",
  reason: "スパム",
  bannedBy: "owner-1",
  bannedAt: "2026-06-12T00:00:00.000Z",
  ...overrides,
});

describe("BanService", () => {
  let mockRepo: IBanRepository;
  let service: BanService;

  beforeEach(() => {
    mockRepo = createMockRepo();
    service = new BanService(mockRepo);
  });

  describe("ban (汎用)", () => {
    it("新規 BAN の場合成功を返す", async () => {
      vi.mocked(mockRepo.isBanned).mockResolvedValue(false);

      const result = await service.ban("user-1", "user", "スパム", "owner-1");

      expect(result.success).toBe(true);
      expect(result.message).toContain("user-1");
      expect(mockRepo.addBan).toHaveBeenCalledWith(
        expect.objectContaining({
          targetId: "user-1",
          targetType: "user",
          reason: "スパム",
          bannedBy: "owner-1",
        }),
      );
    });

    it("既に BAN 済みの場合失敗を返す", async () => {
      vi.mocked(mockRepo.isBanned).mockResolvedValue(true);

      const result = await service.ban("user-1", "user", "スパム", "owner-1");

      expect(result.success).toBe(false);
      expect(result.message).toContain("既に BAN");
      expect(mockRepo.addBan).not.toHaveBeenCalled();
    });

    it("ban された日時が ISO 8601 形式である", async () => {
      vi.mocked(mockRepo.isBanned).mockResolvedValue(false);

      await service.ban("user-1", "user", "test", "owner-1");

      expect(mockRepo.addBan).toHaveBeenCalledWith(
        expect.objectContaining({
          bannedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        }),
      );
    });
  });

  describe("banUser", () => {
    it("ユーザー BAN に成功する", async () => {
      vi.mocked(mockRepo.isBanned).mockResolvedValue(false);

      const result = await service.banUser("user-1", "スパム", "owner-1");

      expect(result.success).toBe(true);
      expect(result.message).toContain("ユーザー");
      expect(mockRepo.addBan).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: "user-1", targetType: "user" }),
      );
    });
  });

  describe("banGuild", () => {
    it("サーバー BAN に成功する", async () => {
      vi.mocked(mockRepo.isBanned).mockResolvedValue(false);

      const result = await service.banGuild("guild-1", "スパム", "owner-1");

      expect(result.success).toBe(true);
      expect(result.message).toContain("サーバー");
      expect(mockRepo.addBan).toHaveBeenCalledWith(
        expect.objectContaining({ targetId: "guild-1", targetType: "guild" }),
      );
    });
  });

  describe("unban (汎用)", () => {
    it("BAN 済みの場合解除に成功する", async () => {
      vi.mocked(mockRepo.isBanned).mockResolvedValue(true);

      const result = await service.unban("user-1", "user");

      expect(result.success).toBe(true);
      expect(result.message).toContain("解除");
      expect(mockRepo.removeBan).toHaveBeenCalledWith("user-1", "user");
    });

    it("BAN されていない場合失敗を返す", async () => {
      vi.mocked(mockRepo.isBanned).mockResolvedValue(false);

      const result = await service.unban("user-1", "user");

      expect(result.success).toBe(false);
      expect(result.message).toContain("BAN されていません");
      expect(mockRepo.removeBan).not.toHaveBeenCalled();
    });
  });

  describe("unbanUser / unbanGuild", () => {
    it("unbanUser が正しく委譲する", async () => {
      vi.mocked(mockRepo.isBanned).mockResolvedValue(true);

      await service.unbanUser("user-1");

      expect(mockRepo.removeBan).toHaveBeenCalledWith("user-1", "user");
    });

    it("unbanGuild が正しく委譲する", async () => {
      vi.mocked(mockRepo.isBanned).mockResolvedValue(true);

      await service.unbanGuild("guild-1");

      expect(mockRepo.removeBan).toHaveBeenCalledWith("guild-1", "guild");
    });
  });

  describe("isUserBanned", () => {
    it("BAN されている場合 true を返す", async () => {
      vi.mocked(mockRepo.isBanned).mockResolvedValue(true);

      const result = await service.isUserBanned("user-1");

      expect(result).toBe(true);
      expect(mockRepo.isBanned).toHaveBeenCalledWith("user-1", "user");
    });

    it("BAN されていない場合 false を返す", async () => {
      vi.mocked(mockRepo.isBanned).mockResolvedValue(false);

      const result = await service.isUserBanned("user-1");

      expect(result).toBe(false);
    });
  });

  describe("isGuildBanned", () => {
    it("BAN されている場合 true を返す", async () => {
      vi.mocked(mockRepo.isBanned).mockResolvedValue(true);

      const result = await service.isGuildBanned("guild-1");

      expect(result).toBe(true);
      expect(mockRepo.isBanned).toHaveBeenCalledWith("guild-1", "guild");
    });
  });

  describe("listBans", () => {
    it("全 BAN エントリを返す", async () => {
      const entries = [
        createBanEntry(),
        createBanEntry({ targetId: "guild-1", targetType: "guild" }),
      ];
      vi.mocked(mockRepo.listBans).mockResolvedValue(entries);

      const result = await service.listBans();

      expect(result).toEqual(entries);
    });

    it("targetType でフィルタする", async () => {
      const userEntries = [
        createBanEntry({ targetId: "user-1", targetType: "user" }),
      ];
      vi.mocked(mockRepo.listBans).mockResolvedValue(userEntries);

      const result = await service.listBans("user");

      expect(mockRepo.listBans).toHaveBeenCalledWith("user");
      expect(result).toEqual(userEntries);
    });

    it("空の配列を返す", async () => {
      vi.mocked(mockRepo.listBans).mockResolvedValue([]);

      const result = await service.listBans();

      expect(result).toEqual([]);
    });
  });

  describe("getBan", () => {
    it("BAN 情報を返す", async () => {
      const entry = createBanEntry();
      vi.mocked(mockRepo.getBan).mockResolvedValue(entry);

      const result = await service.getBan("user-1", "user");

      expect(result).toEqual(entry);
      expect(mockRepo.getBan).toHaveBeenCalledWith("user-1", "user");
    });

    it("BAN されていない場合 null を返す", async () => {
      vi.mocked(mockRepo.getBan).mockResolvedValue(null);

      const result = await service.getBan("user-999", "user");

      expect(result).toBeNull();
    });
  });
});
