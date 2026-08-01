# アーキテクチャ設計

このプロジェクトは**軽量レイヤードアーキテクチャ**を採用しています。

## システム全体構成

```
┌───────────────────────────────────────────────┐
│                   Discord                      │
└──────────┬────────────────────────┬────────────┘
           │ メッセージ受信          │ Embed 返信
           ▼                        ▲
┌──────────────────────────────────────────────┐
│              Bot (Node.js)                    │
│  index.ts ── DI で全レイヤーを組み立て         │
│                                               │
│  ┌─────────┐  ┌──────────┐  ┌──────────────┐ │
│  │ Core 層  │←│Adapter 層│←│Infrastructure│ │
│  └─────────┘  └──────────┘  └──────────────┘ │
└──────────┬────────────────────────────────────┘
           │ Pub/Sub・キャッシュ・設定
           ▼
┌──────────────────┐    ┌─────────────────────┐
│   Redis 8        │◄───│  Dashboard (Astro)   │
│  (キャッシュ/     │    │  SQLite + Drizzle    │
│   Pub/Sub)       │    │  Discord OAuth2      │
└──────────────────┘    └─────────────────────┘
```

### コンポーネント間通信

| 経路                    | プロトコル | 用途                                           |
| ----------------------- | ---------- | ---------------------------------------------- |
| Bot ↔ Redis             | redis://   | 設定キャッシュ、Pub/Sub 更新通知、リプライログ |
| Dashboard → Redis       | redis://   | 設定書き込み、バージョンハートビート           |
| Dashboard → SQLite      | file://    | 設定の永続化（Source of Truth）                |
| Bot ← Redis ← Dashboard | Pub/Sub    | 設定変更のリアルタイム反映                     |

## Bot ソース構造

```
src/
├── index.ts                          # エントリーポイント（DI）
├── config/
│   └── config.ts                     # アプリケーション設定（config.yml 読み込み）
├── core/                             # コア層（ビジネスロジック）
│   ├── models/
│   │   └── Tweet.ts                 # ツイートの統一モデル
│   └── services/
│       ├── TweetProcessor.ts        # URL 抽出・スポイラー判定
│       ├── MediaHandler.ts          # メディア分類・フィルタリング
│       └── ChannelConfigService.ts  # チャンネル許可判定・フォールバック
├── adapters/                         # アダプター層
│   ├── discord/
│   │   ├── MessageHandler.ts        # メッセージ受信・返信処理
│   │   └── EmbedBuilder.ts          # Discord Embed 生成
│   └── twitter/
│       ├── BaseTwitterAdapter.ts    # 共通基底クラス
│       ├── VxTwitterAdapter.ts      # vxTwitter API 対応
│       ├── FxTwitterAdapter.ts      # FxTwitter API 対応
│       └── TwitterAdapter.ts        # 統合アダプター（フォールバック）
├── infrastructure/                   # インフラ層
│   ├── db/
│   │   ├── RedisChannelConfigRepository.ts  # 設定 CRUD + LRU キャッシュ + Pub/Sub
│   │   └── RedisReplyLogger.ts              # リプライ記録
│   ├── http/
│   │   ├── HttpClient.ts            # HTTP 通信
│   │   └── VideoDownloader.ts       # 動画ダウンロード
│   └── filesystem/
│       └── FileManager.ts           # ファイル操作
├── db/                               # Redis 接続管理
│   ├── init.ts                      # Redis クライアント初期化
│   ├── connect.ts                   # 接続処理
│   └── replyLogger.ts              # リプライログ操作
├── fxtwitter/                        # FxTwitter API 定義
│   ├── api.ts                       # レスポンス型
│   └── fxtwitter.ts                 # API 呼び出し
├── vxtwitter/                        # vxTwitter API 定義
│   ├── api.ts                       # レスポンス型
│   └── vxtwitter.ts                 # API 呼び出し
└── utils/
    ├── logger.ts                    # Winston ロガー
    └── cleanupOrphanedConfigs.ts    # 孤立設定キーの掃除
```

### 共有パッケージ

```
packages/shared/src/
├── index.ts          # Re-exports
├── config.ts         # GuildConfig 型、ConfigResult 型、IChannelConfigRepository インターフェース
└── constants.ts      # Dashboard バージョン共有用定数
```

Bot と Dashboard の間で共有する型定義・インターフェース・定数を管理します。

## レイヤー説明

### 1. Core 層（ビジネスロジック）

**責務**: ビジネスルールとドメイン知識を表現。外部ライブラリに依存しない。

| クラス                 | 役割                                             |
| ---------------------- | ------------------------------------------------ |
| `Tweet`                | ツイートの統一モデル（外部 API の差異を吸収）    |
| `TweetProcessor`       | URL 抽出、スポイラー判定                         |
| `MediaHandler`         | メディアのフィルタリング・分類                   |
| `ChannelConfigService` | チャンネル許可判定、Redis 障害時のフォールバック |

`ChannelConfigService` は `IChannelConfigRepository` インターフェースに依存し、Redis の実装詳細を知りません。

### 2. Adapter 層（外部システムとの接続）

**責務**: Discord や Twitter API との通信を抽象化。

#### Discord Adapter

| クラス           | 役割                                                  |
| ---------------- | ----------------------------------------------------- |
| `MessageHandler` | メッセージ受信 → URL 抽出 → ツイート取得 → Embed 返信 |
| `EmbedBuilder`   | Discord Embed の組み立て                              |

#### Twitter Adapter

| クラス               | 役割                                                      |
| -------------------- | --------------------------------------------------------- |
| `BaseTwitterAdapter` | API レスポンス → `Tweet` モデル変換の共通処理             |
| `VxTwitterAdapter`   | vxTwitter API 対応                                        |
| `FxTwitterAdapter`   | FxTwitter API 対応                                        |
| `TwitterAdapter`     | 複数 API の統合（VxTwitter → FxTwitter のフォールバック） |

### 3. Infrastructure 層（技術的詳細）

**責務**: 低レベルな技術的実装を隠蔽。

| クラス                         | 役割                                                               |
| ------------------------------ | ------------------------------------------------------------------ |
| `RedisChannelConfigRepository` | `IChannelConfigRepository` の Redis 実装。LRU キャッシュ + Pub/Sub |
| `RedisReplyLogger`             | リプライ記録の Redis 実装                                          |
| `HttpClient`                   | HTTP 通信                                                          |
| `VideoDownloader`              | 動画ダウンロード                                                   |
| `FileManager`                  | ファイルシステム操作                                               |

## 依存関係のルール

```
Core 層 ← Adapter 層 ← Infrastructure 層
  ↑          ↑               ↑
  └──────────┴───────────────┘
        index.ts（DI）
```

- **Core 層**: 他のどの層にも依存しない（`@twitterrx/shared` の型定義のみ参照）
- **Adapter 層**: Core 層のモデル・サービスに依存
- **Infrastructure 層**: `@twitterrx/shared` のインターフェースを実装
- **index.ts**: すべてを組み立てる（Dependency Injection）

## チャンネル設定のデータフロー

```
Dashboard (Web UI)
    │
    │ saveConfig()
    ▼
┌────────┐    Pub/Sub "config:updated"    ┌──────────────────────┐
│ SQLite │──────────────────────────────►│ Redis                 │
│ (SoT)  │        reseed on start        │ app:guild:{id}:config │
└────────┘                                └───────────┬──────────┘
                                                      │
                          ┌───────────────────────────┘
                          │ getConfig()
                          ▼
                ┌─────────────────────────────────┐
                │ RedisChannelConfigRepository     │
                │ ┌─────────────┐                  │
                │ │ LRU キャッシュ │ ← Pub/Sub で   │
                │ │ (in-memory) │   無効化          │
                │ └─────────────┘                  │
                └────────────┬────────────────────┘
                             │
                             ▼
                ┌─────────────────────────┐
                │ ChannelConfigService     │
                │ isChannelAllowed()       │
                │ フォールバック処理         │
                └─────────────────────────┘
```

### フォールバック戦略

| 状態       | 環境変数                    | デフォルト | 挙動                       |
| ---------- | --------------------------- | ---------- | -------------------------- |
| Redis 障害 | `REDIS_DOWN_FALLBACK`       | `allow`    | 全チャンネル許可（可用性優先） |
| 設定未作成 | `CONFIG_NOT_FOUND_FALLBACK` | `allow`    | 全チャンネル許可（導入直後から使える） |

いずれも既定は `allow`。チャンネルを絞る運用者のみ `deny` を明示する。
有効な設定は起動時に `[ChannelConfig] Fallback policy: ...` として INFO ログに出力される。

### 設定の三値型（ConfigResult）

```typescript
type ConfigResult =
  | { kind: "found"; data: GuildConfig } // 設定あり
  | { kind: "not_found" } // 設定なし
  | { kind: "error"; error: Error }; // Redis 障害
```

`ChannelConfigService` はこの三値に応じて分岐し、`error` 時のみフォールバック設定を適用します。

## Dashboard バージョン連携

Bot のステータスに Dashboard の接続状態を表示する仕組みです。

```
Dashboard 起動
    │
    │ writeDashboardVersion()
    ▼
Redis SET "app:dashboard:version" = "1.2.0" (TTL: 300s)
    │
    │ startVersionHeartbeat() ─── 120秒ごとに TTL 延長
    │
Bot (5分ごと)
    │
    │ redis.GET("app:dashboard:version")
    ▼
ステータス: "v2.1.0(Dashboard v1.2.0), 導入サーバー数: N"
         or "v2.1.0(Dashboard 未接続), 導入サーバー数: N"
```

## テスト戦略

### Unit Test

各層を独立してテスト可能：

```typescript
// Core 層のテスト（依存なし）
describe("TweetProcessor", () => {
  it("should extract URLs from text", () => {
    const processor = new TweetProcessor();
    const urls = processor.extractUrls(
      "Check this https://twitter.com/user/status/123",
    );
    expect(urls).toEqual(["https://twitter.com/user/status/123"]);
  });
});

// Adapter 層のテスト（モック使用）
describe("MessageHandler", () => {
  it("should handle tweet URLs", async () => {
    const mockTwitterAdapter = {
      fetchTweet: vi.fn().mockResolvedValue(mockTweet),
    };
    const handler = new MessageHandler(
      processor,
      mockTwitterAdapter, // モックを注入
      // ...
    );
  });
});
```

### Integration Test

実際の API を使用したテスト：

```typescript
describe("TwitterAdapter Integration", () => {
  it("should fetch real tweet", async () => {
    const adapter = TwitterAdapter.createDefault();
    const tweet = await adapter.fetchTweet(realTweetUrl);
    expect(tweet).toBeDefined();
  });
});
```

## 拡張性

### 新しい Twitter API の追加

1. `BaseTwitterAdapter` を継承
2. `TwitterAdapter` のコンストラクタに追加
3. 既存コードは無変更

### 別チャットプラットフォームへの対応

1. `adapters/slack/` などを作成
2. `MessageHandler` と同等のクラスを実装
3. `index.ts` で組み立て

### ストレージの変更

1. `IChannelConfigRepository` を実装した新クラスを作成
2. `index.ts` の DI 部分のみ変更
3. 他のコードは無変更
