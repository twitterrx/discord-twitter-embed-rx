import type { BanEntry, BanTargetType, IBanRepository } from "#/core/models/BanEntry.js";
import { redis } from "#/db/init.js";
import logger from "#/utils/logger.js";

const BAN_SET_KEY = "app:ban:list";
const BAN_META_PREFIX_USER = "app:ban:user:";
const BAN_META_PREFIX_GUILD = "app:ban:guild:";

/** Set に保存する複合キー: "{targetType}:{targetId}" */
const setMember = (targetId: string, targetType: BanTargetType): string => `${targetType}:${targetId}`;
/** メタデータの Redis キー */
const metaKey = (targetId: string, targetType: BanTargetType): string =>
  targetType === "user" ? `${BAN_META_PREFIX_USER}${targetId}` : `${BAN_META_PREFIX_GUILD}${targetId}`;

/**
 * Redis を使用した BAN リスト永続化リポジトリ
 *
 * キー設計:
 *   app:ban:list           → Set of "user:{userId}" / "guild:{guildId}"（全件検索用）
 *   app:ban:user:{userId}  → JSON（BanEntry）
 *   app:ban:guild:{guildId} → JSON（BanEntry）
 *
 * user と guild で同じ Set を使うことで listBans() を1回の sMembers で済ませる。
 * フィルタリングはアプリケーション側で行う。
 */
export class RedisBanRepository implements IBanRepository {
  /**
   * 対象を BAN リストに追加する
   */
  async addBan(entry: BanEntry): Promise<void> {
    await redis.sAdd(BAN_SET_KEY, setMember(entry.targetId, entry.targetType));
    await redis.set(metaKey(entry.targetId, entry.targetType), JSON.stringify(entry));
    logger.info(`[BanRepo] Added ${entry.targetType} ban for ${entry.targetId}`, {
      reason: entry.reason,
      bannedBy: entry.bannedBy,
    });
  }

  /**
   * 対象の BAN を解除する
   */
  async removeBan(targetId: string, targetType: BanTargetType): Promise<void> {
    await redis.sRem(BAN_SET_KEY, setMember(targetId, targetType));
    await redis.del(metaKey(targetId, targetType));
    logger.info(`[BanRepo] Removed ${targetType} ban for ${targetId}`);
  }

  /**
   * 対象が BAN されているか確認する
   */
  async isBanned(targetId: string, targetType: BanTargetType): Promise<boolean> {
    const result = await redis.sIsMember(BAN_SET_KEY, setMember(targetId, targetType));
    return result === 1;
  }

  /**
   * 全 BAN エントリを取得する（targetType でフィルタ可能）
   */
  async listBans(targetType?: BanTargetType): Promise<BanEntry[]> {
    const members = await redis.sMembers(BAN_SET_KEY);
    if (members.length === 0) return [];

    // targetType でフィルタ
    const filtered = targetType ? members.filter((m: string) => m.startsWith(`${targetType}:`)) : members;

    const entries = await Promise.all(
      filtered.map(async (member: string) => {
        const [type, ...rest] = member.split(":");
        const id = rest.join(":");
        const json = await redis.get(metaKey(id, type as BanTargetType));
        if (!json) return null;
        try {
          return JSON.parse(json) as BanEntry;
        } catch {
          logger.error(`[BanRepo] Failed to parse ban entry for ${member}`);
          return null;
        }
      })
    );

    return entries.filter((e: BanEntry | null): e is BanEntry => e !== null);
  }

  /**
   * 1件の BAN 情報を取得する
   */
  async getBan(targetId: string, targetType: BanTargetType): Promise<BanEntry | null> {
    const json = await redis.get(metaKey(targetId, targetType));
    if (!json) return null;

    try {
      return JSON.parse(json) as BanEntry;
    } catch {
      logger.error(`[BanRepo] Failed to parse ban entry for ${targetType} ${targetId}`);
      return null;
    }
  }
}
