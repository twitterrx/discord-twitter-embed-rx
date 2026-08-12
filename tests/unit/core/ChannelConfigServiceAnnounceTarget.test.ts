import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GuildConfig, IChannelConfigRepository } from "@rx-twitter/shared";

import type { FallbackPolicies } from "#/core/services/ChannelConfigService.js";
import { ChannelConfigService } from "#/core/services/ChannelConfigService.js";

vi.mock("#/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** 配信先の解決はフォールバック方針に依存しないため、既定値を渡す */
const ALLOW_ALL: FallbackPolicies = { redisDown: "allow", configNotFound: "allow" };

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
  updatedAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

describe("ChannelConfigService.getAnnounceTarget", () => {
  let mockRepo: IChannelConfigRepository;

  beforeEach(() => {
    mockRepo = createMockRepo();
  });

  it("設定済みの配信先をそのまま返す（channel）", async () => {
    vi.mocked(mockRepo.getConfig).mockResolvedValue({
      kind: "found",
      data: createGuildConfig({ announceTarget: { mode: "channel", channelId: "ch-1" } }),
    });
    const service = new ChannelConfigService(mockRepo, ALLOW_ALL);

    expect(await service.getAnnounceTarget("guild-1")).toEqual({ mode: "channel", channelId: "ch-1" });
  });

  it("announceTarget 未設定なら DM デフォルトを返す", async () => {
    vi.mocked(mockRepo.getConfig).mockResolvedValue({
      kind: "found",
      data: createGuildConfig(),
    });
    const service = new ChannelConfigService(mockRepo, ALLOW_ALL);

    expect(await service.getAnnounceTarget("guild-1")).toEqual({ mode: "dm" });
  });

  it("設定が見つからない場合は DM デフォルトを返す", async () => {
    vi.mocked(mockRepo.getConfig).mockResolvedValue({ kind: "not_found" });
    const service = new ChannelConfigService(mockRepo, ALLOW_ALL);

    expect(await service.getAnnounceTarget("guild-1")).toEqual({ mode: "dm" });
  });

  it("不正な mode の場合は DM デフォルトを返す", async () => {
    vi.mocked(mockRepo.getConfig).mockResolvedValue({
      kind: "found",
      data: createGuildConfig({
        announceTarget: { mode: "invalid" as unknown as "dm" },
      }),
    });
    const service = new ChannelConfigService(mockRepo, ALLOW_ALL);

    expect(await service.getAnnounceTarget("guild-1")).toEqual({ mode: "dm" });
  });

  it("Redis 障害（error）の場合は DM デフォルトを返す", async () => {
    vi.mocked(mockRepo.getConfig).mockResolvedValue({ kind: "error", error: new Error("redis down") });
    const service = new ChannelConfigService(mockRepo, ALLOW_ALL);

    expect(await service.getAnnounceTarget("guild-1")).toEqual({ mode: "dm" });
  });
});
