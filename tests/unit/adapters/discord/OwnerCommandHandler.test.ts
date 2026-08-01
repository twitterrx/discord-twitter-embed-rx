import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { Message } from "discord.js";
import { OwnerCommandHandler } from "@/adapters/discord/OwnerCommandHandler";
import type { ChannelConfigService } from "@/core/services/ChannelConfigService";
import { BanService } from "@/core/services/BanService";

// Collection ライクな Map（.map() / .filter() / .size を生やす）
class MockCollection<K, V> extends Map<K, V> {
  map<T>(fn: (value: V, key: K) => T): T[] {
    const result: T[] = [];
    for (const [key, value] of this.entries()) {
      result.push(fn(value, key));
    }
    return result;
  }

  filter(fn: (value: V, key: K) => boolean): MockCollection<K, V> {
    const result = new MockCollection<K, V>();
    for (const [key, value] of this.entries()) {
      if (fn(value, key)) result.set(key, value);
    }
    return result;
  }
}

interface MockGuild {
  id: string;
  name: string;
  memberCount?: number;
  leave: ReturnType<typeof vi.fn>;
}

interface MockClient {
  user: { id: string };
  guilds: {
    cache: MockCollection<string, MockGuild>;
  };
}

const createMockClient = (): MockClient => ({
  user: { id: "bot-id" },
  guilds: {
    cache: new MockCollection<string, MockGuild>(),
  },
});

const createMockMessage = (overrides: Record<string, unknown> = {}): Message<boolean> =>
  ({
    author: { bot: false, id: "owner-id" },
    guildId: null, // DM
    content: "",
    reply: vi.fn().mockResolvedValue({ id: "reply-id" }),
    ...overrides,
  }) as unknown as Message<boolean>;

describe("OwnerCommandHandler", () => {
  let mockBanService: BanService;
  let mockClient: MockClient;
  let mockChannelConfigService: ChannelConfigService;
  let handler: OwnerCommandHandler;

  const OWNER_ID = "owner-id";

  beforeEach(() => {
    mockBanService = {
      banUser: vi.fn(),
      banGuild: vi.fn(),
      unbanUser: vi.fn(),
      unbanGuild: vi.fn(),
      ban: vi.fn(),
      unban: vi.fn(),
      isUserBanned: vi.fn(),
      isGuildBanned: vi.fn(),
      listBans: vi.fn(),
      getBan: vi.fn(),
    } as unknown as BanService;

    mockClient = createMockClient();
    mockChannelConfigService = {
      getEmbedVersion: vi.fn().mockResolvedValue("v2"),
    } as unknown as ChannelConfigService;
    handler = new OwnerCommandHandler(
      OWNER_ID,
      mockBanService,
      mockClient as unknown as ConstructorParameters<typeof OwnerCommandHandler>[2],
      mockChannelConfigService,
    );
  });

  describe("handleMessage - ガード条件", () => {
    it("ギルドメッセージは無視する", async () => {
      const msg = createMockMessage({ guildId: "guild-1" });
      const result = await handler.handleMessage(msg);
      expect(result).toBe(false);
      expect(msg.reply).not.toHaveBeenCalled();
    });

    it("Owner 以外のユーザーからの DM は無視する", async () => {
      const msg = createMockMessage({ author: { bot: false, id: "other-user" } });
      const result = await handler.handleMessage(msg);
      expect(result).toBe(false);
      expect(msg.reply).not.toHaveBeenCalled();
    });

    it("Bot メッセージは無視する", async () => {
      const msg = createMockMessage({ author: { bot: true, id: OWNER_ID } });
      const result = await handler.handleMessage(msg);
      expect(result).toBe(false);
      expect(msg.reply).not.toHaveBeenCalled();
    });

    it("プレフィックスが一致しないメッセージは無視する", async () => {
      const msg = createMockMessage({ content: "!guilds" });
      const result = await handler.handleMessage(msg);
      expect(result).toBe(false);
      expect(msg.reply).not.toHaveBeenCalled();
    });
  });

  describe("!owner/ban (ユーザー BAN)", () => {
    it("userId なしで使用法を返す", async () => {
      const msg = createMockMessage({ content: "!owner/ban" });
      const result = await handler.handleMessage(msg);
      expect(result).toBe(true);
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("使用方法"));
    });

    it("ユーザー BAN に成功する", async () => {
      const msg = createMockMessage({ content: "!owner/ban user-1 spamming" });
      vi.mocked(mockBanService.banUser).mockResolvedValue({
        success: true,
        message: "ユーザー user-1 を BAN しました。",
      });

      const result = await handler.handleMessage(msg);

      expect(result).toBe(true);
      expect(mockBanService.banUser).toHaveBeenCalledWith("user-1", "spamming", OWNER_ID);
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("BAN しました"));
    });

    it("既に BAN 済みの場合失敗メッセージを返す", async () => {
      const msg = createMockMessage({ content: "!owner/ban user-1 spam" });
      vi.mocked(mockBanService.banUser).mockResolvedValue({
        success: false,
        message: "既に BAN されています。",
      });

      const result = await handler.handleMessage(msg);
      expect(result).toBe(true);
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("既に BAN"));
    });
  });

  describe("!owner/unban (ユーザー BAN 解除)", () => {
    it("userId なしで使用法を返す", async () => {
      const msg = createMockMessage({ content: "!owner/unban" });
      const result = await handler.handleMessage(msg);
      expect(result).toBe(true);
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("使用方法"));
    });

    it("ユーザー BAN 解除に成功する", async () => {
      const msg = createMockMessage({ content: "!owner/unban user-1" });
      vi.mocked(mockBanService.unbanUser).mockResolvedValue({
        success: true,
        message: "ユーザー user-1 の BAN を解除しました。",
      });

      const result = await handler.handleMessage(msg);
      expect(result).toBe(true);
      expect(mockBanService.unbanUser).toHaveBeenCalledWith("user-1");
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("解除"));
    });
  });

  describe("!owner/ban-guild (サーバー BAN)", () => {
    it("guildId なしで使用法を返す", async () => {
      const msg = createMockMessage({ content: "!owner/ban-guild" });
      const result = await handler.handleMessage(msg);
      expect(result).toBe(true);
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("使用方法"));
    });

    it("サーバー BAN に成功する（サーバー未参加時）", async () => {
      const msg = createMockMessage({ content: "!owner/ban-guild guild-1 spamming" });
      vi.mocked(mockBanService.banGuild).mockResolvedValue({
        success: true,
        message: "サーバー guild-1 を BAN しました。",
      });

      const result = await handler.handleMessage(msg);

      expect(result).toBe(true);
      expect(mockBanService.banGuild).toHaveBeenCalledWith("guild-1", "spamming", OWNER_ID);
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("BAN しました"));
    });

    it("BAN 後に参加中のサーバーから脱退する", async () => {
      const msg = createMockMessage({ content: "!owner/ban-guild guild-1 spam" });
      vi.mocked(mockBanService.banGuild).mockResolvedValue({
        success: true,
        message: "BAN しました。",
      });
      const leaveFn = vi.fn().mockResolvedValue(undefined);
      mockClient.guilds.cache.set("guild-1", {
        id: "guild-1",
        name: "Test Guild",
        leave: leaveFn,
      });

      const result = await handler.handleMessage(msg);
      expect(result).toBe(true);
      expect(leaveFn).toHaveBeenCalled();
    });

    it("既に BAN 済みの場合失敗メッセージを返す", async () => {
      const msg = createMockMessage({ content: "!owner/ban-guild guild-1 spam" });
      vi.mocked(mockBanService.banGuild).mockResolvedValue({
        success: false,
        message: "既に BAN されています。",
      });

      const result = await handler.handleMessage(msg);
      expect(result).toBe(true);
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("既に BAN"));
    });
  });

  describe("!owner/unban-guild (サーバー BAN 解除)", () => {
    it("guildId なしで使用法を返す", async () => {
      const msg = createMockMessage({ content: "!owner/unban-guild" });
      const result = await handler.handleMessage(msg);
      expect(result).toBe(true);
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("使用方法"));
    });

    it("サーバー BAN 解除に成功する", async () => {
      const msg = createMockMessage({ content: "!owner/unban-guild guild-1" });
      vi.mocked(mockBanService.unbanGuild).mockResolvedValue({
        success: true,
        message: "サーバー guild-1 の BAN を解除しました。",
      });

      const result = await handler.handleMessage(msg);
      expect(result).toBe(true);
      expect(mockBanService.unbanGuild).toHaveBeenCalledWith("guild-1");
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("解除"));
    });
  });

  describe("!owner/leave", () => {
    it("guildId なしで使用法を返す", async () => {
      const msg = createMockMessage({ content: "!owner/leave" });
      const result = await handler.handleMessage(msg);
      expect(result).toBe(true);
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("使用方法"));
    });

    it("参加していないサーバーの場合メッセージを返す", async () => {
      const msg = createMockMessage({ content: "!owner/leave guild-999" });
      const result = await handler.handleMessage(msg);
      expect(result).toBe(true);
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("参加していません"));
    });

    it("参加中のサーバーから脱退する", async () => {
      const msg = createMockMessage({ content: "!owner/leave guild-1" });
      const leaveFn = vi.fn().mockResolvedValue(undefined);
      mockClient.guilds.cache.set("guild-1", {
        id: "guild-1",
        name: "Test Guild",
        leave: leaveFn,
      });

      const result = await handler.handleMessage(msg);
      expect(result).toBe(true);
      expect(leaveFn).toHaveBeenCalled();
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("脱退"));
    });
  });

  describe("!owner/list-bans", () => {
    it("BAN がない場合その旨を返す", async () => {
      const msg = createMockMessage({ content: "!owner/list-bans" });
      vi.mocked(mockBanService.listBans).mockResolvedValue([]);

      const result = await handler.handleMessage(msg);
      expect(result).toBe(true);
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("ありません"));
    });

    it("BAN 一覧を整形して返す", async () => {
      const msg = createMockMessage({ content: "!owner/list-bans" });
      vi.mocked(mockBanService.listBans).mockResolvedValue([
        {
          targetId: "user-1",
          targetType: "user",
          reason: "スパム",
          bannedBy: "owner-1",
          bannedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          targetId: "guild-1",
          targetType: "guild",
          reason: "暴言",
          bannedBy: "owner-1",
          bannedAt: "2026-02-01T00:00:00.000Z",
        },
      ]);

      const result = await handler.handleMessage(msg);
      expect(result).toBe(true);
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("user-1"));
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("guild-1"));
    });
  });

  describe("!owner/guilds", () => {
    it("参加サーバーがない場合その旨を返す", async () => {
      const msg = createMockMessage({ content: "!owner/guilds" });
      const result = await handler.handleMessage(msg);
      expect(result).toBe(true);
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("どのサーバーにも参加"));
    });

    it("参加サーバー一覧を返す", async () => {
      const msg = createMockMessage({ content: "!owner/guilds" });
      mockClient.guilds.cache.set("guild-1", {
        id: "guild-1",
        name: "Test Guild",
        memberCount: 100,
        leave: vi.fn(),
      });
      vi.mocked(mockBanService.listBans).mockResolvedValue([]);

      const result = await handler.handleMessage(msg);
      expect(result).toBe(true);
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("Test Guild"));
    });
  });

  describe("!owner/help", () => {
    it("ヘルプテキストを返す", async () => {
      const msg = createMockMessage({ content: "!owner/help" });
      const result = await handler.handleMessage(msg);
      expect(result).toBe(true);
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("Owner コマンド一覧"));
    });
  });

  describe("不明なコマンド", () => {
    it("エラーメッセージを返す", async () => {
      const msg = createMockMessage({ content: "!owner/unknown" });
      const result = await handler.handleMessage(msg);
      expect(result).toBe(true);
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("不明なコマンド"));
    });
  });

  describe("エラーハンドリング", () => {
    it("BanService が例外を投げた場合エラーメッセージを返す", async () => {
      const msg = createMockMessage({ content: "!owner/ban user-1 spam" });
      vi.mocked(mockBanService.banUser).mockRejectedValue(new Error("Redis connection failed"));

      const result = await handler.handleMessage(msg);
      expect(result).toBe(true);
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("Redis connection failed"));
    });
  });
  describe("!owner/embed-version (v1/v2 の使用状況)", () => {
    const addGuild = (id: string, name: string) =>
      mockClient.guilds.cache.set(id, { id, name, memberCount: 1 } as never);

    const run = async () => {
      const message = createMockMessage({ content: "!owner/embed-version" });
      await handler.handleMessage(message);
      return vi.mocked(message.reply).mock.calls.map((c) => String(c[0])).join("\n");
    };

    it("参加サーバーが無い場合はその旨を返す", async () => {
      const text = await run();

      expect(text).toContain("参加していません");
    });

    it("全体の内訳を集計して表示する", async () => {
      addGuild("g1", "Alpha");
      addGuild("g2", "Bravo");
      addGuild("g3", "Charlie");
      vi.mocked(mockChannelConfigService.getEmbedVersion)
        .mockResolvedValueOnce("v2")
        .mockResolvedValueOnce("v1")
        .mockResolvedValueOnce("v2");

      const text = await run();

      expect(text).toContain("v2: 2");
      expect(text).toContain("v1: 1");
    });

    it("guild ごとの設定状況を一覧で表示する", async () => {
      addGuild("g1", "Alpha");
      addGuild("g2", "Bravo");
      vi.mocked(mockChannelConfigService.getEmbedVersion)
        .mockResolvedValueOnce("v1")
        .mockResolvedValueOnce("v2");

      const text = await run();

      expect(text).toContain("Alpha");
      expect(text).toContain("Bravo");
      expect(text).toContain("g1");
      expect(text).toContain("g2");
    });

    it("件数が多い場合はチャンクに分けて送信する", async () => {
      for (let i = 0; i < 120; i++) {
        addGuild(`guild-${i}`, `とても長いサーバー名を持つテストギルド ${i}`);
      }

      const message = createMockMessage({ content: "!owner/embed-version" });
      await handler.handleMessage(message);

      expect(vi.mocked(message.reply).mock.calls.length).toBeGreaterThan(1);
      for (const call of vi.mocked(message.reply).mock.calls) {
        expect(String(call[0]).length).toBeLessThanOrEqual(2000);
      }
    });

    it("設定の取得に失敗した guild があっても他を表示する", async () => {
      addGuild("g1", "Alpha");
      addGuild("g2", "Bravo");
      vi.mocked(mockChannelConfigService.getEmbedVersion)
        .mockRejectedValueOnce(new Error("redis down"))
        .mockResolvedValueOnce("v2");

      const text = await run();

      expect(text).toContain("Bravo");
      expect(text).toContain("不明");
    });
  });
});
