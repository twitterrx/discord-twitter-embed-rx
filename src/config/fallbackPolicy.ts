import type { FallbackPolicies, FallbackPolicy } from "#/core/services/ChannelConfigService.js";
import logger from "#/utils/logger.js";

/**
 * フォールバック設定の環境変数を解釈する
 *
 * 既定は allow（可用性優先）。制限したい運用者のみ deny を明示する。
 * 既定を allow に倒しているため、deny を明示した運用者が「設定が効いているか」を
 * 確認できるよう、解釈できない値は警告する（起動時ログと合わせて誤設定を検知する）。
 */
const parseFallback = (raw: string | undefined, name: string): FallbackPolicy => {
  const normalized = raw?.trim().toLowerCase();

  if (!normalized) {
    return "allow";
  }

  if (normalized === "allow" || normalized === "deny") {
    return normalized;
  }

  logger.warn(`[ChannelConfig] Invalid ${name}="${raw}", falling back to "allow"`);
  return "allow";
};

/**
 * 環境変数からフォールバック方針を解決する
 *
 * 環境を引数で受け取るため、テストからは任意の環境を直接渡せる。
 * @param env 解釈対象の環境変数（既定は process.env）
 */
export const resolveFallbackPolicies = (env: NodeJS.ProcessEnv = process.env): FallbackPolicies => ({
  redisDown: parseFallback(env.REDIS_DOWN_FALLBACK, "REDIS_DOWN_FALLBACK"),
  configNotFound: parseFallback(env.CONFIG_NOT_FOUND_FALLBACK, "CONFIG_NOT_FOUND_FALLBACK"),
});
