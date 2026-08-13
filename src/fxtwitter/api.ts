import { HttpResponseError, ResponseContentTypeError } from "#/infrastructure/http/orvalFetch.js";
import logger from "#/utils/logger.js";

import { get2StatusId } from "./generated/default.js";
import { SocialThread, type SocialThreadOutput } from "./generated/model/index.js";
import { describeSocialThreadFailure } from "./statusValidationError.js";

export class FxTwitterApi {
  /**
   * FxEmbed API からツイート情報を取得し、Zod で検証して返す。
   * 404 は undefined、検証失敗はログ出力の上 undefined を返す。
   */
  async getPostInformation(url: string): Promise<SocialThreadOutput | undefined> {
    const startTime = Date.now();
    logger.debug("FxTwitterApi: Request started", { url });

    const id = this.extractId(url);
    if (!id) {
      logger.error("FxTwitterApi: Could not extract tweet id from url", { url });
      return undefined;
    }

    try {
      const data = await get2StatusId(id);
      const duration = Date.now() - startTime;

      const parsed = SocialThread.safeParse(data);
      if (!parsed.success) {
        // union の全ブランチ分を並べても原因が埋もれるだけなので、該当ブランチに絞る
        const failure = describeSocialThreadFailure(data, parsed.error);
        logger.error("FxTwitterApi: Response validation failed", {
          url,
          type: failure.type,
          provider: failure.provider,
          issues: failure.issues,
          duration: `${duration}ms`,
        });
        return undefined;
      }

      logger.info("FxTwitterApi: Request completed", {
        url,
        statusCode: 200,
        duration: `${duration}ms`,
      });
      return parsed.data;
    } catch (e) {
      const duration = Date.now() - startTime;

      if (e instanceof HttpResponseError && e.status === 404) {
        logger.debug("FxTwitterApi: Tweet not found (404)", { url, duration: `${duration}ms` });
        return undefined;
      }

      // 上流が JSON を返さなかった場合（HTML のエラーページ等）。
      // 回復可能なためスタックトレースは残さず warn に留める。
      // このクラスは自身がフォールバック連鎖のどこに位置するか知らないため、
      // 後続の有無には言及しない（判断と通知は TwitterAdapter の責務）。
      if (e instanceof ResponseContentTypeError) {
        logger.warn("FxTwitterApi: Non-JSON response received", {
          url,
          contentType: e.contentType,
          duration: `${duration}ms`,
        });
        return undefined;
      }

      if (process.env.NODE_ENV !== "test") {
        logger.error("FxTwitterApi: API request failed", {
          url,
          status: e instanceof HttpResponseError ? e.status : undefined,
          message: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? e.stack : undefined,
          duration: `${duration}ms`,
        });
      }
      return undefined;
    }
  }

  private extractId(url: string): string | undefined {
    const match = url.match(/\/status\/(\d{2,20})/);
    return match?.[1];
  }
}
