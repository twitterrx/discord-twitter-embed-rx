import { type Guild, GuildPremiumTier } from "discord.js";

const MiB = 1024 * 1024;

/**
 * ブーストレベルごとの Discord 添付ファイル上限
 * Tier0 と Tier1 は同じ 25MiB
 */
const TIER_LIMITS: Record<GuildPremiumTier, number> = {
  [GuildPremiumTier.None]: 25 * MiB,
  [GuildPremiumTier.Tier1]: 25 * MiB,
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
