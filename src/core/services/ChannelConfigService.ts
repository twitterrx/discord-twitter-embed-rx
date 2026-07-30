import type { AnnounceTarget, ConfigResult, IChannelConfigRepository } from "@rx-twitter/shared";
import { DEFAULT_MAX_URLS_PER_MESSAGE, MAX_URLS_PER_MESSAGE_LIMIT } from "@rx-twitter/shared";

import logger from "@/utils/logger";

/** お知らせ配信先のデフォルト（未設定時はオーナーへの DM） */
const DEFAULT_ANNOUNCE_TARGET: AnnounceTarget = { mode: "dm" };

/** フォールバック方針。既定は allow（可用性優先）、制限したい運用者のみ deny を明示する */
export type FallbackPolicy = "allow" | "deny";

/**
 * フォールバック設定の環境変数を解釈する
 *
 * 既定を allow に倒しているため、deny を明示した運用者が「設定が効いているか」を
 * 確認できるよう、解釈できない値は警告する（起動時ログと合わせて誤設定を検知する）。
 */
const parseFallback = (raw: string | undefined, name: string): FallbackPolicy => {
  const normalized = raw?.trim().toLowerCase();

  if (!normalized) {
    return "allow";
  }

  if (normalized === "allow" || normalized === "deny") {
    return normalized;
  }

  logger.warn(`[ChannelConfig] Invalid ${name}="${raw}", falling back to "allow"`);
  return "allow";
};

/**
 * P0対応: フォールバック設定
 */
const REDIS_DOWN_FALLBACK = parseFallback(process.env.REDIS_DOWN_FALLBACK, "REDIS_DOWN_FALLBACK");
const CONFIG_NOT_FOUND_FALLBACK = parseFallback(process.env.CONFIG_NOT_FOUND_FALLBACK, "CONFIG_NOT_FOUND_FALLBACK");

/**
 * 有効なフォールバック方針を取得する（起動時ログ用）
 */
export const getFallbackPolicy = () =>
  ({ redisDown: REDIS_DOWN_FALLBACK, configNotFound: CONFIG_NOT_FOUND_FALLBACK }) as const;

/**
 * チャンネル設定サービス
 * Bot側でチャンネル許可判定を行う
 */
export class ChannelConfigService {
  constructor(private readonly repository: IChannelConfigRepository) {}

  /**
   * P0: isChannelAllowed で ConfigResult.kind に応じた分岐
   * P0: error 時は REDIS_DOWN_FALLBACK を適用
   */
  async isChannelAllowed(guildId: string, channelId: string): Promise<boolean> {
    try {
      const result: ConfigResult = await this.repository.getConfig(guildId);

      switch (result.kind) {
        case "found": {
          const config = result.data;

          if (config.allowAllChannels) {
            return true;
          }

          return config.whitelistedChannelIds.includes(channelId);
        }

        case "not_found":
          // P0: 設定が見つからない場合は CONFIG_NOT_FOUND_FALLBACK を適用
          logger.warn(
            `[ChannelConfig] Config not found for guild ${guildId}, applying CONFIG_NOT_FOUND_FALLBACK: ${CONFIG_NOT_FOUND_FALLBACK}`
          );
          return CONFIG_NOT_FOUND_FALLBACK === "allow";

        case "error":
          // P0: Redis障害時はフォールバック設定を適用
          logger.error(`[ChannelConfig] Error fetching config for guild ${guildId}: ${result.error.message}`);
          logger.warn(`[ChannelConfig] Applying REDIS_DOWN_FALLBACK: ${REDIS_DOWN_FALLBACK}`);

          if (REDIS_DOWN_FALLBACK === "deny") {
            return false;
          } else {
            return true;
          }

        default: {
          // TypeScript exhaustiveness check
          const _exhaustive: never = result;
          logger.error(`[ChannelConfig] Unexpected ConfigResult kind: ${JSON.stringify(_exhaustive)}`);
          return REDIS_DOWN_FALLBACK === "allow";
        }
      }
    } catch (err) {
      // 予期しないエラー
      logger.error(`[ChannelConfig] Unexpected error in isChannelAllowed:`, err);

      // フォールバック設定を適用
      return REDIS_DOWN_FALLBACK === "allow";
    }
  }

  /**
   * ヘルスチェック（起動時検証用）
   */
  async performHealthCheck(): Promise<boolean> {
    if ("performHealthCheck" in this.repository && typeof this.repository.performHealthCheck === "function") {
      return await this.repository.performHealthCheck();
    }

    logger.warn("[ChannelConfig] Repository does not support health check");
    return true; // サポートしていない場合は通過
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    if ("shutdown" in this.repository && typeof this.repository.shutdown === "function") {
      await this.repository.shutdown();
    }
  }

  /**
   * 1メッセージあたりの最大URL処理数を取得する
   * 不正値・未設定・Redis障害時は DEFAULT_MAX_URLS_PER_MESSAGE にフォールバック
   */
  async getMaxUrlsPerMessage(guildId: string): Promise<number> {
    try {
      const result = await this.repository.getConfig(guildId);

      if (result.kind !== "found") {
        return DEFAULT_MAX_URLS_PER_MESSAGE;
      }

      const raw = result.data.maxUrlsPerMessage;

      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_URLS_PER_MESSAGE_LIMIT) {
        return DEFAULT_MAX_URLS_PER_MESSAGE;
      }

      return raw;
    } catch (err) {
      logger.error(`[ChannelConfig] Unexpected error in getMaxUrlsPerMessage for guild ${guildId}:`, err);
      return DEFAULT_MAX_URLS_PER_MESSAGE;
    }
  }

  /**
   * お知らせの配信先設定を取得する
   * 未設定・不正値・Redis障害時はオーナーへの DM にフォールバックする
   */
  async getAnnounceTarget(guildId: string): Promise<AnnounceTarget> {
    try {
      const result = await this.repository.getConfig(guildId);

      if (result.kind !== "found") {
        return DEFAULT_ANNOUNCE_TARGET;
      }

      const target = result.data.announceTarget;
      if (!target || (target.mode !== "dm" && target.mode !== "channel")) {
        return DEFAULT_ANNOUNCE_TARGET;
      }

      return target;
    } catch (err) {
      logger.error(`[ChannelConfig] Unexpected error in getAnnounceTarget for guild ${guildId}:`, err);
      return DEFAULT_ANNOUNCE_TARGET;
    }
  }
}
