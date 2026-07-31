/**
 * E2E テスト: チャンネル設定機能
 *
 * NOTE: このテストは実際の Redis に接続して実行されます。
 * テスト用のギルドIDを使用してデータの混在を防いでいます。
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestRedis, closeTestRedis, cleanupTestData, setupTestGuildConfig, generateTestGuildId } from "./helpers";
import { resolveFallbackPolicies } from "../../src/config/fallbackPolicy";
import { ChannelConfigService } from "../../src/core/services/ChannelConfigService";
import { RedisChannelConfigRepository } from "../../src/infrastructure/db/RedisChannelConfigRepository";

describe("E2E: チャンネル設定機能", () => {
  let configService: ChannelConfigService;
  let configRepository: RedisChannelConfigRepository;
  let testGuildId: string;
  let redisAvailable = false;

  beforeAll(async () => {
    try {
      // Redis 接続を確立
      await getTestRedis();
      redisAvailable = true;

      // Repository と Service を初期化
      configRepository = new RedisChannelConfigRepository();
      configService = new ChannelConfigService(configRepository, resolveFallbackPolicies());
    } catch {
      console.warn("[E2E] Skipping tests: Redis is not available");
      redisAvailable = false;
    }
  });

  afterAll(async () => {
    if (redisAvailable) {
      // Redis 接続をクローズ
      await closeTestRedis();
    }
  });

  beforeEach(() => {
    // 各テストで新しいギルドIDを使用
    testGuildId = generateTestGuildId();
  });

  describe("設定の取得", () => {
    it("設定が存在しない場合、not_found を返す", async () => {
      if (!redisAvailable) {
        console.warn("Skipping: Redis not available");
        return;
      }

      const result = await configRepository.getConfig(testGuildId);
      expect(result.kind).toBe("not_found");
    });

    it("設定が存在する場合、found を返す", async () => {
      if (!redisAvailable) {
        console.warn("Skipping: Redis not available");
        return;
      }

      // テスト用の設定をセットアップ
      await setupTestGuildConfig(testGuildId, {
        allowAllChannels: false,
        whitelist: ["channel-1", "channel-2"],
        version: 1,
      });

      const result = await configRepository.getConfig(testGuildId);

      expect(result.kind).toBe("found");
      if (result.kind === "found") {
        expect(result.data.allowAllChannels).toBe(false);
        expect(result.data.whitelistedChannelIds).toEqual(["channel-1", "channel-2"]);
      }
    });
  });

  describe("チャンネル許可判定", () => {
    it("全チャンネル許可の場合、すべてのチャンネルで true を返す", async () => {
      if (!redisAvailable) {
        console.warn("Skipping: Redis not available");
        return;
      }

      await setupTestGuildConfig(testGuildId, {
        allowAllChannels: true,
        whitelist: [],
        version: 1,
      });

      const result = await configService.isChannelAllowed(testGuildId, "any-channel");
      expect(result).toBe(true);
    });

    it("ホワイトリスト制の場合、リスト内のチャンネルのみ true を返す", async () => {
      if (!redisAvailable) {
        console.warn("Skipping: Redis not available");
        return;
      }

      await setupTestGuildConfig(testGuildId, {
        allowAllChannels: false,
        whitelist: ["allowed-channel"],
        version: 1,
      });

      const allowed = await configService.isChannelAllowed(testGuildId, "allowed-channel");
      const denied = await configService.isChannelAllowed(testGuildId, "not-in-list");

      expect(allowed).toBe(true);
      expect(denied).toBe(false);
    });

    it("設定が存在しない場合、環境変数に従う（デフォルト: deny）", async () => {
      if (!redisAvailable) {
        console.warn("Skipping: Redis not available");
        return;
      }

      const result = await configService.isChannelAllowed(testGuildId, "any-channel");
      expect(result).toBe(false);
    });
  });

  describe("クリーンアップ", () => {
    it("テストデータをクリーンアップできる", async () => {
      if (!redisAvailable) {
        console.warn("Skipping: Redis not available");
        return;
      }

      await setupTestGuildConfig(testGuildId, {
        allowAllChannels: true,
        whitelist: [],
        version: 1,
      });

      // クリーンアップ実行
      await cleanupTestData(testGuildId);

      // クリーンアップ後は設定が存在しない
      const result = await configRepository.getConfig(testGuildId);
      expect(result.kind).toBe("not_found");
    });
  });
});
