import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IChannelConfigRepository, GuildConfig } from "@rx-twitter/shared";

vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { FallbackPolicies } from "@/core/services/ChannelConfigService";
import { ChannelConfigService } from "@/core/services/ChannelConfigService";

const createMockRepo = (): IChannelConfigRepository => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  notifyUpdate: vi.fn(),
});

const createGuildConfig = (overrides: Partial<GuildConfig> = {}): GuildConfig => ({
  guildId: "guild-1",
  allowAllChannels: false,
  whitelistedChannelIds: [],
  version: 1,
  updatedAt: "2024-01-01T00:00:00Z",
  ...overrides,
});

/** 既定（両方 allow）の方針。制限する運用は個別に上書きする */
const ALLOW_ALL: FallbackPolicies = { redisDown: "allow", configNotFound: "allow" };

describe("ChannelConfigService", () => {
  let mockRepo: IChannelConfigRepository;

  beforeEach(() => {
    mockRepo = createMockRepo();
    vi.clearAllMocks();
  });

  describe("isChannelAllowed - kind: found", () => {
    it("allowAllChannels=true の場合 true を返す", async () => {
      vi.mocked(mockRepo.getConfig).mockResolvedValue({
        kind: "found",
        data: createGuildConfig({ allowAllChannels: true }),
      });
      const service = new ChannelConfigService(mockRepo, ALLOW_ALL);

      expect(await service.isChannelAllowed("guild-1", "any-channel")).toBe(true);
    });

    it("ホワイトリストにチャンネルが含まれる場合 true を返す", async () => {
      vi.mocked(mockRepo.getConfig).mockResolvedValue({
        kind: "found",
        data: createGuildConfig({ whitelistedChannelIds: ["channel-1", "channel-2"] }),
      });
      const service = new ChannelConfigService(mockRepo, ALLOW_ALL);

      expect(await service.isChannelAllowed("guild-1", "channel-1")).toBe(true);
    });

    it("ホワイトリストにチャンネルが含まれない場合 false を返す", async () => {
      vi.mocked(mockRepo.getConfig).mockResolvedValue({
        kind: "found",
        data: createGuildConfig({ whitelistedChannelIds: ["channel-1"] }),
      });
      const service = new ChannelConfigService(mockRepo, ALLOW_ALL);

      expect(await service.isChannelAllowed("guild-1", "channel-999")).toBe(false);
    });

    it("フォールバック方針に関わらず設定内容が優先される", async () => {
      vi.mocked(mockRepo.getConfig).mockResolvedValue({
        kind: "found",
        data: createGuildConfig({ allowAllChannels: true }),
      });
      const service = new ChannelConfigService(mockRepo, {
        redisDown: "deny",
        configNotFound: "deny",
      });

      expect(await service.isChannelAllowed("guild-1", "any-channel")).toBe(true);
    });
  });

  describe("isChannelAllowed - kind: not_found", () => {
    beforeEach(() => {
      vi.mocked(mockRepo.getConfig).mockResolvedValue({ kind: "not_found" });
    });

    it("configNotFound=allow なら true を返す", async () => {
      const service = new ChannelConfigService(mockRepo, ALLOW_ALL);

      expect(await service.isChannelAllowed("guild-1", "channel-1")).toBe(true);
    });

    it("configNotFound=deny なら false を返す", async () => {
      const service = new ChannelConfigService(mockRepo, {
        ...ALLOW_ALL,
        configNotFound: "deny",
      });

      expect(await service.isChannelAllowed("guild-1", "channel-1")).toBe(false);
    });

    it("redisDown の方針には影響されない", async () => {
      const service = new ChannelConfigService(mockRepo, {
        redisDown: "deny",
        configNotFound: "allow",
      });

      expect(await service.isChannelAllowed("guild-1", "channel-1")).toBe(true);
    });
  });

  describe("isChannelAllowed - kind: error", () => {
    beforeEach(() => {
      vi.mocked(mockRepo.getConfig).mockResolvedValue({
        kind: "error",
        error: new Error("redis down"),
      });
    });

    it("redisDown=allow なら true を返す", async () => {
      const service = new ChannelConfigService(mockRepo, ALLOW_ALL);

      expect(await service.isChannelAllowed("guild-1", "channel-1")).toBe(true);
    });

    it("redisDown=deny なら false を返す", async () => {
      const service = new ChannelConfigService(mockRepo, {
        ...ALLOW_ALL,
        redisDown: "deny",
      });

      expect(await service.isChannelAllowed("guild-1", "channel-1")).toBe(false);
    });

    it("configNotFound の方針には影響されない", async () => {
      const service = new ChannelConfigService(mockRepo, {
        redisDown: "allow",
        configNotFound: "deny",
      });

      expect(await service.isChannelAllowed("guild-1", "channel-1")).toBe(true);
    });
  });

  describe("isChannelAllowed - 予期しない例外", () => {
    beforeEach(() => {
      vi.mocked(mockRepo.getConfig).mockRejectedValue(new Error("unexpected failure"));
    });

    it("redisDown=allow なら true を返す", async () => {
      const service = new ChannelConfigService(mockRepo, ALLOW_ALL);

      expect(await service.isChannelAllowed("guild-1", "channel-1")).toBe(true);
    });

    it("redisDown=deny なら false を返す", async () => {
      const service = new ChannelConfigService(mockRepo, {
        ...ALLOW_ALL,
        redisDown: "deny",
      });

      expect(await service.isChannelAllowed("guild-1", "channel-1")).toBe(false);
    });
  });

  describe("performHealthCheck", () => {
    it("リポジトリが performHealthCheck をサポートする場合その結果を返す", async () => {
      const repo = { ...createMockRepo(), performHealthCheck: vi.fn().mockResolvedValue(true) };
      const service = new ChannelConfigService(repo, ALLOW_ALL);

      expect(await service.performHealthCheck()).toBe(true);
    });

    it("performHealthCheck が false を返す場合 false を返す", async () => {
      const repo = { ...createMockRepo(), performHealthCheck: vi.fn().mockResolvedValue(false) };
      const service = new ChannelConfigService(repo, ALLOW_ALL);

      expect(await service.performHealthCheck()).toBe(false);
    });

    it("リポジトリが performHealthCheck をサポートしない場合 true を返す", async () => {
      const service = new ChannelConfigService(mockRepo, ALLOW_ALL);

      expect(await service.performHealthCheck()).toBe(true);
    });
  });
  describe("getEmbedVersion", () => {
    const service = () => new ChannelConfigService(mockRepo, ALLOW_ALL);

    it("設定があればその値を返す", async () => {
      vi.mocked(mockRepo.getConfig).mockResolvedValue({
        kind: "found",
        data: createGuildConfig({ embedVersion: "v1" }),
      });

      expect(await service().getEmbedVersion("guild-1")).toBe("v1");
    });

    it("未設定なら既定の v2 を返す", async () => {
      vi.mocked(mockRepo.getConfig).mockResolvedValue({
        kind: "found",
        data: createGuildConfig(),
      });

      expect(await service().getEmbedVersion("guild-1")).toBe("v2");
    });

    it("解釈できない値は既定の v2 に倒す", async () => {
      vi.mocked(mockRepo.getConfig).mockResolvedValue({
        kind: "found",
        data: createGuildConfig({ embedVersion: "v3" as never }),
      });

      expect(await service().getEmbedVersion("guild-1")).toBe("v2");
    });

    it("設定が見つからない場合は既定の v2 を返す", async () => {
      vi.mocked(mockRepo.getConfig).mockResolvedValue({ kind: "not_found" });

      expect(await service().getEmbedVersion("guild-1")).toBe("v2");
    });

    it("Redis 障害時も既定の v2 を返す", async () => {
      vi.mocked(mockRepo.getConfig).mockResolvedValue({
        kind: "error",
        error: new Error("redis down"),
      });

      expect(await service().getEmbedVersion("guild-1")).toBe("v2");
    });

    it("フォールバック方針に関わらず既定は v2", async () => {
      vi.mocked(mockRepo.getConfig).mockResolvedValue({ kind: "not_found" });
      const denyService = new ChannelConfigService(mockRepo, {
        redisDown: "deny",
        configNotFound: "deny",
      });

      // チャンネル許可の方針と表示方式は独立した関心
      expect(await denyService.getEmbedVersion("guild-1")).toBe("v2");
    });

    it("予期しない例外でも既定の v2 を返す", async () => {
      vi.mocked(mockRepo.getConfig).mockRejectedValue(new Error("boom"));

      expect(await service().getEmbedVersion("guild-1")).toBe("v2");
    });
  });
  describe("getEmbedVersionStatus", () => {
    const service = () => new ChannelConfigService(mockRepo, ALLOW_ALL);

    it("明示設定は explicit として返す", async () => {
      vi.mocked(mockRepo.getConfig).mockResolvedValue({
        kind: "found",
        data: createGuildConfig({ embedVersion: "v1" }),
      });

      expect(await service().getEmbedVersionStatus("g")).toEqual({ kind: "explicit", version: "v1" });
    });

    it("未設定は default として返す", async () => {
      vi.mocked(mockRepo.getConfig).mockResolvedValue({ kind: "found", data: createGuildConfig() });

      expect(await service().getEmbedVersionStatus("g")).toEqual({ kind: "default", version: "v2" });
    });

    it("不正値も default として返す", async () => {
      vi.mocked(mockRepo.getConfig).mockResolvedValue({
        kind: "found",
        data: createGuildConfig({ embedVersion: "v9" as never }),
      });

      expect(await service().getEmbedVersionStatus("g")).toEqual({ kind: "default", version: "v2" });
    });

    it("設定未作成は default として返す", async () => {
      vi.mocked(mockRepo.getConfig).mockResolvedValue({ kind: "not_found" });

      expect(await service().getEmbedVersionStatus("g")).toEqual({ kind: "default", version: "v2" });
    });

    it("Redis 障害は unavailable として返す（既定値と区別する）", async () => {
      vi.mocked(mockRepo.getConfig).mockResolvedValue({ kind: "error", error: new Error("redis down") });

      expect(await service().getEmbedVersionStatus("g")).toEqual({ kind: "unavailable" });
    });

    it("予期しない例外も unavailable として返す", async () => {
      vi.mocked(mockRepo.getConfig).mockRejectedValue(new Error("boom"));

      expect(await service().getEmbedVersionStatus("g")).toEqual({ kind: "unavailable" });
    });

    it("getEmbedVersion は unavailable でも既定値を返す", async () => {
      vi.mocked(mockRepo.getConfig).mockResolvedValue({ kind: "error", error: new Error("redis down") });

      // 送信経路は止められないため既定へ倒す。診断は status 側で行う
      expect(await service().getEmbedVersion("g")).toBe("v2");
    });
  });
});
