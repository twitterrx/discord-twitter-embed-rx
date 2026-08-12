import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { vi } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, "../fixtures/fxtwitter");

/**
 * 外部 Twitter API（vxTwitter / FxTwitter）を fetch 層で差し替えるスタブ。
 *
 * ITwitterAdapter ごと差し替えると、生成クライアントのパースも Tweet への変換も
 * フォールバックの分岐も通らず、守備範囲が単体テストとほとんど重ならない。
 * ここでは fetch だけを差し替えることで、
 *   生成クライアント → orvalFetch → VxTwitterAdapter / FxTwitterAdapter → TwitterAdapter
 * を全て本物のまま通す。
 *
 * VxTwitterAdapter / FxTwitterAdapter の transformUrl は
 * `x.com` を `api.vxtwitter.com` / `api.fxtwitter.com` へ書き換えるため、
 * ホスト名で応答を出し分ければ「vx が落ちて fx へフォールバックする」経路も再現できる。
 */

/** 1 ホストぶんの応答の決め方 */
export type StubResponse =
  | { kind: "json"; body: unknown }
  /** FxTwitter の保存済み fixture をそのまま返す（tests/fixtures/fxtwitter/<name>.json） */
  | { kind: "fixture"; name: string }
  | { kind: "status"; status: number; body?: string; contentType?: string };

export interface TwitterApiStubPlan {
  /** api.vxtwitter.com への応答 */
  vx: StubResponse;
  /** api.fxtwitter.com への応答 */
  fx: StubResponse;
}

/** 保存済み fixture を読む。実 API の payload をそのまま置いてあるもの */
export const readFixture = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${name}.json`), "utf8"));

const toResponse = (spec: StubResponse): Response => {
  switch (spec.kind) {
    case "json":
      return new Response(JSON.stringify(spec.body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    case "fixture":
      return new Response(JSON.stringify(readFixture(spec.name)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    case "status":
      return new Response(spec.body ?? "", {
        status: spec.status,
        headers: { "content-type": spec.contentType ?? "text/html" },
      });
  }
};

export interface TwitterApiStub {
  /** 実際に要求された URL の一覧。どのアダプタまで到達したかを検証できる */
  readonly calls: string[];
}

/**
 * fetch をホスト名でルーティングするスタブに差し替える。
 *
 * 解除は vi.unstubAllGlobals()（afterEach で呼ぶこと）。
 */
export const stubTwitterApi = (plan: TwitterApiStubPlan): TwitterApiStub => {
  const calls: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown) => {
      // fetch の第一引数は文字列・URL・Request のいずれも取りうる
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : String((input as { url?: unknown }).url);
      calls.push(url);

      const { hostname } = new URL(url);

      if (hostname === "api.vxtwitter.com") {
        return Promise.resolve(toResponse(plan.vx));
      }

      if (hostname === "api.fxtwitter.com") {
        return Promise.resolve(toResponse(plan.fx));
      }

      // 想定外の外向き通信は、握りつぶさず落とす。
      // 黙って通すと、テストが気付かないうちに実ネットワークへ出てしまう。
      return Promise.reject(new Error(`[e2e] 想定外の fetch: ${url}`));
    })
  );

  return { calls };
};

/**
 * vxTwitter の正常応答を組み立てる
 *
 * vx には保存済み fixture が無いため、生成スキーマ（VxTwitterStatus）の必須項目を
 * 満たす最小の payload をここで組む。fx 側は実 API の fixture を使うので、
 * 「手書きの思い込み」だけでフローを検証することにはならない。
 */
export const vxStatus = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  date: "Sun Dec 22 12:00:00 +0000 2024",
  likes: 100,
  replies: 10,
  retweets: 50,
  text: "vx から取得した本文",
  tweetURL: "https://x.com/test_user/status/1870044090072739960",
  user_name: "Test User",
  user_screen_name: "test_user",
  user_profile_image_url: "https://pbs.twimg.com/profile_images/test.jpg",
  mediaURLs: [],
  media_extended: [],
  ...overrides,
});
