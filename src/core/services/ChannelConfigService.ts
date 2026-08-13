import type { AnnounceTarget, ConfigResult, EmbedVersion, IChannelConfigRepository } from "@rx-twitter/shared";
import { DEFAULT_EMBED_VERSION, DEFAULT_MAX_URLS_PER_MESSAGE, MAX_URLS_PER_MESSAGE_LIMIT } from "@rx-twitter/shared";

import logger from "#/utils/logger.js";

/** お知らせ配信先のデフォルト（未設定時はオーナーへの DM） */
const DEFAULT_ANNOUNCE_TARGET: AnnounceTarget = { mode: "dm" };

/** フォールバック方針。既定は allow（可用性優先）、制限したい運用者のみ deny を明示する */
export type FallbackPolicy = "allow" | "deny";

/**
 * 判定不能時に適用する方針
 *
 * 環境変数の解釈は Core の責務ではないため、src/config/fallbackPolicy.ts で
 * 解決したものを src/index.ts から注入する。
 */
export interface FallbackPolicies {
  /** Redis 障害時（ConfigResult.kind === "error"） */
  redisDown: FallbackPolicy;
  /** 設定未作成時（ConfigResult.kind === "not_found"） */
  configNotFound: FallbackPolicy;
}

/**
 * 埋め込み方式の判定結果
 * - explicit: guild が明示的に設定している
 * - default: 未設定・不正値のため既定を用いる
 * - unavailable: Redis 障害等で判定できない
 */
export type EmbedVersionStatus =
  | { kind: "explicit"; version: EmbedVersion }
  | { kind: "default"; version: EmbedVersion }
  | { kind: "unavailable" };

/**
 * チャンネル設定サービス
 * Bot側でチャンネル許可判定を行う
 */
export class ChannelConfigService {
  constructor(
    private readonly repository: IChannelConfigRepository,
    private readonly policies: FallbackPolicies
  ) {}

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
            `[ChannelConfig] Config not found for guild ${guildId}, applying CONFIG_NOT_FOUND_FALLBACK: ${this.policies.configNotFound}`
          );
          return this.policies.configNotFound === "allow";

        case "error":
          // P0: Redis障害時はフォールバック設定を適用
          logger.error(`[ChannelConfig] Error fetching config for guild ${guildId}: ${result.error.message}`);
          logger.warn(`[ChannelConfig] Applying REDIS_DOWN_FALLBACK: ${this.policies.redisDown}`);

          if (this.policies.redisDown === "deny") {
            return false;
          } else {
            return true;
          }

        default: {
          // TypeScript exhaustiveness check
          const _exhaustive: never = result;
          logger.error(`[ChannelConfig] Unexpected ConfigResult kind: ${JSON.stringify(_exhaustive)}`);
          return this.policies.redisDown === "allow";
        }
      }
    } catch (err) {
      // 予期しないエラー
      logger.error(`[ChannelConfig] Unexpected error in isChannelAllowed:`, err);

      // フォールバック設定を適用
      return this.policies.redisDown === "allow";
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
   * 埋め込みの表示方式を取得する
   *
   * 未設定・不正値・設定未作成・Redis 障害時はいずれも既定（v2）へ倒す。
   * 表示方式はチャンネル許可の可否とは独立した関心のため、
   * フォールバック方針（FallbackPolicies）の影響を受けない。
   */
  async getEmbedVersion(guildId: string): Promise<EmbedVersion> {
    const status = await this.getEmbedVersionStatus(guildId);
    return status.kind === "unavailable" ? DEFAULT_EMBED_VERSION : status.version;
  }

  /**
   * 埋め込みの表示方式を、判定できたかどうかも含めて取得する（診断用）
   *
   * getEmbedVersion() は送信経路を止めないため障害時も既定値へ倒すが、
   * それでは「明示的に v2」と「障害で判定できず既定に倒れた」が区別できない。
   * 運用状況を確認する用途では両者を混同すると事実と異なる報告になるため、
   * 取得できたかどうかを保ったまま返す。
   */
  async getEmbedVersionStatus(guildId: string): Promise<EmbedVersionStatus> {
    try {
      const result = await this.repository.getConfig(guildId);

      if (result.kind === "error") {
        return { kind: "unavailable" };
      }

      if (result.kind !== "found") {
        return { kind: "default", version: DEFAULT_EMBED_VERSION };
      }

      const raw = result.data.embedVersion;

      if (raw !== "v1" && raw !== "v2") {
        return { kind: "default", version: DEFAULT_EMBED_VERSION };
      }

      return { kind: "explicit", version: raw };
    } catch (err) {
      logger.error(`[ChannelConfig] Unexpected error in getEmbedVersionStatus for guild ${guildId}:`, err);
      return { kind: "unavailable" };
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
