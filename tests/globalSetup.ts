import { TestMediaServer } from "./fixtures/mediaServer.js";

let server: TestMediaServer | undefined;

/**
 * vitest の globalSetup
 *
 * テストメディアサーバーを起動し、ポート番号を環境変数 TEST_MEDIA_PORT に設定する。
 * このポート値は各テストワーカーから参照可能。
 */
export async function setup(): Promise<void> {
  server = new TestMediaServer();
  await server.start();
  // 動的に割り当てられたポートがあれば環境変数に反映
  const actualPort = server.listeningPort;
  if (actualPort && actualPort !== server.port) {
    process.env.TEST_MEDIA_PORT = String(actualPort);
  }
}

/**
 * vitest の globalTeardown
 *
 * テストメディアサーバーを停止する。
 */
export async function teardown(): Promise<void> {
  if (server) {
    await server.stop();
    server = undefined;
  }
}
