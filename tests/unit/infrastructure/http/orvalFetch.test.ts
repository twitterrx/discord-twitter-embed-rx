import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HttpResponseError,
  orvalFetch,
  ResponseContentTypeError,
} from "#/infrastructure/http/orvalFetch.js";

describe("orvalFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("JSON の成功レスポンスを返す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ text: "hello" }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        })
      )
    );

    await expect(orvalFetch<{ text: string }>("https://example.com/status/1", { method: "GET" })).resolves.toEqual({
      text: "hello",
    });
  });

  it("HTML 本文の 500 を解析せずステータス付きエラーにする", async () => {
    const response = new Response("<html>Internal Server Error</html>", {
      status: 500,
      statusText: "Internal Server Error",
      headers: { "content-type": "text/html" },
    });
    const cancel = vi.spyOn(response.body!, "cancel");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(orvalFetch("https://example.com/status/1", { method: "GET" })).rejects.toMatchObject({
      name: "HttpResponseError",
      status: 500,
    } satisfies Partial<HttpResponseError>);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("成功レスポンスが JSON でなければ拒否する", async () => {
    const response = new Response("plain text", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
    const cancel = vi.spyOn(response.body!, "cancel");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(orvalFetch("https://example.com/status/1", { method: "GET" })).rejects.toBeInstanceOf(
      ResponseContentTypeError
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("本文のキャンセル失敗で元の HTTP エラーを上書きしない", async () => {
    const response = new Response("Internal Server Error", { status: 500 });
    vi.spyOn(response.body!, "cancel").mockRejectedValue(new Error("cancel failed"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(orvalFetch("https://example.com/status/1", { method: "GET" })).rejects.toBeInstanceOf(
      HttpResponseError
    );
  });

  it("本文のない成功レスポンスは undefined を返す", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await expect(orvalFetch("https://example.com/status/1", { method: "GET" })).resolves.toBeUndefined();
  });
});
