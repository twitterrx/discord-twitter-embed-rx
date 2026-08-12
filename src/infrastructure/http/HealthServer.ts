import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { Hono } from "hono";

import logger from "#/utils/logger.js";

/**
 * ヘルスチェックで確認する依存コンポーネントの状態取得関数群
 */
export interface HealthCheckDependencies {
  isRedisReady: () => boolean;
  isDiscordReady: () => boolean;
  /** お知らせ配信コンシューマの稼働状態（未指定時はチェックしない） */
  isAnnouncementConsumerHealthy?: () => boolean;
}

export interface HealthCheckResult {
  status: "healthy" | "degraded";
  version: string;
  uptime: number;
  checks: {
    redis: boolean;
    discord: boolean;
    announcementConsumer?: boolean;
  };
}

/**
 * ヘルスチェック用 HTTP サーバー
 *
 * 提供するエンドポイント:
 *   GET /healthz  - Liveness Probe（常に200）
 *   GET /readyz   - Readiness Probe（依存が全て READY なら200、それ以外は503）
 *   GET /health   - 詳細なヘルス情報（JSON）
 *
 * デフォルトポートは 9090。環境変数 HEALTH_PORT で上書き可能。
 *
 * 内部実装には Hono を使用しており、テスト時は `honoApp` から `app.request()` を
 * 直接呼び出すことでサーバー起動なしにリクエストを発行できる。
 */
export class HealthServer {
  readonly honoApp: Hono;
  private server: ServerType | undefined;
  private port: number;

  constructor(deps: HealthCheckDependencies, port?: number, appVersion?: string) {
    this.port = port ?? (Number(process.env.HEALTH_PORT) || 9090);
    this.honoApp = this.buildApp(deps, appVersion ?? "unknown");
  }

  // ============================================================
  // Hono アプリケーションの構築
  // ============================================================

  private buildApp(deps: HealthCheckDependencies, version: string): Hono {
    const app = new Hono();

    // GET /healthz — Liveness Probe
    app.get("/healthz", (c) => {
      return c.json({ status: "ok" });
    });

    // GET /readyz — Readiness Probe
    app.get("/readyz", (c) => {
      const redis = deps.isRedisReady();
      const discord = deps.isDiscordReady();
      const consumer = deps.isAnnouncementConsumerHealthy?.();
      const ready = redis && discord && consumer !== false;

      const checks = consumer === undefined ? { redis, discord } : { redis, discord, announcementConsumer: consumer };

      return c.json({ status: ready ? "ok" : "not ready", checks }, ready ? 200 : 503);
    });

    // GET /health — Full Health
    app.get("/health", (c) => {
      const redis = deps.isRedisReady();
      const discord = deps.isDiscordReady();
      const consumer = deps.isAnnouncementConsumerHealthy?.();
      const healthy = redis && discord && consumer !== false;

      const body: HealthCheckResult = {
        status: healthy ? "healthy" : "degraded",
        version,
        uptime: process.uptime(),
        checks: consumer === undefined ? { redis, discord } : { redis, discord, announcementConsumer: consumer },
      };

      return c.json(body, healthy ? 200 : 503);
    });

    // 404 fallback
    app.notFound((c) => {
      return c.json({ error: "not found" }, 404);
    });

    return app;
  }

  // ============================================================
  // ライフサイクル
  // ============================================================

  /**
   * 実際にリッスンしているポート番号。start() 呼び出し前は undefined。
   */
  get listeningPort(): number | undefined {
    if (!this.server) return undefined;
    const addr = this.server.address();
    if (addr && typeof addr === "object") {
      return addr.port;
    }
    return undefined;
  }

  /**
   * ヘルスチェックサーバーを起動する
   */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server = serve(
        {
          fetch: this.honoApp.fetch,
          port: this.port,
          hostname: "0.0.0.0",
        },
        (info) => {
          logger.info(`[HealthServer] Listening on 0.0.0.0:${info.port}`);
          resolve();
        }
      );
    });
  }

  /**
   * ヘルスチェックサーバーを停止する
   */
  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => {
        if (err) {
          logger.error(`[HealthServer] Error during shutdown: ${err.message}`);
          reject(err);
          return;
        }
        logger.info("[HealthServer] Stopped");
        this.server = undefined;
        resolve();
      });
    });
  }
}
