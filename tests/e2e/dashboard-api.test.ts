/**
 * E2E テスト: Dashboard API
 *
 * NOTE: このテストは Dashboard が起動している状態で実行する必要があります。
 * Docker Compose 環境での実行を想定しています。
 *
 * 実行方法:
 *   1. Dashboard と Bot、Redis を起動: docker compose up -d
 *   2. E2E テストを実行: npm run test:e2e
 *   3. 環境変数でエンドポイントを指定: DASHBOARD_URL=http://localhost:4321 npm run test:e2e
 */

import { describe, it, expect, beforeAll } from "vitest";

/** Dashboard API のエラーレスポンス（このテストで参照する範囲のみ） */
interface ApiErrorResponse {
  success: boolean;
  error: { code: string };
}

const DASHBOARD_URL = process.env.DASHBOARD_URL || "http://localhost:4321";
const TEST_GUILD_ID = "123456789012345678";

let dashboardAvailable = false;

/**
 * Dashboard の到達性チェック
 */
async function checkDashboard(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    // トップページで判定（API エンドポイントがなくても動く）
    await fetch(DASHBOARD_URL, { signal: controller.signal });
    clearTimeout(timeout);
    return true;
  } catch {
    return false;
  }
}

describe("E2E: Dashboard API", () => {
  beforeAll(async () => {
    dashboardAvailable = await checkDashboard();
    if (!dashboardAvailable) {
      console.warn("[E2E] Dashboard is not reachable at", DASHBOARD_URL);
      console.warn("[E2E] Skipping Dashboard API E2E tests");
    }
  });

  // ── 認証なしアクセス: 全エンドポイントが 401 を返すこと ──

  describe("未認証リクエストの拒否", () => {
    it("GET /api/guilds → 401", async () => {
      if (!dashboardAvailable) return;

      const response = await fetch(`${DASHBOARD_URL}/api/guilds`);
      expect(response.status).toBe(401);

      const body = (await response.json()) as ApiErrorResponse;
      expect(body.success).toBe(false);
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("GET /api/guilds/:guildId/config → 401", async () => {
      if (!dashboardAvailable) return;

      const response = await fetch(`${DASHBOARD_URL}/api/guilds/${TEST_GUILD_ID}/config`);
      expect(response.status).toBe(401);

      const body = (await response.json()) as ApiErrorResponse;
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("PUT /api/guilds/:guildId/config → 401", async () => {
      if (!dashboardAvailable) return;

      const response = await fetch(`${DASHBOARD_URL}/api/guilds/${TEST_GUILD_ID}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ allowAllChannels: true, whitelistedChannelIds: [] }),
      });
      expect(response.status).toBe(401);

      const body = (await response.json()) as ApiErrorResponse;
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("GET /api/guilds/:guildId/audit-logs → 401", async () => {
      if (!dashboardAvailable) return;

      const response = await fetch(`${DASHBOARD_URL}/api/guilds/${TEST_GUILD_ID}/audit-logs`);
      expect(response.status).toBe(401);

      const body = (await response.json()) as ApiErrorResponse;
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("GET /api/guilds/:guildId/channels → 401", async () => {
      if (!dashboardAvailable) return;

      const response = await fetch(`${DASHBOARD_URL}/api/guilds/${TEST_GUILD_ID}/channels`);
      expect(response.status).toBe(401);

      const body = (await response.json()) as ApiErrorResponse;
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("POST /api/guilds/:guildId/channels → 401", async () => {
      if (!dashboardAvailable) return;

      const response = await fetch(`${DASHBOARD_URL}/api/guilds/${TEST_GUILD_ID}/channels`, {
        method: "POST",
        headers: { Origin: DASHBOARD_URL },
      });
      expect(response.status).toBe(401);

      const body = (await response.json()) as ApiErrorResponse;
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("POST /api/auth/logout → 401", async () => {
      if (!dashboardAvailable) return;

      const response = await fetch(`${DASHBOARD_URL}/api/auth/logout`, {
        method: "POST",
        redirect: "manual",
        headers: { Origin: DASHBOARD_URL },
      });
      expect(response.status).toBe(401);
    });
  });

  // ── OAuth ログインフロー ──

  describe("OAuth ログインフロー", () => {
    it("GET /api/auth/discord/login → Discord へリダイレクトする", async () => {
      if (!dashboardAvailable) return;

      const response = await fetch(`${DASHBOARD_URL}/api/auth/discord/login`, {
        redirect: "manual",
      });
      expect(response.status).toBe(302);

      const location = response.headers.get("Location");
      expect(location).toBeDefined();
      expect(location).toContain("discord.com");
      expect(location).toContain("oauth2");
    });
  });

  // ── セキュリティヘッダー ──

  describe("セキュリティヘッダー", () => {
    it("API レスポンスに Cache-Control: no-store が含まれる", async () => {
      if (!dashboardAvailable) return;

      const response = await fetch(`${DASHBOARD_URL}/api/guilds`);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("Content-Type")).toBe("application/json");
    });

    it("API レスポンスにセキュリティヘッダーが含まれる", async () => {
      if (!dashboardAvailable) return;

      const response = await fetch(`${DASHBOARD_URL}/api/guilds`);

      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("X-Frame-Options")).toBe("DENY");
      expect(response.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
      expect(response.headers.get("X-XSS-Protection")).toBe("0");
      expect(response.headers.get("Permissions-Policy")).toContain("camera=()");
    });
  });

  // ── 不正リクエスト ──

  describe("不正リクエストの拒否", () => {
    it("無効なセッション Cookie では 401 になる", async () => {
      if (!dashboardAvailable) return;

      const response = await fetch(`${DASHBOARD_URL}/api/guilds`, {
        headers: {
          Cookie: "session=invalid-session-id-that-does-not-exist",
        },
      });
      expect(response.status).toBe(401);
    });
  });
});
