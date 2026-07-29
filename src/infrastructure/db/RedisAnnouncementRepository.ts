import { ANNOUNCEMENT_DLQ_STREAM_KEY } from "@rx-twitter/shared";

import type { DeadLetterRecord, IAnnouncementRepository } from "@/core/models/Announcement";
import { redis } from "@/db/init";
import logger from "@/utils/logger";

/** 配信済み記録の TTL（秒）: 30日。古いお知らせの記録を自動失効させる */
const DELIVERED_TTL_SECONDS = 30 * 24 * 60 * 60;
/** 試行回数記録の TTL（秒）: 1日 */
const ATTEMPTS_TTL_SECONDS = 24 * 60 * 60;

/** 配信済み記録の Redis キー（配信済みギルドの Set） */
const deliveredKey = (announcementId: string): string => `app:announcement:${announcementId}:delivered`;
/** ストリームエントリの試行回数キー */
const attemptsKey = (streamEntryId: string): string => `app:announcement:attempts:${streamEntryId}`;

/**
 * Redis を使用したお知らせ配信の永続化リポジトリ
 *
 * キー設計:
 *   app:announcement:{id}:delivered      → Set of guildId（配信成功したギルド）
 *   app:announcement:attempts:{streamId} → 配信試行回数（dead-letter 判定用）
 *   app:announcement:dlq                 → dead-letter ストリーム
 *
 * delivered は「配信成功後にのみ」記録するため、記録漏れがあっても未配信ギルドは
 * 再試行で再配信される（二重送信より欠落を防ぐ方針）。記録は TTL で自動失効する。
 */
export class RedisAnnouncementRepository implements IAnnouncementRepository {
  /**
   * 指定お知らせが指定ギルドへ配信済みか判定する
   */
  async isDelivered(announcementId: string, guildId: string): Promise<boolean> {
    const result = await redis.sIsMember(deliveredKey(announcementId), guildId);
    return result === 1;
  }

  /**
   * 指定お知らせを指定ギルドへ配信済みとして記録する（配信成功後にのみ呼ぶ）
   */
  async markDelivered(announcementId: string, guildId: string): Promise<void> {
    const key = deliveredKey(announcementId);
    await redis.sAdd(key, guildId);
    await redis.expire(key, DELIVERED_TTL_SECONDS);
    logger.debug(`[AnnouncementRepo] Marked delivered: ${announcementId} -> ${guildId}`);
  }

  /**
   * ストリームエントリの配信試行回数をインクリメントして返す
   */
  async incrementAttempts(streamEntryId: string): Promise<number> {
    const key = attemptsKey(streamEntryId);
    const count = await redis.incr(key);
    await redis.expire(key, ATTEMPTS_TTL_SECONDS);
    return count;
  }

  /**
   * ストリームエントリの試行回数記録を消去する（配信完了時）
   */
  async clearAttempts(streamEntryId: string): Promise<void> {
    await redis.del(attemptsKey(streamEntryId));
  }

  /**
   * dead-letter を DLQ ストリームへ永続化する
   */
  async recordDeadLetter(record: DeadLetterRecord): Promise<void> {
    await redis.xAdd(ANNOUNCEMENT_DLQ_STREAM_KEY, "*", {
      streamEntryId: record.streamEntryId,
      reason: record.reason,
      payload: record.payload,
      attempts: String(record.attempts ?? 0),
      deadLetteredAt: new Date().toISOString(),
    });
    logger.warn(`[AnnouncementRepo] Recorded dead-letter for entry ${record.streamEntryId}: ${record.reason}`);
  }
}
