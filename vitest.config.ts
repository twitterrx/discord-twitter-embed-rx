import path from "path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    exclude: ["node_modules", "dist"],
    globalSetup: "./tests/globalSetup.ts",
    env: {
      NODE_ENV: "test",
    },
    // CI環境での統合テストの安定性向上
    retry: process.env.CI ? 2 : 0,
    testTimeout: process.env.CI ? 30000 : 10000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/",
        "dist/",
        // テストコードは計測対象ではない。*.test.ts だけを除くと、
        // ヘルパーやフェイク（tests/e2e/discordFake.ts 等）が素通りして
        // 計測に混ざる。依存を要するテストが skip された実行では、
        // それらは import されるだけで実行率が落ち、数字を歪める。
        "tests/**",
        "**/*.test.ts",
        "**/*.spec.ts",
        "src/**/generated/**",
      ],
    },
  },
  resolve: {
    alias: {
      "#": path.resolve(__dirname, "./src"),
    },
  },
});
