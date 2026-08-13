import type { BanEntry, BanOperationResult, BanTargetType, IBanRepository } from "#/core/models/BanEntry.js";

/**
 * BAN に関するビジネスロジック
 *
 * Core レイヤー: 外部依存なし。リポジトリ経由でデータを操作する。
 */
export class BanService {
  constructor(private readonly repository: IBanRepository) {}

  /**
   * 対象（ユーザーまたはサーバー）を BAN する。
   * 既に BAN 済みの場合は何もしない。
   */
  async ban(
    targetId: string,
    targetType: BanTargetType,
    reason: string,
    bannedBy: string
  ): Promise<BanOperationResult> {
    const alreadyBanned = await this.repository.isBanned(targetId, targetType);
    if (alreadyBanned) {
      const label = targetType === "user" ? "ユーザー" : "サーバー";
      return { success: false, message: `${label} ${targetId} は既に BAN されています。` };
    }

    const entry: BanEntry = {
      targetId,
      targetType,
      reason,
      bannedBy,
      bannedAt: new Date().toISOString(),
    };

    await this.repository.addBan(entry);
    const label = targetType === "user" ? "ユーザー" : "サーバー";
    return { success: true, message: `${label} ${targetId} を BAN しました。` };
  }

  /**
   * ユーザーを BAN する便利メソッド
   */
  async banUser(userId: string, reason: string, bannedBy: string): Promise<BanOperationResult> {
    return this.ban(userId, "user", reason, bannedBy);
  }

  /**
   * サーバーを BAN する便利メソッド
   */
  async banGuild(guildId: string, reason: string, bannedBy: string): Promise<BanOperationResult> {
    return this.ban(guildId, "guild", reason, bannedBy);
  }

  /**
   * 対象の BAN を解除する。BAN されていない場合は何もしない。
   */
  async unban(targetId: string, targetType: BanTargetType): Promise<BanOperationResult> {
    const isBanned = await this.repository.isBanned(targetId, targetType);
    if (!isBanned) {
      const label = targetType === "user" ? "ユーザー" : "サーバー";
      return { success: false, message: `${label} ${targetId} は BAN されていません。` };
    }

    await this.repository.removeBan(targetId, targetType);
    const label = targetType === "user" ? "ユーザー" : "サーバー";
    return { success: true, message: `${label} ${targetId} の BAN を解除しました。` };
  }

  /**
   * ユーザーの BAN を解除する便利メソッド
   */
  async unbanUser(userId: string): Promise<BanOperationResult> {
    return this.unban(userId, "user");
  }

  /**
   * サーバーの BAN を解除する便利メソッド
   */
  async unbanGuild(guildId: string): Promise<BanOperationResult> {
    return this.unban(guildId, "guild");
  }

  /**
   * ユーザーが BAN されているか判定する
   */
  async isUserBanned(userId: string): Promise<boolean> {
    return this.repository.isBanned(userId, "user");
  }

  /**
   * サーバーが BAN されているか判定する
   */
  async isGuildBanned(guildId: string): Promise<boolean> {
    return this.repository.isBanned(guildId, "guild");
  }

  /**
   * BAN リストを取得する（targetType でフィルタ可能）
   */
  async listBans(targetType?: BanTargetType): Promise<BanEntry[]> {
    return this.repository.listBans(targetType);
  }

  /**
   * 1件の BAN 情報を取得する
   */
  async getBan(targetId: string, targetType: BanTargetType): Promise<BanEntry | null> {
    return this.repository.getBan(targetId, targetType);
  }
}
