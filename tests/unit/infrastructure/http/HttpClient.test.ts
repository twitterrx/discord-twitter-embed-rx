import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("node:https", () => ({
  default: { request: vi.fn(), get: vi.fn() },
}));

import https from "node:https";

import { HttpClient } from "@/infrastructure/http/HttpClient";
import logger from "@/utils/logger";

type Handlers = Record<string, (...args: unknown[]) => void>;

/**
 * Node の ClientRequest を模したフェイク。
 *
 * req.setTimeout() はソケットの非アクティブタイムアウトであり、
 * レスポンスを受け取っても自動では解除されない。この性質を再現しないと
 * 「成功後にタイマーが残る」問題をテストで捕まえられないため、
 * グローバルタイマーへ登録したまま保持する。
 */
const createFakeRequest = () => {
  const handlers: Handlers = {};

  const req = {
    handlers,
    destroyed: false,
    on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
      handlers[event] = fn;
      return req;
    }),
    setTimeout: vi.fn((ms: number, fn: () => void) => {
      setTimeout(fn, ms);
      return req;
    }),
    destroy: vi.fn((err?: Error) => {
      req.destroyed = true;
      if (err) handlers.error?.(err);
    }),
    end: vi.fn(),
  };

  return req;
};

const createFakeResponse = (headers: Record<string, string>, statusCode = 200) => ({
  headers,
  statusCode,
  resume: vi.fn(),
  on: vi.fn(),
});

type ResponseLike = ReturnType<typeof createFakeResponse> | { statusCode: number; headers: object; on: unknown };
type FakeRequest = ReturnType<typeof createFakeRequest>;

/** https.request を差し替える。res を渡した場合のみレスポンスコールバックを呼ぶ */
const stubRequest = (req: FakeRequest, res?: ResponseLike): void => {
  vi.mocked(https.request).mockImplementation(((_url: unknown, _opts: unknown, cb?: (r: unknown) => void) => {
    if (res) cb?.(res);
    return req;
  }) as unknown as typeof https.request);
};

/** https.get を差し替える。res を渡した場合のみレスポンスコールバックを呼ぶ */
const stubGet = (req: FakeRequest, res?: ResponseLike): void => {
  vi.mocked(https.get).mockImplementation(((_url: unknown, cb?: (r: unknown) => void) => {
    if (res) cb?.(res);
    return req;
  }) as unknown as typeof https.get);
};

describe("HttpClient", () => {
  let client: HttpClient;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    client = new HttpClient();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("getFileSize", () => {
    it("Content-Length からサイズを返す", async () => {
      const req = createFakeRequest();
      stubRequest(req, createFakeResponse({ "content-length": "2943" }));

      await expect(client.getFileSize("https://example.test/a.mp4")).resolves.toBe(2943);
    });

    it("成功後に時間が経過しても error ログを出さない", async () => {
      const req = createFakeRequest();
      stubRequest(req, createFakeResponse({ "content-length": "2943" }));

      await client.getFileSize("https://example.test/a.mp4");

      // タイムアウト時間を大きく超えて進める
      await vi.advanceTimersByTimeAsync(30_000);

      expect(logger.error).not.toHaveBeenCalled();
      expect(req.destroy).not.toHaveBeenCalled();
    });

    it("応答が返らない場合はタイムアウトして reject する", async () => {
      const req = createFakeRequest();
      // レスポンスを渡さない＝応答なし
      stubRequest(req);

      const promise = client.getFileSize("https://example.test/slow.mp4");
      const assertion = expect(promise).rejects.toThrow(/timed out/);

      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;

      expect(req.destroy).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it("リクエスト生成が同期的に throw してもタイマーを残さない", async () => {
      vi.mocked(https.request).mockImplementation((() => {
        throw new Error("Invalid URL");
      }) as unknown as typeof https.request);

      await expect(client.getFileSize("not-a-url")).rejects.toThrow(/Invalid URL/);

      // タイマーが残ると 10 秒後に undefined.destroy() で TypeError となり
      // 未処理例外としてプロセスが落ちる
      expect(vi.getTimerCount()).toBe(0);
      // 残っていれば undefined.destroy() が投げられ、この行で失敗する
      await vi.advanceTimersByTimeAsync(30_000);
    });

    it("Content-Length がない場合は reject する", async () => {
      const req = createFakeRequest();
      stubRequest(req, createFakeResponse({}));

      await expect(client.getFileSize("https://example.test/a.mp4")).rejects.toThrow(/Content-Length/);
    });

    it("Content-Length がない場合も後続の error ログを出さない", async () => {
      const req = createFakeRequest();
      stubRequest(req, createFakeResponse({}));

      await expect(client.getFileSize("https://example.test/a.mp4")).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(30_000);

      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe("get", () => {
    const respondWith = (body: string, statusCode = 200) => {
      const req = createFakeRequest();
      stubGet(req, {
        statusCode,
        headers: {},
        on: vi.fn((event: string, fn: (chunk?: unknown) => void) => {
          if (event === "data") fn(body);
          if (event === "end") fn();
        }),
      });
      return req;
    };

    it("レスポンスボディを返す", async () => {
      respondWith("hello");

      await expect(client.get("https://example.test/a.json")).resolves.toBe("hello");
    });

    it("成功後に時間が経過しても error ログを出さない", async () => {
      const req = respondWith("hello");

      await client.get("https://example.test/a.json");
      await vi.advanceTimersByTimeAsync(30_000);

      expect(logger.error).not.toHaveBeenCalled();
      expect(req.destroy).not.toHaveBeenCalled();
    });

    it("リクエスト生成が同期的に throw してもタイマーを残さない", async () => {
      vi.mocked(https.get).mockImplementation((() => {
        throw new Error("Invalid URL");
      }) as unknown as typeof https.get);

      await expect(client.get("not-a-url")).rejects.toThrow(/Invalid URL/);

      expect(vi.getTimerCount()).toBe(0);
      // 残っていれば undefined.destroy() が投げられ、この行で失敗する
      await vi.advanceTimersByTimeAsync(30_000);
    });

    it("応答が返らない場合はタイムアウトして reject する", async () => {
      const req = createFakeRequest();
      stubGet(req);

      const promise = client.get("https://example.test/slow.json");
      const assertion = expect(promise).rejects.toThrow(/timed out/);

      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;

      expect(req.destroy).toHaveBeenCalledTimes(1);
    });
  });
});
