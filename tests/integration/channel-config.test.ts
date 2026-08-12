import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { GuildConfig } from "@rx-twitter/shared";

vi.mock("#/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ChannelConfigService, type FallbackPolicies } from "#/core/services/ChannelConfigService.js";
import { redis } from "#/db/init.js";
import { RedisChannelConfigRepository } from "#/infrastructure/db/RedisChannelConfigRepository.js";

/**
 * 実 Redis を用いたチャンネル設定の統合テスト。
 *
 * Bot の起動・Discord イベント・メッセージハンドラは通らないため E2E ではなく、
 * Service → Repository → Redis の結合を確かめる統合テストとして扱う。
 *
 * 実行には Redis が必要なため、明示フラグ RUN_REDIS_INTEGRATION=1 のときのみ実行する。
 *   RUN_REDIS_INTEGRATION=1 REDIS_URL=redis://127.0.0.1:6390 \
 *     npx vitest run tests/integration/channel-config.test.ts
 */
const RUN = process.env.RUN_REDIS_INTEGRATION === "1";

const configKey = (guildId: string): string => `app:guild:${guildId}:config`;

/** テスト間でデータが混ざらないよう、ギルドごとに一意な ID を振る */
const generateTestGuildId = (): string => `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * テスト用のギルド設定を Redis へ書き込む
 *
 * Repository と同じ接続（@/db/init の redis）を使う。別クライアントで書くと
 * 「書いたのに読めない」状態を作り込むことになり、結合を検証できない。
 */
const seedGuildConfig = async (guildId: string, overrides: Partial<GuildConfig> = {}): Promise<GuildConfig> => {
  const config: GuildConfig = {
    guildId,
    allowAllChannels: false,
    whitelistedChannelIds: [],
    version: 1,
    updatedAt: "2026-08-12T00:00:00.000Z",
    ...overrides,
  };

  await redis.set(configKey(guildId), JSON.stringify(config));
  return config;
};

const policies = (redisDown: "allow" | "deny", configNotFound: "allow" | "deny"): FallbackPolicies => ({
  redisDown,
  configNotFound,
});

describe.skipIf(!RUN)("チャンネル設定 (integration, real Redis)", () => {
  let repository: RedisChannelConfigRepository;
  let testGuildId: string;

  beforeAll(async () => {
    if (!redis.isOpen) await redis.connect();
  });

  afterAll(async () => {
    if (redis.isOpen) await redis.quit();
  });

  beforeEach(async () => {
    testGuildId = generateTestGuildId();
    // Repository は接続済みの redis を duplicate して Pub/Sub を張るため、接続後に生成する
    repository = new RedisChannelConfigRepository();
    // コンストラクタ内の購読初期化は非同期で、完了時に劣化モード監視のタイマーを張る。
    // 完了前に shutdown するとそのタイマーが取り残されるため、購読成立を Redis 側で確認して待つ
    await vi.waitFor(async () => {
      const subscribers = await redis.pubSubNumSub("config:update");
      expect(subscribers["config:update"]).toBeGreaterThanOrEqual(1);
    });
  });

  afterEach(async () => {
    await repository.shutdown();
    await redis.del(configKey(testGuildId)).catch(() => undefined);
  });

  describe("設定の取得", () => {
    it("設定が存在しない場合、not_found を返す", async () => {
      const result = await repository.getConfig(testGuildId);
      expect(result.kind).toBe("not_found");
    });

    it("設定が存在する場合、found を返し Redis の内容をそのまま読み出せる", async () => {
      await seedGuildConfig(testGuildId, {
        allowAllChannels: false,
        whitelistedChannelIds: ["channel-1", "channel-2"],
      });

      const result = await repository.getConfig(testGuildId);

      expect(result.kind).toBe("found");
      if (result.kind === "found") {
        expect(result.data.allowAllChannels).toBe(false);
        expect(result.data.whitelistedChannelIds).toEqual(["channel-1", "channel-2"]);
      }
    });

    it("保存した設定を読み戻せる（saveConfig → getConfig）", async () => {
      const config: GuildConfig = {
        guildId: testGuildId,
        allowAllChannels: true,
        whitelistedChannelIds: [],
        version: 3,
        updatedAt: "2026-08-12T00:00:00.000Z",
      };

      await repository.saveConfig(config);
      const result = await repository.getConfig(testGuildId);

      expect(result.kind).toBe("found");
      if (result.kind === "found") {
        expect(result.data).toEqual(config);
      }
    });

    it("壊れた JSON が保存されている場合、error を返す", async () => {
      await redis.set(configKey(testGuildId), "{ broken json");

      const result = await repository.getConfig(testGuildId);

      expect(result.kind).toBe("error");
      if (result.kind === "error") {
        expect(result.error.message).toContain("JSON_PARSE_ERROR");
      }
    });
  });

  describe("チャンネル許可判定", () => {
    it("全チャンネル許可の場合、すべてのチャンネルで true を返す", async () => {
      await seedGuildConfig(testGuildId, { allowAllChannels: true });
      const service = new ChannelConfigService(repository, policies("allow", "allow"));

      expect(await service.isChannelAllowed(testGuildId, "any-channel")).toBe(true);
    });

    it("ホワイトリスト制の場合、リスト内のチャンネルのみ true を返す", async () => {
      await seedGuildConfig(testGuildId, {
        allowAllChannels: false,
        whitelistedChannelIds: ["allowed-channel"],
      });
      const service = new ChannelConfigService(repository, policies("allow", "allow"));

      expect(await service.isChannelAllowed(testGuildId, "allowed-channel")).toBe(true);
      expect(await service.isChannelAllowed(testGuildId, "not-in-list")).toBe(false);
    });

    it("設定が存在しない場合、configNotFound=allow なら true を返す", async () => {
      const service = new ChannelConfigService(repository, policies("allow", "allow"));

      expect(await service.isChannelAllowed(testGuildId, "any-channel")).toBe(true);
    });

    it("設定が存在しない場合、configNotFound=deny なら false を返す", async () => {
      const service = new ChannelConfigService(repository, policies("allow", "deny"));

      expect(await service.isChannelAllowed(testGuildId, "any-channel")).toBe(false);
    });
  });

  describe("キャッシュ無効化", () => {
    it("saveConfig 後は更新後の設定が読み出される", async () => {
      await seedGuildConfig(testGuildId, { allowAllChannels: false, whitelistedChannelIds: ["old"] });

      // 一度読んでキャッシュに載せる
      const before = await repository.getConfig(testGuildId);
      expect(before.kind).toBe("found");

      await repository.saveConfig({
        guildId: testGuildId,
        allowAllChannels: false,
        whitelistedChannelIds: ["new"],
        version: 2,
        updatedAt: "2026-08-12T01:00:00.000Z",
      });

      const after = await repository.getConfig(testGuildId);
      expect(after.kind).toBe("found");
      if (after.kind === "found") {
        expect(after.data.whitelistedChannelIds).toEqual(["new"]);
      }
    });
  });

  describe("ヘルスチェック", () => {
    it("Redis が到達可能なら performHealthCheck が true を返す", async () => {
      expect(await repository.performHealthCheck()).toBe(true);
    });
  });
});
