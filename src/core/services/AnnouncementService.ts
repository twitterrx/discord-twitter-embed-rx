import type { Announcement } from "@rx-twitter/shared";

import type {
  DeliverySummary,
  GuildDeliveryTarget,
  IAnnouncementRepository,
  IAnnouncementSender,
} from "#/core/models/Announcement.js";
import logger from "#/utils/logger.js";

/**
 * お知らせ配信に関するビジネスロジック
 *
 * Core レイヤー: 外部依存なし。送信手段・永続化はインターフェース経由で注入する。
 *
 * 配信方針:
 *   - 冪等性: 配信成功後にのみ delivered を記録し、再配信時に delivered 済みをスキップする
 *     （記録が「成功後のみ」なので、記録漏れ・障害があっても未配信ギルドは再試行で再配信される）
 *   - ギルド単位のエラー分離: 1ギルドの失敗が他ギルドを止めない
 *   - mode=dm: オーナーへ DM。失敗時、フォールバックチャンネルがあればそちらへ
 *   - mode=channel: 指定チャンネルへ投稿。channelId 未設定なら DM にフォールバック
 *
 * 前提: Bot は単一インスタンスで動作する（ADR 0003）。複数インスタンス/shard 構成での
 * 重複防止はスコープ外。
 */
export class AnnouncementService {
  constructor(
    private readonly sender: IAnnouncementSender,
    private readonly repository: IAnnouncementRepository
  ) {}

  /**
   * お知らせを全対象ギルドへ配信する
   * @param announcement 配信するお知らせ
   * @param targets 配信対象ギルドの一覧
   * @returns 配信結果のサマリ
   */
  async deliver(announcement: Announcement, targets: GuildDeliveryTarget[]): Promise<DeliverySummary> {
    const summary: DeliverySummary = { delivered: 0, failed: 0, skipped: 0 };

    for (const target of targets) {
      try {
        // 配信済み（成功記録あり）はスキップ
        if (await this.repository.isDelivered(announcement.id, target.guildId)) {
          summary.skipped++;
          continue;
        }

        const ok = await this.deliverToGuild(announcement, target);
        if (ok) {
          // 送信成功後にのみ記録する（記録漏れは再試行で再配信され、二重送信より欠落を防ぐ）
          await this.repository.markDelivered(announcement.id, target.guildId);
          summary.delivered++;
        } else {
          summary.failed++;
        }
      } catch (error) {
        // ギルド単位のエラー分離（予期しない失敗が全体を止めないようにする）
        logger.error("[Announcement] Unexpected error while delivering to guild", {
          announcementId: announcement.id,
          guildId: target.guildId,
          error: error instanceof Error ? error.message : String(error),
        });
        summary.failed++;
      }
    }

    logger.info("[Announcement] Delivery completed", {
      announcementId: announcement.id,
      ...summary,
    });

    return summary;
  }

  /**
   * 1ギルドへ配信する。成功時 true、失敗時 false を返す。
   */
  private async deliverToGuild(announcement: Announcement, target: GuildDeliveryTarget): Promise<boolean> {
    const { guildId, ownerId, target: config } = target;

    // mode=channel かつ channelId 指定あり → チャンネル投稿
    if (config.mode === "channel" && config.channelId) {
      return this.trySendToChannel(announcement, config.channelId, guildId);
    }

    // それ以外（mode=dm、または channelId 未設定の channel）→ オーナー DM
    try {
      await this.sender.sendDirectMessage(ownerId, announcement);
      return true;
    } catch (error) {
      logger.warn("[Announcement] DM delivery failed", {
        announcementId: announcement.id,
        guildId,
        ownerId,
        error: error instanceof Error ? error.message : String(error),
      });

      // DM 失敗時、フォールバックチャンネルがあればそちらへ
      if (config.channelId) {
        return this.trySendToChannel(announcement, config.channelId, guildId);
      }

      return false;
    }
  }

  /**
   * チャンネルへ送信を試みる。成功時 true、失敗時 false を返す。
   */
  private async trySendToChannel(announcement: Announcement, channelId: string, guildId: string): Promise<boolean> {
    try {
      await this.sender.sendToChannel(channelId, announcement, guildId);
      return true;
    } catch (error) {
      logger.warn("[Announcement] Channel delivery failed", {
        announcementId: announcement.id,
        guildId,
        channelId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
