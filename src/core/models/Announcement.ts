import type { Announcement, AnnounceTarget } from "@rx-twitter/shared";

/**
 * お知らせのドメイン型（Bot 側）
 *
 * 配信ロジックが依存する抽象。Core レイヤーに属するため外部依存なし。
 * 送信手段（Discord）や永続化（Redis）は Adapter / Infrastructure 層で実装する。
 */

/**
 * お知らせの送信手段の抽象
 * Adapter 層（Discord）で実装する
 */
export interface IAnnouncementSender {
  /**
   * ユーザーへ DM でお知らせを送信する
   * @throws 送信に失敗した場合（DM 拒否など）
   */
  sendDirectMessage(userId: string, announcement: Announcement): Promise<void>;

  /**
   * チャンネルへお知らせを投稿する
   * @param channelId 投稿先チャンネルID
   * @param announcement お知らせ
   * @param expectedGuildId 投稿先チャンネルが属するべきギルドID（誤送信防止のため検証する）
   * @throws チャンネルが存在しない・送信不可・別ギルド所属の場合
   */
  sendToChannel(channelId: string, announcement: Announcement, expectedGuildId: string): Promise<void>;
}

/**
 * 配信済み記録（冪等性・重複配信防止）とストリーム再試行回数の抽象
 * Infrastructure 層（Redis）で実装する
 */
export interface IAnnouncementRepository {
  /**
   * 指定お知らせの指定ギルドへの配信をアトミックに claim する。
   * 初めて claim できた場合のみ true を返す（複数インスタンス・再配信での重複を防ぐ）。
   */
  claimGuild(announcementId: string, guildId: string): Promise<boolean>;

  /**
   * claim を解放する（配信失敗時、再試行で再配信できるようにする）
   */
  releaseGuild(announcementId: string, guildId: string): Promise<void>;

  /**
   * ストリームエントリの配信試行回数をインクリメントし、加算後の値を返す。
   * dead-letter 判定（試行上限超過）に使用する。
   */
  incrementAttempts(streamEntryId: string): Promise<number>;

  /**
   * ストリームエントリの試行回数記録を消去する（配信完了時）
   */
  clearAttempts(streamEntryId: string): Promise<void>;
}

/**
 * 1ギルドへの配信対象情報
 */
export interface GuildDeliveryTarget {
  /** ギルドID */
  guildId: string;
  /** ギルドオーナーのユーザーID（DM 配信先） */
  ownerId: string;
  /** 配信先設定 */
  target: AnnounceTarget;
}

/**
 * 配信結果のサマリ
 */
export interface DeliverySummary {
  /** 配信に成功したギルド数 */
  delivered: number;
  /** 配信に失敗したギルド数 */
  failed: number;
  /** 配信済み（claim 済み）のためスキップしたギルド数 */
  skipped: number;
}
