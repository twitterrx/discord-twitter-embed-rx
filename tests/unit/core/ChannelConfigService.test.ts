import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { IChannelConfigRepository, GuildConfig } from "@rx-twitter/shared";

vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const createMockRepo = (): IChannelConfigRepository => ({
  getConfig: vi.fn(),
  saveConfig: vi.fn(),
  notifyUpdate: vi.fn(),
  isChannelAllowed: vi.fn(),
});

const createGuildConfig = (
  overrides: Partial<GuildConfig> = {},
): GuildConfig => ({
  guildId: "guild-1",
  allowAllChannels: false,
  whitelistedChannelIds: [],
  version: 1,
  updatedAt: "2024-01-01T00:00:00Z",
  ...overrides,
});

/**
 * フォールバック設定はモジュールレベルで解決されるため、
 * 環境変数を差し替えたうえで resetModules + 動的 import で読み直す。
 * 併せて logger のモックも同じレジストリから取得し、警告出力を検証できるようにする。
 */
const loadService = async () => {
  vi.resetModules();
  // logger を先に読み込んでモジュールキャッシュに載せることで、
  // サービス側が掴むモックと同一インスタンスを確実に参照する
  const loggerModule = await import("@/utils/logger");
  const service = await import("@/core/services/ChannelConfigService");

  return {
    ChannelConfigService: service.ChannelConfigService,
    getFallbackPolicy: service.getFallbackPolicy,
    warnMessages: vi
      .mocked(loggerModule.default.warn)
      .mock.calls.map((call) => String(call[0])),
  };
};

// -------------------------
// 既定環境（未設定 = REDIS_DOWN_FALLBACK:allow / CONFIG_NOT_FOUND_FALLBACK:allow）
// -------------------------
describe("ChannelConfigService (既定環境: 未設定)", () => {
  let loaded: Awaited<ReturnType<typeof loadService>>;
  let mockRepo: IChannelConfigRepository;

  beforeAll(async () => {
    delete process.env.REDIS_DOWN_FALLBACK;
    delete process.env.CONFIG_NOT_FOUND_FALLBACK;
    loaded = await loadService();
  });

  beforeEach(() => {
    mockRepo = createMockRepo();
  });

  it("既定のフォールバック方針は両方とも allow", () => {
    expect(loaded.getFallbackPolicy()).toEqual({
      redisDown: "allow",
      configNotFound: "allow",
    });
  });

  it("未設定時に警告を出さない", () => {
    expect(
      loaded.warnMessages.filter((message) => message.includes("Invalid")),
    ).toHaveLength(0);
  });

  describe("isChannelAllowed - kind: found", () => {
    it("allowAllChannels=true の場合 true を返す", async () => {
      vi.mocked(mockRepo.getConfig).mockResolvedValue({
        kind: "found",
        data: createGuildConfig({ allowAllChannels: true }),
      });
      const service = new loaded.ChannelConfigService(mockRepo);
      expect(await service.isChannelAllowed("guild-1", "any-channel")).toBe(
        true,
      );
    });

    it("ホワイトリストにチャンネルが含まれる場合 true を返す", async () => {
      vi.mocked(mockRepo.getConfig).mockResolvedValue({
        kind: "found",
        data: createGuildConfig({
          whitelistedChannelIds: ["channel-1", "channel-2"],
        }),
      });
      const service = new loaded.ChannelConfigService(mockRepo);
      expect(await service.isChannelAllowed("guild-1", "channel-1")).toBe(true);
    });

    it("ホワイトリストにチャンネルが含まれない場合 false を返す", async () => {
      vi.mocked(mockRepo.getConfig).mockResolvedValue({
        kind: "found",
        data: createGuildConfig({ whitelistedChannelIds: ["channel-1"] }),
      });
      const service = new loaded.ChannelConfigService(mockRepo);
      expect(await service.isChannelAllowed("guild-1", "channel-999")).toBe(
        false,
      );
    });
  });

  describe("isChannelAllowed - kind: not_found (既定=allow)", () => {
    it("設定が見つからない場合 true を返す", async () => {
      vi.mocked(mockRepo.getConfig).mockResolvedValue({ kind: "not_found" });
      const service = new loaded.ChannelConfigService(mockRepo);
      expect(await service.isChannelAllowed("guild-1", "channel-1")).toBe(true);
    });
  });

  describe("isChannelAllowed - kind: error (既定=allow)", () => {
    it("Redis障害時 true を返す", async () => {
      vi.mocked(mockRepo.getConfig).mockResolvedValue({
        kind: "error",
        error: new Error("redis down"),
      });
      const service = new loaded.ChannelConfigService(mockRepo);
      expect(await service.isChannelAllowed("guild-1", "channel-1")).toBe(true);
    });

    it("getConfig が例外を投げた場合 true を返す", async () => {
      vi.mocked(mockRepo.getConfig).mockRejectedValue(
        new Error("unexpected failure"),
      );
      const service = new loaded.ChannelConfigService(mockRepo);
      expect(await service.isChannelAllowed("guild-1", "channel-1")).toBe(true);
    });
  });

  describe("performHealthCheck", () => {
    it("リポジトリが performHealthCheck をサポートする場合その結果を返す", async () => {
      const mockRepoWithHealthCheck = {
        ...createMockRepo(),
        performHealthCheck: vi.fn().mockResolvedValue(true),
      };
      const service = new loaded.ChannelConfigService(mockRepoWithHealthCheck);
      expect(await service.performHealthCheck()).toBe(true);
    });

    it("performHealthCheck が false を返す場合 false を返す", async () => {
      const mockRepoWithHealthCheck = {
        ...createMockRepo(),
        performHealthCheck: vi.fn().mockResolvedValue(false),
      };
      const service = new loaded.ChannelConfigService(mockRepoWithHealthCheck);
      expect(await service.performHealthCheck()).toBe(false);
    });

    it("リポジトリが performHealthCheck をサポートしない場合 true を返す", async () => {
      const service = new loaded.ChannelConfigService(mockRepo);
      expect(await service.performHealthCheck()).toBe(true);
    });
  });
});

// -------------------------
// CONFIG_NOT_FOUND_FALLBACK=deny（明示的に制限する運用）
// -------------------------
describe("ChannelConfigService (CONFIG_NOT_FOUND_FALLBACK=deny)", () => {
  let loaded: Awaited<ReturnType<typeof loadService>>;
  let mockRepo: IChannelConfigRepository;

  beforeAll(async () => {
    vi.stubEnv("CONFIG_NOT_FOUND_FALLBACK", "deny");
    loaded = await loadService();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    mockRepo = createMockRepo();
  });

  it("設定が見つからない場合 false を返す", async () => {
    vi.mocked(mockRepo.getConfig).mockResolvedValue({ kind: "not_found" });
    const service = new loaded.ChannelConfigService(mockRepo);
    expect(await service.isChannelAllowed("guild-1", "channel-1")).toBe(false);
  });

  it("Redis障害時は影響を受けず true を返す", async () => {
    vi.mocked(mockRepo.getConfig).mockResolvedValue({
      kind: "error",
      error: new Error("redis down"),
    });
    const service = new loaded.ChannelConfigService(mockRepo);
    expect(await service.isChannelAllowed("guild-1", "channel-1")).toBe(true);
  });
});

// -------------------------
// REDIS_DOWN_FALLBACK=deny（障害中も whitelist を維持する運用）
// -------------------------
describe("ChannelConfigService (REDIS_DOWN_FALLBACK=deny)", () => {
  let loaded: Awaited<ReturnType<typeof loadService>>;
  let mockRepo: IChannelConfigRepository;

  beforeAll(async () => {
    vi.stubEnv("REDIS_DOWN_FALLBACK", "deny");
    loaded = await loadService();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    mockRepo = createMockRepo();
  });

  it("Redis障害時 false を返す", async () => {
    vi.mocked(mockRepo.getConfig).mockResolvedValue({
      kind: "error",
      error: new Error("redis down"),
    });
    const service = new loaded.ChannelConfigService(mockRepo);
    expect(await service.isChannelAllowed("guild-1", "channel-1")).toBe(false);
  });

  it("getConfig が例外を投げた場合 false を返す", async () => {
    vi.mocked(mockRepo.getConfig).mockRejectedValue(
      new Error("unexpected failure"),
    );
    const service = new loaded.ChannelConfigService(mockRepo);
    expect(await service.isChannelAllowed("guild-1", "channel-1")).toBe(false);
  });

  it("設定未作成時は影響を受けず true を返す", async () => {
    vi.mocked(mockRepo.getConfig).mockResolvedValue({ kind: "not_found" });
    const service = new loaded.ChannelConfigService(mockRepo);
    expect(await service.isChannelAllowed("guild-1", "channel-1")).toBe(true);
  });
});

// -------------------------
// 値の正規化（大文字・前後空白を許容する）
// -------------------------
describe("ChannelConfigService (値の正規化)", () => {
  let loaded: Awaited<ReturnType<typeof loadService>>;

  beforeAll(async () => {
    vi.stubEnv("REDIS_DOWN_FALLBACK", " DENY ");
    vi.stubEnv("CONFIG_NOT_FOUND_FALLBACK", "Deny");
    loaded = await loadService();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("大文字・前後空白を含む値も deny として解釈する", () => {
    expect(loaded.getFallbackPolicy()).toEqual({
      redisDown: "deny",
      configNotFound: "deny",
    });
  });

  it("正規化できた値に対しては警告を出さない", () => {
    expect(
      loaded.warnMessages.filter((message) => message.includes("Invalid")),
    ).toHaveLength(0);
  });
});

// -------------------------
// 不正値（既定へ倒しつつ警告する）
// -------------------------
describe("ChannelConfigService (不正値)", () => {
  let loaded: Awaited<ReturnType<typeof loadService>>;
  let mockRepo: IChannelConfigRepository;

  beforeAll(async () => {
    vi.stubEnv("REDIS_DOWN_FALLBACK", "maybe");
    loaded = await loadService();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    mockRepo = createMockRepo();
  });

  it("解釈できない値は既定の allow に倒す", () => {
    expect(loaded.getFallbackPolicy().redisDown).toBe("allow");
  });

  it("解釈できない値を警告する", () => {
    expect(
      loaded.warnMessages.some(
        (message) =>
          message.includes("Invalid") &&
          message.includes("REDIS_DOWN_FALLBACK") &&
          message.includes("maybe"),
      ),
    ).toBe(true);
  });

  it("Redis障害時は既定どおり true を返す", async () => {
    vi.mocked(mockRepo.getConfig).mockResolvedValue({
      kind: "error",
      error: new Error("redis down"),
    });
    const service = new loaded.ChannelConfigService(mockRepo);
    expect(await service.isChannelAllowed("guild-1", "channel-1")).toBe(true);
  });
});
