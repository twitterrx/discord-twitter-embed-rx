import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "url";

import { load } from "js-yaml";

// ESM では import.meta.url から __dirname を取得
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ルートディレクトリ取得
export const ROOT_DIR = path.resolve(__dirname, "../..");

// ログ設定の型定義
export interface LoggingConfig {
  maxFiles: string;
  maxSize: string;
  logLevel: "debug" | "info" | "warn" | "error";
  separateErrorLog: boolean;
}

// アプリケーション設定の型定義
export interface AppConfig {
  /** 添付上限の任意キャップ。未設定時は guild のブーストレベルから決定する */
  MEDIA_MAX_FILE_SIZE?: number;
  LOGGING: LoggingConfig;
}

const configPath = path.join(ROOT_DIR, ".config/config.yml");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let config: any = {};
try {
  const fileContents = fs.readFileSync(configPath, "utf8");
  config = load(fileContents);
} catch (e) {
  console.error("設定ファイルの読み込みに失敗しました。config.ymlを確認してください", e);
}

// 環境変数から NODE_ENV を取得
const nodeEnv = process.env.NODE_ENV || "production";

// ログレベルを決定（優先順位: 環境変数 LOG_LEVEL > config.yml > デフォルト値）
const getLogLevel = (): "debug" | "info" | "warn" | "error" => {
  const envLogLevel = process.env.LOG_LEVEL?.toLowerCase();
  if (envLogLevel && ["debug", "info", "warn", "error"].includes(envLogLevel)) {
    return envLogLevel as "debug" | "info" | "warn" | "error";
  }

  const configLogLevel = config.logging?.logLevel?.toLowerCase();
  if (configLogLevel && ["debug", "info", "warn", "error"].includes(configLogLevel)) {
    return configLogLevel as "debug" | "info" | "warn" | "error";
  }

  // デフォルト: 本番環境では info、開発環境では debug
  return nodeEnv === "production" ? "info" : "debug";
};

const appConfig: AppConfig = {
  MEDIA_MAX_FILE_SIZE: config.media_max_file_size,
  LOGGING: {
    maxFiles: config.logging?.maxFiles || "14d",
    maxSize: config.logging?.maxSize || "20m",
    logLevel: getLogLevel(),
    separateErrorLog: config.logging?.separateErrorLog ?? true,
  },
};

export default appConfig;
