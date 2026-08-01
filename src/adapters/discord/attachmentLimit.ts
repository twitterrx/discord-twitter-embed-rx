import { type Guild, GuildPremiumTier } from "discord.js";

const MiB = 1024 * 1024;

/**
 * ブーストレベルごとの Discord 添付ファイル上限
 *
 * 既定は 10MiB。Discord 公式ドキュメントに
 * 「The default limit is 10 MiB for all users, but may be higher for users
 * depending on their Nitro status or by the server's Boost Tier」とある。
 * 上限が上がるのは Tier2 からで、Tier1 は既定と同じ。
 *
 * 上限を高く見積もると、ダウンロードに成功したのち Discord 側で拒否され、
 * URL へのフォールバックも効かないまま失敗する。低めに倒すと URL 送信で
 * 済むため、不明な場合は既定へ寄せる。
 */
const TIER_LIMITS: Record<GuildPremiumTier, number> = {
  [GuildPremiumTier.None]: 10 * MiB,
  [GuildPremiumTier.Tier1]: 10 * MiB,
  [GuildPremiumTier.Tier2]: 50 * MiB,
  [GuildPremiumTier.Tier3]: 100 * MiB,
};

/**
 * 安全マージン
 *
 * Discord の上限はリクエスト全体に対するものなので、ファイル本体を上限ちょうどに
 * すると multipart の境界や JSON ペイロードの分だけ超過しうる。その分を差し引く。
 */
export const ATTACHMENT_OVERHEAD_BYTES = 512 * 1024;

/** guild が無い、または未知の tier のときに用いる上限 */
const FALLBACK_LIMIT = TIER_LIMITS[GuildPremiumTier.None];

/**
 * 添付ファイルの上限バイト数を決定する
 *
 * guild のブーストレベルから上限を求め、運用側のキャップが指定されていれば
 * 小さい方を採用する。キャップは上限を「下げる」用途にのみ効く。
 *
 * @param guild 対象ギルド（DM など guild 外の文脈では null）
 * @param configuredCap 運用側が設定した上限（未設定・不正値は無視する）
 */
export const resolveAttachmentLimit = (guild: Pick<Guild, "premiumTier"> | null, configuredCap?: number): number => {
  const tierLimit = (guild && TIER_LIMITS[guild.premiumTier]) || FALLBACK_LIMIT;
  const limit = tierLimit - ATTACHMENT_OVERHEAD_BYTES;

  if (typeof configuredCap !== "number" || !Number.isInteger(configuredCap) || configuredCap <= 0) {
    return limit;
  }

  return Math.min(limit, configuredCap);
};
