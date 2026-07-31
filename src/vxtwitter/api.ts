import { HttpResponseError, ResponseContentTypeError } from "@/infrastructure/http/orvalFetch";
import logger from "@/utils/logger";

import { getPostInformation } from "./generated/default";
import { VxTwitterStatus } from "./generated/model";
import type { VxTwitter } from "./vxtwitter";

export class VxTwitterServerError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "VxTwitterServerError";
  }
}

export class VxTwitterApi {
  /**
   * VxTwitter API からツイート情報を取得し、Zod で検証して返す。
   * 404 は undefined、5xx は VxTwitterServerError をスロー（フォールバック用）、
   * 検証失敗はログ出力の上 undefined を返す。
   */
  async getPostInformation(url: string): Promise<VxTwitter | undefined> {
    const startTime = Date.now();
    logger.debug("VxTwitterApi: Request started", { url });

    const params = this.extractParams(url);
    if (!params) {
      logger.error("VxTwitterApi: Could not extract screen_name/tweet_id from url", { url });
      return undefined;
    }

    try {
      const data = await getPostInformation(params.screenName, params.tweetId);
      const duration = Date.now() - startTime;

      const parsed = VxTwitterStatus.safeParse(data);
      if (!parsed.success) {
        logger.error("VxTwitterApi: Response validation failed", {
          url,
          issues: parsed.error.issues,
          duration: `${duration}ms`,
        });
        return undefined;
      }

      logger.info("VxTwitterApi: Request completed", {
        url,
        statusCode: 200,
        duration: `${duration}ms`,
      });
      return parsed.data;
    } catch (e) {
      const duration = Date.now() - startTime;

      if (e instanceof HttpResponseError) {
        if (e.status === 404) {
          logger.debug("VxTwitterApi: Tweet not found (404)", { url, duration: `${duration}ms` });
          return undefined;
        }

        if (e.status >= 500 && e.status <= 599) {
          logger.warn("VxTwitterApi: Server error, fallback will be attempted", {
            url,
            status: e.status,
            duration: `${duration}ms`,
          });
          throw new VxTwitterServerError(e.status, `VxTwitter API returned ${e.status} error for ${url}`);
        }
      }

      // 上流が JSON を返さなかった場合（HTML のエラーページ等）。
      // 回復可能でフォールバックも成立するため、スタックトレースは残さず warn に留める。
      if (e instanceof ResponseContentTypeError) {
        logger.warn("VxTwitterApi: Non-JSON response, fallback will be attempted", {
          url,
          contentType: e.contentType,
          duration: `${duration}ms`,
        });
        return undefined;
      }

      if (process.env.NODE_ENV !== "test") {
        logger.error("VxTwitterApi: API request failed", {
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

  private extractParams(url: string): { screenName: string; tweetId: string } | undefined {
    const match = url.match(/(?:api\.vxtwitter\.com|\/(?:x|twitter)(?:\.com)?)\/([^/]+)\/status\/(\d{2,20})/);
    if (!match) {
      return undefined;
    }
    return { screenName: match[1], tweetId: match[2] };
  }
}
