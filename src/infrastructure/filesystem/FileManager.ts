import fs from "node:fs/promises";
import path from "node:path";

import { IFileManager } from "#/adapters/discord/MessageHandler.js";
import logger from "#/utils/logger.js";

/**
 * ファイルシステム操作を担当
 */
export class FileManager implements IFileManager {
  constructor(private readonly baseTmpDir: string) {}

  /**
   * 一時ディレクトリを作成
   * @returns 作成したディレクトリのパス
   */
  async createTempDirectory(): Promise<string> {
    try {
      await fs.mkdir(this.baseTmpDir, { recursive: true });
      logger.debug(`Temporary directory created: ${this.baseTmpDir}`);
      return this.baseTmpDir;
    } catch (error) {
      logger.error("Failed to create temp directory", {
        error: error instanceof Error ? error.message : String(error),
        path: this.baseTmpDir,
      });
      throw error;
    }
  }

  /**
   * 指定パスにディレクトリを作成
   * @param dirPath ディレクトリパス
   * @returns 作成したディレクトリのパス
   */
  async createDirectory(dirPath: string): Promise<string> {
    try {
      await fs.mkdir(dirPath, { recursive: true });
      logger.debug(`Directory created: ${dirPath}`);
      return dirPath;
    } catch (error) {
      logger.error("Failed to create directory", {
        error: error instanceof Error ? error.message : String(error),
        path: dirPath,
      });
      throw error;
    }
  }

  /**
   * 一時ディレクトリを削除
   * @param dir ディレクトリパス
   */
  async removeTempDirectory(dir: string): Promise<void> {
    try {
      await fs.rm(dir, { recursive: true });
      logger.debug(`Temporary directory removed: ${dir}`);
    } catch (error) {
      logger.error("Failed to remove temp directory", {
        error: error instanceof Error ? error.message : String(error),
        path: dir,
      });
      // ディレクトリ削除の失敗は致命的ではないのでエラーをスローしない
    }
  }

  /**
   * ディレクトリ内のファイル一覧を取得
   * @param dir ディレクトリパス
   * @returns ファイル名の配列
   */
  async listFiles(dir: string): Promise<string[]> {
    try {
      const files = await fs.readdir(dir);
      return files;
    } catch (error) {
      logger.error("Failed to list files in directory", {
        error: error instanceof Error ? error.message : String(error),
        path: dir,
      });
      return [];
    }
  }

  /**
   * ファイルが存在するか確認
   * @param filePath ファイルパス
   * @returns 存在する場合true
   */
  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * ファイルのフルパスを取得
   * @param dir ディレクトリパス
   * @param filename ファイル名
   * @returns フルパス
   */
  getFullPath(dir: string, filename: string): string {
    return path.join(dir, filename);
  }
}
