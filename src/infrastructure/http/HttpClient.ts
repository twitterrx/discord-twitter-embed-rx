import https from "node:https";

import { IFileSizeChecker } from "@/core/services/MediaHandler";
import logger from "@/utils/logger";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * HTTPリクエストを担当
 */
export class HttpClient implements IFileSizeChecker {
  /**
   * URLのファイルサイズを取得
   * @param url 対象URL
   * @returns ファイルサイズ（バイト）
   */
  async getFileSize(url: string): Promise<number> {
    const startTime = Date.now();
    logger.debug("HTTP HEAD request started", { url });

    return new Promise((resolve, reject) => {
      // req.setTimeout() はソケットの非アクティブタイムアウトであり、
      // レスポンス受信後も解除されない。keepAlive でソケットがプールに残ると
      // 成功済みのリクエストに対して発火してしまうため、明示的に管理する。
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const settle = (finish: () => void): void => {
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        finish();
      };

      const req = https.request(url, { method: "HEAD" }, (res) => {
        // HEAD にボディはないが、明示的に消費してソケットを解放する
        res.resume();

        const duration = Date.now() - startTime;
        const contentLength = res.headers["content-length"];

        if (contentLength) {
          const size = parseInt(contentLength, 10);
          logger.debug("HTTP HEAD request completed", {
            url,
            statusCode: res.statusCode,
            contentLength: size,
            duration: `${duration}ms`,
          });
          settle(() => resolve(size));
        } else {
          logger.warn("HTTP HEAD request missing Content-Length header", {
            url,
            statusCode: res.statusCode,
            duration: `${duration}ms`,
          });
          settle(() => reject(new Error("Could not get Content-Length Header...")));
        }
      });

      req.on("error", (err) => {
        const duration = Date.now() - startTime;
        settle(() => {
          logger.error("HTTP HEAD request failed", { url, error: err.message, duration: `${duration}ms` });
          reject(err);
        });
      });

      // リクエスト生成が同期的に throw した場合はここへ到達せず、タイマーも作られない。
      // 同期的に解決済みの場合もタイマーは不要。
      if (!settled) {
        timer = setTimeout(() => {
          req.destroy(new Error(`HTTP HEAD request timed out after ${REQUEST_TIMEOUT_MS}ms`));
        }, REQUEST_TIMEOUT_MS);
      }

      req.end();
    });
  }

  /**
   * GETリクエストを実行
   * @param url リクエストURL
   * @returns レスポンスボディ
   */
  async get(url: string): Promise<string> {
    const startTime = Date.now();
    logger.debug("HTTP GET request started", { url });

    return new Promise((resolve, reject) => {
      // getFileSize と同じ理由でタイマーを明示的に管理する
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const settle = (finish: () => void): void => {
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        finish();
      };

      const req = https
        .get(url, (res) => {
          let data = "";
          let dataSize = 0;

          res.on("data", (chunk) => {
            dataSize += chunk.length;
            if (dataSize > MAX_RESPONSE_SIZE) {
              req.destroy(new Error(`Response exceeded maximum size of ${MAX_RESPONSE_SIZE} bytes`));
              return;
            }
            data += chunk;
          });

          res.on("end", () => {
            const duration = Date.now() - startTime;
            if (res.statusCode === 200) {
              logger.debug("HTTP GET request completed", {
                url,
                statusCode: res.statusCode,
                responseSize: data.length,
                duration: `${duration}ms`,
              });
              settle(() => resolve(data));
            } else {
              logger.error("HTTP GET request failed", { url, statusCode: res.statusCode, duration: `${duration}ms` });
              settle(() => reject(new Error(`Request failed with status ${res.statusCode}`)));
            }
          });
        })
        .on("error", (err) => {
          const duration = Date.now() - startTime;
          settle(() => {
            logger.error("HTTP GET request error", { url, error: err.message, duration: `${duration}ms` });
            reject(err);
          });
        });

      // リクエスト生成が同期的に throw した場合はここへ到達せず、タイマーも作られない
      if (!settled) {
        timer = setTimeout(() => {
          req.destroy(new Error(`HTTP GET request timed out after ${REQUEST_TIMEOUT_MS}ms`));
        }, REQUEST_TIMEOUT_MS);
      }
    });
  }
}
