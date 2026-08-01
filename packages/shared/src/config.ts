/**
 * ギルド設定の型定義（Bot ↔ Dashboard 共有）
 */

import type { AnnounceTarget } from "./announcement.js";

/**
 * 埋め込みの表示方式
 * - v1: 従来の Embed
 * - v2: Discord Components v2（Container 等で構成）
 */
export type EmbedVersion = "v1" | "v2";

/**
 * Redisに保存されるギルド設定
 */
export interface GuildConfig {
  /** ギルドID */
  guildId: string;
  /** 全チャンネル許可フラグ */
  allowAllChannels: boolean;
  /** ホワイトリスト化されたチャンネルID一覧 */
  whitelistedChannelIds: string[];
  /** 設定バージョン（楽観的ロック用） */
  version: number;
  /** 最終更新日時（ISO 8601形式） */
  updatedAt: string;
  /** 最終更新者のユーザーID */
  updatedBy?: string;
  /** 1メッセージあたりの最大処理URL数（1〜5、未設定時はBot側でデフォルト3を使用） */
  maxUrlsPerMessage?: number;
  /** お知らせの配信先設定（未設定時はBot側でオーナーへのDMをデフォルトとする） */
  announceTarget?: AnnounceTarget;
  /** 埋め込みの表示方式（未設定時はBot側でデフォルトを使用） */
  embedVersion?: EmbedVersion;
}

/**
 * チャンネル設定取得結果（三値型）
 */
export type ConfigResult =
  | { kind: "found"; data: GuildConfig }
  | { kind: "not_found" }
  | { kind: "error"; error: Error };

/**
 * チャンネル設定リポジトリのインターフェース
 */
export interface IChannelConfigRepository {
  /**
   * ギルド設定を取得
   * @param guildId ギルドID
   * @returns 設定取得結果
   */
  getConfig(guildId: string): Promise<ConfigResult>;

  /**
   * ギルド設定を保存
   * @param config 保存する設定
   */
  saveConfig(config: GuildConfig): Promise<void>;

  /**
   * 設定更新を通知（Redis Pub/Sub）
   * @param guildId ギルドID
   * @param version 新しいバージョン
   */
  notifyUpdate(guildId: string, version: number): Promise<void>;
}

/**
 * Redis Pub/Subメッセージ型
 */
export interface ConfigUpdateMessage {
  guildId: string;
  version: number;
  updatedAt: string;
}
