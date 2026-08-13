import { createWriteStream } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";

import { IVideoDownloader } from "#/adapters/discord/MessageHandler.js";
import logger from "#/utils/logger.js";

/**
 * 動画ダウンロードを担当
 */
export class VideoDownloader implements IVideoDownloader {
  /**
   * 動画をダウンロード
   * @param url ダウンロードURL
   * @param outputPath 保存先パス
   */
  async download(url: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = url.startsWith("https") ? https : http;

      client
        .get(url, (response: http.IncomingMessage) => {
          if (response.statusCode !== 200) {
            // メモリリーク防止
            response.resume();
            reject(new Error(`Failed to download file: ${response.statusCode}`));
            return;
          }

          // 書き込みストリーム作成
          const fileStream = createWriteStream(outputPath);
          // ストリームへデータをパイプする
          response.pipe(fileStream);

          fileStream.on("finish", () => {
            fileStream.close();
            logger.debug(`Download complete: ${outputPath}`);
            resolve();
          });

          fileStream.on("error", (err) => {
            fileStream.close();
            reject(err);
          });
        })
        .on("error", (err: Error) => {
          reject(err);
        });
    });
  }
}
