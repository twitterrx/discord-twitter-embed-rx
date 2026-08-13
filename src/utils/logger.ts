import path from "path";

import chalk from "chalk";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";

import config, { ROOT_DIR } from "#/config/config.js";

// コンソール用カラーフォーマット
const consoleColorFormat = winston.format.printf(({ timestamp, level, message, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";

  // レベル別の色付け
  let coloredLevel = level.toUpperCase();
  switch (level) {
    case "error":
      coloredLevel = chalk.red.bold(coloredLevel);
      break;
    case "warn":
      coloredLevel = chalk.yellow.bold(coloredLevel);
      break;
    case "info":
      coloredLevel = chalk.cyan.bold(coloredLevel);
      break;
    case "debug":
      coloredLevel = chalk.gray.bold(coloredLevel);
      break;
    default:
      coloredLevel = chalk.white.bold(coloredLevel);
  }

  const coloredTimestamp = chalk.gray(`[${timestamp}]`);
  return `${coloredTimestamp} [${coloredLevel}] ${message}${metaStr}`;
});

// Docker ではマウント先を環境変数で指定し、未指定時は既存の出力先を維持する
const logDir = path.resolve(process.env.LOG_DIR ?? path.join(ROOT_DIR, "../logs"));

// トランスポートの設定
const transports: winston.transport[] = [
  // 1. コンソール出力（色付き、人間可読形式）
  new winston.transports.Console({
    format: winston.format.combine(winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), consoleColorFormat),
  }),

  // 2. 通常ログファイル（JSON形式、全レベル）
  new DailyRotateFile({
    dirname: logDir,
    filename: "app-%DATE%.log",
    datePattern: "YYYY-MM-DD",
    maxFiles: config.LOGGING.maxFiles,
    maxSize: config.LOGGING.maxSize,
    format: winston.format.combine(winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }), winston.format.json()),
  }),
];

// 3. エラーログファイル（JSON形式、errorレベルのみ）
if (config.LOGGING.separateErrorLog) {
  transports.push(
    new DailyRotateFile({
      dirname: logDir,
      filename: "error-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxFiles: config.LOGGING.maxFiles,
      maxSize: config.LOGGING.maxSize,
      level: "error",
      format: winston.format.combine(
        winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        winston.format.json()
      ),
    })
  );
}

// Winstonロガーの作成
const logger = winston.createLogger({
  level: config.LOGGING.logLevel,
  transports,
  exitOnError: false,
});

// ロガーの初期化メッセージ
logger.info("Logger initialized", {
  logLevel: config.LOGGING.logLevel,
  maxFiles: config.LOGGING.maxFiles,
  maxSize: config.LOGGING.maxSize,
  separateErrorLog: config.LOGGING.separateErrorLog,
  logDir,
});

export default logger;
