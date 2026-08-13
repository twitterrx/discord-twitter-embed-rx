import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HealthServer } from "#/infrastructure/http/HealthServer.js";

import type { HealthCheckDependencies } from "#/infrastructure/http/HealthServer.js";

// logger をモック
vi.mock("#/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const createMockDeps = (
  overrides: Partial<HealthCheckDependencies> = {},
): HealthCheckDependencies => ({
  isRedisReady: vi.fn().mockReturnValue(true),
  isDiscordReady: vi.fn().mockReturnValue(true),
  ...overrides,
});

describe("HealthServer", () => {
  let server: HealthServer;
  let deps: HealthCheckDependencies;

  beforeEach(() => {
    deps = createMockDeps();
    server = new HealthServer(deps, 0);
  });

  afterEach(async () => {
    try {
      await server.stop();
    } catch {
      // 停止済みの場合は無視
    }
  });

  // -----------------------------------------------------------
  // Hono アプリケーションの直接テスト (app.request)
  // -----------------------------------------------------------
  describe("Hono routes", () => {
    // /healthz — Liveness Probe
    describe("GET /healthz", () => {
      it("should return 200 with status ok", async () => {
        const res = await server.honoApp.request("/healthz");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: "ok" });
      });
    });

    // /readyz — Readiness Probe
    describe("GET /readyz", () => {
      it("should return 200 when all dependencies are ready", async () => {
        const res = await server.honoApp.request("/readyz");
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({
          status: "ok",
          checks: { redis: true, discord: true },
        });
      });

      it("should return 503 when Redis is not ready", async () => {
        deps.isRedisReady = vi.fn().mockReturnValue(false);
        const res = await server.honoApp.request("/readyz");
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({
          status: "not ready",
          checks: { redis: false, discord: true },
        });
      });

      it("should return 503 when Discord is not ready", async () => {
        deps.isDiscordReady = vi.fn().mockReturnValue(false);
        const res = await server.honoApp.request("/readyz");
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({
          status: "not ready",
          checks: { redis: true, discord: false },
        });
      });

      it("should return 503 when both dependencies are not ready", async () => {
        deps.isRedisReady = vi.fn().mockReturnValue(false);
        deps.isDiscordReady = vi.fn().mockReturnValue(false);
        const res = await server.honoApp.request("/readyz");
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({
          status: "not ready",
          checks: { redis: false, discord: false },
        });
      });
    });

    // /health — Full Health Check
    describe("GET /health", () => {
      it("should return 200 with full details when healthy", async () => {
        const res = await server.honoApp.request("/health");
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({
          status: "healthy",
          checks: { redis: true, discord: true },
        });
        expect(body).toHaveProperty("version");
        expect(body).toHaveProperty("uptime");
      });

      it("should return 503 with degraded status when Redis is down", async () => {
        deps.isRedisReady = vi.fn().mockReturnValue(false);
        const res = await server.honoApp.request("/health");
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({
          status: "degraded",
          checks: { redis: false, discord: true },
        });
      });

      it("should include app version string", async () => {
        const s = new HealthServer(deps, 0, "1.0.0-test");
        const res = await s.honoApp.request("/health");
        const body = await res.json();
        expect(body).toMatchObject({ version: "1.0.0-test" });
      });
    });

    // 404 — unknown paths
    describe("unknown path", () => {
      it("should return 404 for unknown paths", async () => {
        const res = await server.honoApp.request("/unknown");
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "not found" });
      });
    });
  });

  // -----------------------------------------------------------
  // 実サーバーの起動 / 停止
  // -----------------------------------------------------------
  describe("start / stop", () => {
    it("should start and stop without error", async () => {
      await server.start();
      expect(server.listeningPort).toBeGreaterThan(0);
      await expect(server.stop()).resolves.toBeUndefined();
    });

    it("should use default port 9090 when no port specified and no env var", () => {
      delete process.env.HEALTH_PORT;
      const s = new HealthServer(deps);
      expect((s as unknown as { port: number }).port).toBe(9090);
    });

    it("should use HEALTH_PORT env var when no constructor port given", () => {
      process.env.HEALTH_PORT = "8080";
      const s = new HealthServer(deps);
      expect((s as unknown as { port: number }).port).toBe(8080);
      delete process.env.HEALTH_PORT;
    });

    it("should prefer constructor port over env var", () => {
      process.env.HEALTH_PORT = "8080";
      const s = new HealthServer(deps, 3000);
      expect((s as unknown as { port: number }).port).toBe(3000);
      delete process.env.HEALTH_PORT;
    });
  });

  // -----------------------------------------------------------
  // お知らせ配信コンシューマのヘルスチェック
  // -----------------------------------------------------------
  describe("announcement consumer health", () => {
    it("dep 未指定時は checks に announcementConsumer を含めない", async () => {
      const res = await server.honoApp.request("/health");
      const body = (await res.json()) as { checks: Record<string, unknown> };
      expect(body.checks).not.toHaveProperty("announcementConsumer");
    });

    it("consumer が健全なら readyz は 200 で consumer=true を返す", async () => {
      const s = new HealthServer(createMockDeps({ isAnnouncementConsumerHealthy: () => true }), 0);
      const res = await s.honoApp.request("/readyz");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        status: "ok",
        checks: { redis: true, discord: true, announcementConsumer: true },
      });
    });

    it("consumer が不健全なら readyz は 503 を返す", async () => {
      const s = new HealthServer(createMockDeps({ isAnnouncementConsumerHealthy: () => false }), 0);
      const res = await s.honoApp.request("/readyz");
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        status: "not ready",
        checks: { announcementConsumer: false },
      });
    });
  });

  // -----------------------------------------------------------
  // 実サーバー経由（結合動作確認）
  // -----------------------------------------------------------
  describe("real HTTP server", () => {
    it("should handle healthz via actual server", async () => {
      await server.start();
      const res = await server.honoApp.request(`http://127.0.0.1:${server.listeningPort}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
    });
  });
});
