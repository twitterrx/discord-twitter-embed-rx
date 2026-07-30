# E2E テスト

このディレクトリには、TwitterRX の E2E（エンドツーエンド）テストが含まれています。

## 📋 概要

E2E テストは、システム全体の動作を確認するためのテストです。実際の Redis や Dashboard API に対してテストを実行します。

## 🎯 テストの種類

### 1. チャンネル設定テスト (`channel-config.test.ts`)

Bot のチャンネル設定機能の E2E テストです：

- 設定の取得
- チャンネル許可判定
- キャッシュ機能
- ギルド参加・離脱
- クリーンアップ

### 2. Dashboard API テスト (`dashboard-api.test.ts`)

Dashboard の API エンドポイントの E2E テストです：

- 認証チェック
- ギルド一覧取得
- ギルド設定の取得・保存
- 監査ログの取得

## 🚀 実行方法

### 前提条件

E2E テストを実行する前に、以下が必要です：

1. **Redis が起動していること（必須）**
   ```bash
   # Redis をDocker で起動
   docker run -d -p 6379:6379 redis:7-alpine
   
   # または Docker Compose で起動
   docker compose up -d redis
   ```

2. Dashboard が起動していること（Dashboard API テストの場合）

### 実行前の確認

Redis が起動しているか確認してください：
```bash
redis-cli ping
# => PONG が返ればOK
```

### Docker Compose 環境での実行

```bash
# 1. サービスを起動
docker compose up -d

# 2. E2E テストを実行
npm run test:e2e

# 3. 特定のテストファイルのみ実行
npm run test:e2e -- tests/e2e/channel-config.test.ts
```

### ローカル環境での実行

```bash
# 1. Redis を起動（Docker を使用）
docker run -d -p 6379:6379 redis:7-alpine

# 2. 環境変数を設定
export REDIS_URL=redis://localhost:6379

# 3. E2E テストを実行
npm run test:e2e
```

## 🔧 環境変数

| 変数名 | 説明 | デフォルト |
|--------|------|-----------|
| `REDIS_URL` | Redis 接続 URL | `redis://localhost:6379` |
| `DASHBOARD_URL` | Dashboard のベース URL | `http://localhost:4321` |
| `CONFIG_NOT_FOUND_FALLBACK` | 設定未作成時の挙動 | `allow` |
| `REDIS_DOWN_FALLBACK` | Redis 障害時の挙動 | `allow` |

## 📝 テストの書き方

### 基本的なテスト構造

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { getTestRedis, closeTestRedis, setupTestGuildConfig, generateTestGuildId } from "./helpers";

describe("E2E: 新しい機能", () => {
  let testGuildId: string;

  beforeAll(async () => {
    await getTestRedis();
  });

  afterAll(async () => {
    await closeTestRedis();
  });

  beforeEach(() => {
    testGuildId = generateTestGuildId();
  });

  it("テストケース", async () => {
    // テストの実装
  });
});
```

### ヘルパー関数の使用

```typescript
import {
  getTestRedis,
  closeTestRedis,
  cleanupTestData,
  setupTestGuildConfig,
  generateTestGuildId,
  getRedisValue,
} from "./helpers";

// テスト用のギルド設定をセットアップ
await setupTestGuildConfig(testGuildId, {
  allowAllChannels: false,
  whitelist: ["channel-1", "channel-2"],
  version: 1,
});

// Redis の値を直接確認
const value = await getRedisValue(`app:guild:${testGuildId}:config`);

// テストデータのクリーンアップ
await cleanupTestData(testGuildId);
```

## ⚠️ 注意事項

1. **テスト用のギルド ID を使用**  
   本番データと混在しないよう、`generateTestGuildId()` を使用してランダムな ID を生成します。

2. **テストデータのクリーンアップ**  
   各テストの後にデータをクリーンアップして、他のテストに影響を与えないようにします。

3. **Redis の状態確認**  
   テスト前に Redis が起動しているか確認してください：
   ```bash
   redis-cli ping
   # => PONG
   ```

4. **認証付きテスト**  
   Dashboard API の認証付きテストは、モック OAuth サーバーやテスト用トークンのセットアップが必要です。

## 🎨 カバレッジ

E2E テストのカバレッジを確認する場合：

```bash
npm run test:coverage -- tests/e2e
```

## 🐛 トラブルシューティング

### Redis 接続エラー

```
Error: connect ECONNREFUSED 127.0.0.1:6379
```

**解決策**：Redis が起動していることを確認します。

```bash
docker ps | grep redis
```

### タイムアウトエラー

```
Test timed out in 10000ms.
```

**解決策**：`vitest.config.ts` でタイムアウト時間を延長します。

```typescript
test: {
  testTimeout: 30000, // 30秒
}
```

### Dashboard 接続エラー

```
fetch failed
```

**解決策**：Dashboard が起動していることと、正しい URL が設定されていることを確認します。

```bash
curl http://localhost:4321/api/health
```

## 📚 参考資料

- [Vitest 公式ドキュメント](https://vitest.dev/)
- [Redis コマンドリファレンス](https://redis.io/commands/)
- [仕様書: DASHBOARD_SPEC.md](../../docs/DASHBOARD_SPEC.md)
