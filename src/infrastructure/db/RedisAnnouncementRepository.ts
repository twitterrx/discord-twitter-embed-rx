import type { IAnnouncementRepository } from "@/core/models/Announcement";
import { redis } from "@/db/init";
import logger from "@/utils/logger";

/** claim 記録の TTL（秒）: 30日。古いお知らせの記録を自動失効させる */
const CLAIM_TTL_SECONDS = 30 * 24 * 60 * 60;
/** 試行回数記録の TTL（秒）: 1日 */
const ATTEMPTS_TTL_SECONDS = 24 * 60 * 60;

/** claim 記録の Redis キー（配信済みギルドの Set） */
const claimKey = (announcementId: string): string => `app:announcement:${announcementId}:delivered`;
/** ストリームエントリの試行回数キー */
const attemptsKey = (streamEntryId: string): string => `app:announcement:attempts:${streamEntryId}`;

/**
 * Redis を使用したお知らせ配信の永続化リポジトリ
 *
 * キー設計:
 *   app:announcement:{id}:delivered      → Set of guildId（配信済み=claim 済みギルド）
 *   app:announcement:attempts:{streamId} → 配信試行回数（dead-letter 判定用）
 *
 * claim は SADD の戻り値によりアトミックに行い、複数インスタンス・再配信での
 * 重複配信を防ぐ。記録は TTL により自動失効する。
 */
export class RedisAnnouncementRepository implements IAnnouncementRepository {
  /**
   * 配信をアトミックに claim する。初めて claim できた場合のみ true。
   */
  async claimGuild(announcementId: string, guildId: string): Promise<boolean> {
    const key = claimKey(announcementId);
    const added = await redis.sAdd(key, guildId);
    // SADD が新規追加（1）のときのみ claim 成功。TTL は best-effort で延長する。
    await redis.expire(key, CLAIM_TTL_SECONDS);
    return added === 1;
  }

  /**
   * claim を解放する（配信失敗時、再試行で再配信できるようにする）
   */
  async releaseGuild(announcementId: string, guildId: string): Promise<void> {
    await redis.sRem(claimKey(announcementId), guildId);
    logger.debug(`[AnnouncementRepo] Released claim: ${announcementId} -> ${guildId}`);
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
}
