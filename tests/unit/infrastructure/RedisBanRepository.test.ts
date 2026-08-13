import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BanEntry } from "#/core/models/BanEntry.js";

vi.mock("#/db/init.js", () => ({
  redis: {
    sAdd: vi.fn(),
    sRem: vi.fn(),
    sIsMember: vi.fn(),
    sMembers: vi.fn(),
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
  },
}));

vi.mock("#/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { redis } from "#/db/init.js";
import { RedisBanRepository } from "#/infrastructure/db/RedisBanRepository.js";

const makeUserEntry = (overrides: Partial<BanEntry> = {}): BanEntry => ({
  targetId: "user-1",
  targetType: "user",
  reason: "スパム",
  bannedBy: "owner-1",
  bannedAt: "2026-06-12T00:00:00.000Z",
  ...overrides,
});

const makeGuildEntry = (overrides: Partial<BanEntry> = {}): BanEntry => ({
  targetId: "guild-1",
  targetType: "guild",
  reason: "迷惑",
  bannedBy: "owner-1",
  bannedAt: "2026-06-12T00:00:00.000Z",
  ...overrides,
});

describe("RedisBanRepository", () => {
  let repo: RedisBanRepository;

  beforeEach(() => {
    repo = new RedisBanRepository();
    vi.clearAllMocks();
  });

  describe("addBan", () => {
    it("ユーザー BAN: Set と JSON キーを保存する", async () => {
      const entry = makeUserEntry();

      await repo.addBan(entry);

      expect(redis.sAdd).toHaveBeenCalledWith("app:ban:list", "user:user-1");
      expect(redis.set).toHaveBeenCalledWith(
        "app:ban:user:user-1",
        JSON.stringify(entry),
      );
    });

    it("サーバー BAN: Set と JSON キーを保存する", async () => {
      const entry = makeGuildEntry();

      await repo.addBan(entry);

      expect(redis.sAdd).toHaveBeenCalledWith("app:ban:list", "guild:guild-1");
      expect(redis.set).toHaveBeenCalledWith(
        "app:ban:guild:guild-1",
        JSON.stringify(entry),
      );
    });
  });

  describe("removeBan", () => {
    it("ユーザー BAN 解除", async () => {
      await repo.removeBan("user-1", "user");

      expect(redis.sRem).toHaveBeenCalledWith("app:ban:list", "user:user-1");
      expect(redis.del).toHaveBeenCalledWith("app:ban:user:user-1");
    });

    it("サーバー BAN 解除", async () => {
      await repo.removeBan("guild-1", "guild");

      expect(redis.sRem).toHaveBeenCalledWith("app:ban:list", "guild:guild-1");
      expect(redis.del).toHaveBeenCalledWith("app:ban:guild:guild-1");
    });
  });

  describe("isBanned", () => {
    it("ユーザー BAN: sIsMember が 1 なら true", async () => {
      vi.mocked(redis.sIsMember).mockResolvedValue(1);

      const result = await repo.isBanned("user-1", "user");

      expect(result).toBe(true);
      expect(redis.sIsMember).toHaveBeenCalledWith("app:ban:list", "user:user-1");
    });

    it("サーバー BAN: sIsMember が 0 なら false", async () => {
      vi.mocked(redis.sIsMember).mockResolvedValue(0);

      const result = await repo.isBanned("guild-1", "guild");

      expect(result).toBe(false);
    });
  });

  describe("listBans", () => {
    it("全 BAN エントリを返す", async () => {
      const userEntry = makeUserEntry();
      const guildEntry = makeGuildEntry();
      vi.mocked(redis.sMembers).mockResolvedValue(["user:user-1", "guild:guild-1"]);
      vi.mocked(redis.get)
        .mockResolvedValueOnce(JSON.stringify(userEntry))
        .mockResolvedValueOnce(JSON.stringify(guildEntry));

      const result = await repo.listBans();

      expect(result).toHaveLength(2);
    });

    it("targetType でフィルタして返す", async () => {
      const userEntry = makeUserEntry();
      vi.mocked(redis.sMembers).mockResolvedValue(["user:user-1", "guild:guild-1"]);
      vi.mocked(redis.get).mockResolvedValueOnce(JSON.stringify(userEntry));

      const result = await repo.listBans("user");

      expect(result).toHaveLength(1);
      expect(result[0].targetType).toBe("user");
    });

    it("BAN がない場合空の配列を返す", async () => {
      vi.mocked(redis.sMembers).mockResolvedValue([]);

      const result = await repo.listBans();

      expect(result).toEqual([]);
    });

    it("JSON パースに失敗したエントリをスキップする", async () => {
      vi.mocked(redis.sMembers).mockResolvedValue(["user:user-1", "guild:guild-1"]);
      vi.mocked(redis.get)
        .mockResolvedValueOnce(JSON.stringify(makeUserEntry()))
        .mockResolvedValueOnce("invalid-json{{{");

      const result = await repo.listBans();

      expect(result).toHaveLength(1);
      expect(result[0].targetId).toBe("user-1");
    });
  });

  describe("getBan", () => {
    it("存在するエントリを返す（ユーザー）", async () => {
      const entry = makeUserEntry();
      vi.mocked(redis.get).mockResolvedValue(JSON.stringify(entry));

      const result = await repo.getBan("user-1", "user");

      expect(result).toEqual(entry);
      expect(redis.get).toHaveBeenCalledWith("app:ban:user:user-1");
    });

    it("存在するエントリを返す（サーバー）", async () => {
      const entry = makeGuildEntry();
      vi.mocked(redis.get).mockResolvedValue(JSON.stringify(entry));

      const result = await repo.getBan("guild-1", "guild");

      expect(result).toEqual(entry);
      expect(redis.get).toHaveBeenCalledWith("app:ban:guild:guild-1");
    });

    it("存在しない場合 null を返す", async () => {
      vi.mocked(redis.get).mockResolvedValue(null);

      const result = await repo.getBan("user-999", "user");

      expect(result).toBeNull();
    });
  });
});
