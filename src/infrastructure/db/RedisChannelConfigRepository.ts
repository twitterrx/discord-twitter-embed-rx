import type { ConfigResult, GuildConfig, IChannelConfigRepository } from "@rx-twitter/shared";

import { redis } from "#/db/init.js";
import logger from "#/utils/logger.js";

/**
 * LRUキャッシュエントリ
 */
interface CacheEntry {
  config: GuildConfig;
  cachedAt: number;
  version: number;
}

/**
 * P0対応: RedisChannelConfigRepository実装
 * LRUキャッシュ + Redis永続ストレージ + Pub/Sub更新通知
 */
export class RedisChannelConfigRepository implements IChannelConfigRepository {
  private readonly cache: Map<string, CacheEntry> = new Map();
  private readonly maxCacheSize: number = 1000;
  private readonly revalidateIntervalMs: number = 5 * 60 * 1000; // 5分
  private readonly degradedModeCheckIntervalMs: number = 30 * 1000; // 30秒
  private subscriber: typeof redis | null = null;
  private isSubscribed: boolean = false;
  private isShuttingDown: boolean = false;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private degradedModeTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.initializeSubscriber();
  }

  /**
   * P0: 起動時ヘルスチェック
   */
  async performHealthCheck(): Promise<boolean> {
    try {
      const pong = await redis.ping();
      if (pong !== "PONG") {
        logger.error("[ConfigRepo] Health check failed: unexpected PING response");
        return false;
      }

      // スキーマバージョンの確認
      const schemaVersion = await redis.get("app:config:schema_version");
      if (!schemaVersion) {
        logger.warn("[ConfigRepo] Schema version not found, may need reseed");
      }

      logger.info("[ConfigRepo] Health check passed");
      return true;
    } catch (err) {
      logger.error("[ConfigRepo] Health check failed:", err);
      return false;
    }
  }

  /**
   * P0: Redis健全性チェック
   */
  async isRedisHealthy(): Promise<boolean> {
    try {
      const pong = await redis.ping();
      return pong === "PONG";
    } catch {
      return false;
    }
  }

  /**
   * Pub/Subサブスクライバーの初期化
   */
  private async initializeSubscriber(): Promise<void> {
    try {
      // 新しいRedis接続を作成（Pub/Sub専用）
      this.subscriber = redis.duplicate();

      // error ハンドラを先に設定
      this.subscriber.on("error", (err) => {
        logger.error("[ConfigRepo] Subscriber error:", err);
        this.isSubscribed = false;
      });

      // connect メソッドが存在する場合のみ呼び出す
      if (typeof this.subscriber.connect === "function" && !this.subscriber.isOpen) {
        await this.subscriber.connect();
      }

      // config:update チャンネルを購読
      await this.subscriber.subscribe("config:update", (message) => {
        this.handleConfigUpdate(message);
      });

      this.isSubscribed = true;
      logger.info("[ConfigRepo] Pub/Sub subscriber initialized");

      // P0: 劣化モード監視を開始
      this.startDegradedModeMonitoring();
    } catch (err) {
      logger.error("[ConfigRepo] Failed to initialize subscriber:", err);
      this.isSubscribed = false;

      // P0: 購読失敗時は劣化モードで動作
      this.startDegradedModeMonitoring();
    }
  }

  /**
   * P0: 劣化モード監視（Pub/Sub切断時の代替手段）
   */
  private startDegradedModeMonitoring(): void {
    if (this.degradedModeTimer) {
      clearInterval(this.degradedModeTimer);
    }

    this.degradedModeTimer = setInterval(async () => {
      if (this.isSubscribed) {
        // Pub/Sub正常時はスキップ
        return;
      }

      // P0: Pub/Sub未接続時は30秒ごとにRedisを確認
      logger.warn("[ConfigRepo] Running in degraded mode (Pub/Sub unavailable)");

      // 全キャッシュエントリのバージョンを再検証
      for (const [guildId] of this.cache) {
        try {
          await this.revalidateConfig(guildId);
        } catch (err) {
          logger.error(`[ConfigRepo] Failed to revalidate ${guildId} in degraded mode:`, err);
        }
      }
    }, this.degradedModeCheckIntervalMs);
  }

  /**
   * 設定更新通知を処理
   */
  private handleConfigUpdate(message: string): void {
    try {
      const update = JSON.parse(message) as { guildId: string; version: number };
      logger.info(`[ConfigRepo] Received config update for guild ${update.guildId}, version ${update.version}`);

      // キャッシュを無効化
      this.cache.delete(update.guildId);
    } catch (err) {
      logger.error("[ConfigRepo] Failed to parse config update message:", err);
    }
  }

  /**
   * P0: fetchFromRedis で error を明示的に返す
   */
  private async fetchFromRedis(guildId: string): Promise<ConfigResult> {
    try {
      const key = `app:guild:${guildId}:config`;
      const data = await redis.get(key);

      if (!data) {
        return { kind: "not_found" };
      }

      try {
        const config = JSON.parse(data) as GuildConfig;
        return { kind: "found", data: config };
      } catch (parseErr) {
        // P2: JSON_PARSE_ERROR
        logger.error(`[ConfigRepo] JSON parse error for guild ${guildId}:`, parseErr);
        return {
          kind: "error",
          error: new Error(`JSON_PARSE_ERROR: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`),
        };
      }
    } catch (err) {
      // P2: REDIS_CONNECTION_ERROR
      logger.error(`[ConfigRepo] Redis connection error for guild ${guildId}:`, err);
      return {
        kind: "error",
        error: new Error(`REDIS_CONNECTION_ERROR: ${err instanceof Error ? err.message : String(err)}`),
      };
    }
  }

  /**
   * バージョンベースの再検証
   */
  private async revalidateConfig(guildId: string): Promise<void> {
    const cached = this.cache.get(guildId);
    if (!cached) {
      return;
    }

    const now = Date.now();
    if (now - cached.cachedAt < this.revalidateIntervalMs) {
      // まだ再検証不要
      return;
    }

    const result = await this.fetchFromRedis(guildId);
    if (result.kind === "found") {
      if (result.data.version !== cached.version) {
        // バージョンが変更されているのでキャッシュ更新
        logger.info(`[ConfigRepo] Config updated for guild ${guildId}: v${cached.version} -> v${result.data.version}`);
        this.cache.set(guildId, {
          config: result.data,
          cachedAt: now,
          version: result.data.version,
        });
      } else {
        // バージョン一致、cachedAtのみ更新
        cached.cachedAt = now;
      }
    } else if (result.kind === "not_found") {
      // Redisから削除されている
      this.cache.delete(guildId);
      logger.warn(`[ConfigRepo] Config not found in Redis for guild ${guildId}, cache cleared`);
    }
  }

  /**
   * LRUキャッシュの容量管理
   */
  private evictLRU(): void {
    if (this.cache.size <= this.maxCacheSize) {
      return;
    }

    // 最も古いエントリを削除
    let oldestKey: string | null = null;
    let oldestTime = Date.now();

    for (const [key, entry] of this.cache.entries()) {
      if (entry.cachedAt < oldestTime) {
        oldestTime = entry.cachedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
      logger.debug(`[ConfigRepo] Evicted LRU entry: ${oldestKey}`);
    }
  }

  /**
   * ギルド設定を取得
   */
  async getConfig(guildId: string): Promise<ConfigResult> {
    // キャッシュチェック
    const cached = this.cache.get(guildId);
    if (cached) {
      // 再検証が必要か確認（非同期で実行）
      this.revalidateConfig(guildId).catch((err) => {
        logger.error(`[ConfigRepo] Failed to revalidate ${guildId}:`, err);
      });

      return { kind: "found", data: cached.config };
    }

    // Redisから取得
    const result = await this.fetchFromRedis(guildId);

    if (result.kind === "found") {
      // キャッシュに追加
      this.evictLRU();
      this.cache.set(guildId, {
        config: result.data,
        cachedAt: Date.now(),
        version: result.data.version,
      });
    }

    return result;
  }

  /**
   * ギルド設定を保存（Dashboard側で使用）
   */
  async saveConfig(config: GuildConfig): Promise<void> {
    const key = `app:guild:${config.guildId}:config`;
    await redis.set(key, JSON.stringify(config));

    // キャッシュを無効化
    this.cache.delete(config.guildId);

    logger.info(`[ConfigRepo] Saved config for guild ${config.guildId}, version ${config.version}`);
  }

  /**
   * 設定更新を通知（Dashboard側で使用）
   */
  async notifyUpdate(guildId: string, version: number): Promise<void> {
    const message = JSON.stringify({ guildId, version, updatedAt: new Date().toISOString() });
    await redis.publish("config:update", message);
    logger.info(`[ConfigRepo] Published update notification for guild ${guildId}`);
  }

  /**
   * P0: guildDelete で config を削除しない
   * （再参加時の全許可防止）
   */
  async handleGuildDelete(guildId: string): Promise<void> {
    // キャッシュのみ削除、Redisには残す
    this.cache.delete(guildId);
    logger.info(`[ConfigRepo] Guild ${guildId} left, cache cleared but config preserved`);
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    if (this.degradedModeTimer) {
      clearInterval(this.degradedModeTimer);
    }

    if (this.subscriber) {
      await this.subscriber.unsubscribe();
      await this.subscriber.quit();
      this.subscriber = null;
    }

    this.cache.clear();
    logger.info("[ConfigRepo] Shutdown completed");
  }
}
