# AGENTS.md — TwitterRX (discord-twitter-embed-rx)

## プロジェクト概要

- Discord Bot。Twitter/X の URL を検出し、vxTwitter/FxTwitter API から内容を取得して Embed 展開する。
- TypeScript モノレポ (npm workspaces: `packages/*`)。
- Dashboard (Web UI) は Git サブモジュール（別リポジトリ `t1nyb0x/discord-twitter-embed-rx-dashboard`）。

## 技術スタック

| 項目                 | 技術                        |
| -------------------- | --------------------------- |
| ランタイム           | Node.js 24+                 |
| 言語                 | TypeScript (ES2022, strict) |
| Bot フレームワーク   | discord.js v14              |
| キャッシュ / Pub/Sub | Redis 8 (ioredis)           |
| テスト               | Vitest                      |
| Lint / Format        | oxlint / oxfmt              |
| パッケージ管理       | npm workspaces              |

## 外部 API 仕様

Bot は以下の外部 API からツイート情報を取得する。型定義・実装時は各仕様書を参照すること。

| API                       | ベースURL                                                   | 仕様書                                                                 |
| ------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| FxTwitter (FxEmbed)       | `https://api.fxtwitter.com/2/status/{id}`                   | [docs.fxembed.com/api/twitter/](https://docs.fxembed.com/api/twitter/) |
| VxTwitter (BetterTwitFix) | `https://api.vxtwitter.com/{screen_name}/status/{tweet_id}` | [docs/vxtwitter_api.md](./docs/vxtwitter_api.md)                       |

## ディレクトリ構成

```
src/
├── adapters/           # 外部サービスとの接続
│   ├── discord/        #   EmbedBuilder, MessageHandler
│   └── twitter/        #   FxTwitterAdapter, VxTwitterAdapter, TwitterAdapter
├── config/             # アプリ設定 (config.ts)
├── core/               # ビジネスロジック（依存性なし）
│   ├── models/         #   Tweet 型定義 (ADT)
│   └── services/       #   TweetProcessor, MediaHandler, ChannelConfigService
├── db/                 # Redis 接続・初期化
├── fxtwitter/          # FxTwitter API クライアント
├── infrastructure/     # 外部リソース実装
│   ├── db/             #   RedisChannelConfigRepository, RedisReplyLogger
│   ├── filesystem/     #   FileManager
│   └── http/           #   HttpClient, HealthServer, VideoDownloader
├── utils/              # ユーティリティ (logger, cleanupOrphanedConfigs)
├── vxtwitter/          # VxTwitter API クライアント
└── index.ts            # エントリポイント（DI コンテナ兼用）
tests/
├── unit/               # 単体テスト（モック使用）
├── integration/        # 結合テスト（実 Redis / 実 API を使うものは明示フラグでオプトイン）
└── fixtures/           # テストフィクスチャ
packages/
└── shared/             # Bot・Dashboard 共通パッケージ @twitterrx/shared
```

## アーキテクチャ原則

### レイヤー構造（Clean Architecture 的）

```
[Core] ← [Application/Adapters] ← [Infrastructure] ← [External]
```

- **Core** (`src/core/`): ビジネスロジック。外部依存ゼロ。Pure TypeScript。
- **Adapters** (`src/adapters/`): Core と外部の橋渡し。インターフェース定義＋実装。
- **Infrastructure** (`src/infrastructure/`): 外部リソース (Redis, HTTP, FS) の具体的実装。
- **Entry Point** (`src/index.ts`): DI のルート。全依存性を手動で注入する。

### 依存性注入パターン

```typescript
// コンストラクタインジェクションが基本
const repository = new RedisChannelConfigRepository();
const service = new ChannelConfigService(repository); // 依存性を注入

// TwitterAdapter はファクトリメソッド
const adapter = TwitterAdapter.createDefault(); // ← 内部で Vx/Fx を composition
```

**ルール**: `src/index.ts` でのみ DI ワイヤリングを行う。それ以外のファイルで new による依存解決をしない。

## 品質ゲート（必須）

以下のゲートをすべて通過した状態でなければコミット・マージしてはならない。

| ゲート      | コマンド                              | 内容                                                                                          |
| ----------- | ------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Lint**    | `npm run lint` (oxlint)               | `src/` および `tests/` 以下の全 TypeScript を oxlint でチェック。警告・エラーともにゼロ必須。 |
| **Compile** | `npm run compile:test` (tsc --noEmit) | TypeScript コンパイルエラーゼロ。パスエイリアス `@/` の解決も含む。                           |
| **Build**   | `npm run build`                       | 本番ビルドが正常に完了すること（clean → shared ビルド → tsc → tsc-alias）。                   |

実装・変更を行ったら、作業完了前に必ず `npm run lint` (`oxlint src/ tests/`) と `npm run compile:test` (`tsc --noEmit`) を実行し、通過を確認する。

### コミット前の未使用import確認

`npm run lint` 通過後、未使用 import 等の修正可能な警告（oxlint の `no-unused-vars` / `prefer-import-type` 等）が検出された場合、以下の手順で対応する：

1. **影響範囲の確認**: 該当の import が副作用目的（`import "module"` 形式）でないか、型だけの import で安全に削除できるかを確認する。
   - 型のみの import → `import type` に変更すれば安全
   - 純粋な未使用 import → 削除して安全
   - `import "side-effect-module"` 形式 → 削除不可、そのまま維持
2. **ユーザーへの確認**: 安全と判断した場合、ユーザーに「未使用 import を修正しますか？」と聞き、承諾を得てから `npx oxlint --fix-suggestions src/` を実行する。
   - `--fix-suggestions` を使う理由: 未使用 import の削除はプログラムの振る舞いを変える可能性がある修正（suggestion）に分類されるため、通常の `--fix` ではなく `--fix-suggestions` が必要。
   - 代替: `--fix-dangerously` でも削除可能だが、より攻撃的な修正も含むので `--fix-suggestions` を推奨。
3. **再チェック**: 修正後、再度 `npm run lint` と `npm run compile:test` を実行し、問題がないことを確認する。

```bash
# 未使用 import 等の検出のみ
npx oxlint -D no-unused-vars src/

# ユーザー確認後、自動修正
npx oxlint --fix-suggestions src/
```

## コミットメッセージ規約

コミットメッセージは **Conventional Commits** に従うこと。

```
<type>(<scope>): <description>
```

| type       | 使用場面                         |
| ---------- | -------------------------------- |
| `feat`     | 新機能                           |
| `fix`      | バグ修正                         |
| `chore`    | ビルド・タスク・依存関係         |
| `docs`     | ドキュメントのみの変更           |
| `refactor` | リファクタリング（動作変更なし） |
| `test`     | テストの追加・修正               |
| `style`    | フォーマットのみ（動作変更なし） |
| `ci`       | CI 設定の変更                    |
| `perf`     | パフォーマンス改善               |
| `revert`   | 変更の打ち消し                   |

scope は省略可能。description は日本語でも英語でもよいが、簡潔に変更内容を表すこと。

**例:**

- `feat(dashboard): チャンネル設定画面を追加`
- `fix: vxTwitter API のタイムアウト処理を修正`
- `docs: AGENTS.md にコミット規約を追加`
- `refactor(core): TweetProcessor の判定ロジックを整理`

この規約に違反するコミットは amend または rebase で修正すること。

## コーディング規約

### 全般

- 言語: 日本語（README / コメント / コミットメッセージ）、ただし既存の英文コメントは翻訳しない。
- 命名: `camelCase`（変数/関数）、`PascalCase`（クラス/型/インターフェース）、`UPPER_CASE`（enum 値/定数）。
- 型定義は `interface` 優先。`type` は Union 型など interface で表現できない場合のみ。
- ファイル名: `PascalCase.ts`（クラス/コンポーネント）、`camelCase.ts`（関数/ユーティリティ）。
- パスエイリアス: `@/` → `./src/`（tsconfig paths + vitest alias で解決）。

### 非同期処理

- `async/await` 一貫使用。生の `.then()` / `.catch()` は禁止。
- エラーハンドリングは try-catch で明示的に行い、logger にスタックトレースを含める。
- Graceful shutdown 必須: SIGINT/SIGTERM で Redis → Discord Client の順にクローズ。

### テスト

- **t-wada スタイルの TDD**: 実装と同時に型チェック + テストで動作検証。
- テスト配置: `tests/unit/` に src と同じディレクトリ構造で配置。
- モック: 外部依存 (Redis, Discord, HTTP) はテスト用の Mock クラスを使用。
- テストランナー: Vitest（globals: true, sourceMap 対応）。
- カバレッジ: vitest --coverage（v8 provider）。
- 外部 API レスポンスの fixture: `tests/fixtures/fxtwitter/` に実 API の payload をそのまま置く。手書きモックだけではスキーマの思い込みをテストしてしまう。
- 上流 API のドリフト検知: 保存済み fixture は自スキーマの回帰しか守れないため、実 API を叩くテストを `tests/integration/` に置く（`fxtwitterContract.test.ts` はスキーマの契約、`twitter-api.test.ts` は取得とフォールバックの振る舞い）。ネットワーク依存で不安定なので既定は skip、`RUN_LIVE_API_TESTS=1` でオプトインする。CI では実行しない（外部都合で PR が落ちないようにするため）。

  ```bash
  RUN_LIVE_API_TESTS=1 npx vitest run tests/integration/fxtwitterContract.test.ts
  ```

- 実 Redis を要するテスト: `describe.skipIf(!RUN)` で `RUN_REDIS_INTEGRATION=1` のときだけ実行する。CI では `integration-redis` ジョブが Redis サービス付きで `tests/integration` をディレクトリ指定で実行する（`RUN_LIVE_API_TESTS` は立てないので実 API のテストは skipped のまま残る）。

  ```bash
  docker run -d --rm --name twrx-test-redis -p 6390:6379 redis:8.2.2-alpine
  RUN_REDIS_INTEGRATION=1 REDIS_URL=redis://127.0.0.1:6390 \
    npx vitest run tests/integration/channel-config.test.ts
  docker rm -f twrx-test-redis
  ```

  被験体（Repository 等）と同じ Redis 接続（`@/db/init` の `redis`）でテストデータを書くこと。別クライアントを立てて書き込むと「書いたのに読めない」状態を作り込み、結合を検証できない。

- **未実行を成功扱いにしない**: 依存が無いときに `if (!available) return;` で早期 return すると、テストが緑のまま何も検証しない。依存の有無は `skipIf` で表明し、実行されなかったことがレポートに `skipped` として残るようにする。

- `tests/integration/` に置くテストは**必ずいずれかのフラグでゲートする**。ゲートの無いテストを置くと、通常の `test` ジョブ（`npm run test:coverage`）が外部依存を巻き込んで不安定になる。外部依存の要らないテストは `tests/unit/` に置く。

- **外部の実リソースを指すアサーションは、消えても気づけない**: 実在する URL のサイズや内容に依存するテストは、対象が消えた後もエラーページの応答で緑を返しうる（#607 で実例があった）。実 API を叩くテストは「取得できること・スキーマに適合すること」に留め、特定リソースの中身の値には依存させない。

### Redis キー命名規則

```
app:<domain>:<id>:<field>
```

例:

- `app:guild:{guildId}:joined` — 参加フラグ
- `app:guild:{guildId}:channels` — チャンネルキャッシュ
- `app:config:{guildId}:{channelId}` — チャンネル設定

### エラーハンドリング

- logger.error には structured metadata を含める（`{ error: ..., context: ... }`）。
- 起動時の致命的エラーは `throw new Error(...)`。runtime のエラーは catch して logger に記録、ボットは継続。
- 外部 API (vxTwitter/FxTwitter) のエラーはフォールバック可能にする（片方が落ちてももう片方でリトライ）。

## 注意点 / 制約

- `packages/shared/` は Dashboard との共通コード。Bot 側の変更時は Dashboard 互換性に注意。
- Dashboard は Git サブモジュール。`dashboard/` 以下は別リポジトリ。
- compose.yml は開発用、compose.yml.example は本番デプロイ用（GHCR）。
- `.config/` ディレクトリにアプリ設定ファイル。
