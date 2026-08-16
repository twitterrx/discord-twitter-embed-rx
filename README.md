# TwitterRX

[![CI](https://github.com/rx-twitter/rx-twitter/actions/workflows/ci.yml/badge.svg)](https://github.com/rx-twitter/rx-twitter/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/rx-twitter/rx-twitter/branch/main/graph/badge.svg)](https://codecov.io/gh/rx-twitter/rx-twitter)

Twitter/X の投稿 URL を Discord 上で見やすい Embed に展開する、セルフホスト型の Discord Bot です。
[vxTwitter](https://github.com/dylanpdx/BetterTwitFix) を優先して投稿を取得し、障害時には [FxTwitter](https://github.com/FixTweet/FxTwitter) へフォールバックします。

![実行例](./md/image.png)

## 主な機能

- `twitter.com` / `x.com` の投稿 URL を検出して自動展開
- 投稿本文、引用、画像、動画などを Discord 向けに表示
- vxTwitter のサーバー障害時に FxTwitter を利用
- [Dashboard](https://github.com/rx-twitter/rx-twitter-dashboard) からチャンネルごとの応答設定を管理
- Redis のキャッシュと Pub/Sub による設定のリアルタイム反映

## リポジトリ構成

```text
TwitterRX/
├── src/                  # Bot 本体
├── packages/shared/      # Bot・Dashboard 共通パッケージ
├── tests/                # unit / integration テスト
├── openapi/              # 外部 API のスキーマ
├── docs/                 # アーキテクチャ・仕様資料
├── compose.yml           # ローカル開発用 Docker Compose
├── compose.yml.example   # 本番デプロイ用 Compose サンプル
└── .config/              # アプリケーション設定
```

Dashboard はこのリポジトリには含まれません。独立した
[rx-twitter/rx-twitter-dashboard](https://github.com/rx-twitter/rx-twitter-dashboard) で管理しています。

### 技術スタック

| 項目                | 技術                         |
| ------------------- | ---------------------------- |
| ランタイム          | Node.js 24+                  |
| 言語                | TypeScript（ES2022、strict） |
| Discord             | discord.js v14               |
| キャッシュ・Pub/Sub | Redis 8                      |
| HTTP                | Hono                         |
| テスト              | Vitest                       |
| Lint / Format       | oxlint / oxfmt               |

## セットアップ

### 前提条件

- Node.js 24+
- Redis 8
- Docker / Docker Compose（コンテナで起動する場合）
- [Discord Developer Portal](https://discord.com/developers/applications) で作成したBot

Bot の招待時には、次の権限が必要です。

- チャンネルを表示
- メッセージを送る
- メッセージを管理
- リンクを埋め込む
- ファイルを添付
- メッセージ履歴を読む
- 低速モードを回避

### 1. リポジトリをクローン

```bash
git clone https://github.com/rx-twitter/rx-twitter.git
cd rx-twitter
```

### 2. 設定ファイルを準備

```bash
cp .env.example .env
cp .config/config.yml.example .config/config.yml
```

最低限、`.env` に次の値を設定してください。

| 変数                                 | 説明                                                    |
| ------------------------------------ | ------------------------------------------------------- |
| `NODE_ENV`                           | `production` または `develop`                           |
| `PRODUCTION_TOKEN` / `DEVELOP_TOKEN` | 実行環境に対応する Discord Bot トークン                 |
| `OWNER_USER_ID`                      | Bot の管理コマンドを実行する Discord ユーザー ID        |
| `REDIS_URL`                          | Redis の接続先。未指定時は `redis://localhost:6379`      |

その他の環境変数は [.env.example](./.env.example) を参照してください。

### 3. 起動

#### Docker Compose

`compose.yml` は Bot と Redis を起動します。初回のみ共有ネットワークを作成してください。

```bash
docker network create twitterrx_network
docker compose up -d
docker compose logs -f twitter-rx
```

すでに `twitterrx_network` が存在する場合、ネットワーク作成コマンドは不要です。

#### Node.js

接続可能な Redis を用意してから起動してください。

```bash
npm install
npm run build
npm start
```

本番環境で GHCR イメージを利用する場合は、[compose.yml.example](./compose.yml.example) のコメントを参照してください。

## 設定

`.config/config.yml` で Bot の動作を設定できます。

| 設定                       | 説明                                             | デフォルト       |
| -------------------------- | ------------------------------------------------ | ---------------- |
| `media_max_file_size`      | 添付上限の任意キャップ（バイト）。未設定時は guild のブーストレベルから決定（Tier0/1: 10MiB / Tier2: 50MiB / Tier3: 100MiB）。上限を下げる用途にのみ有効 | 未設定 |
| `logging.logLevel`         | ログレベル。環境変数 `LOG_LEVEL` を優先           | `info`           |
| `logging.maxFiles`         | ログファイルの保持期間                           | `14d`            |
| `logging.maxSize`          | ログファイルの最大サイズ                         | `20m`            |
| `logging.separateErrorLog` | エラーログを別ファイルへ出力するか               | `true`           |

Dashboard を使用する場合のフォールバック動作などは、`.env` で設定します。

| 変数                        | 説明                                               | デフォルト       |
| --------------------------- | -------------------------------------------------- | ---------------- |
| `REDIS_DOWN_FALLBACK`       | Redis 障害時の動作。`allow`: 許可 / `deny`: 拒否   | `allow`          |
| `CONFIG_NOT_FOUND_FALLBACK` | チャンネル設定が存在しない場合の動作               | `allow`          |
| `ENABLE_ORPHAN_CLEANUP`     | 起動時に Bot 未参加ギルドの設定を削除するか         | `false`          |
| `LOG_DIR`                   | ログの出力先                                       | `<repo>/../logs` |
| `REDIS_TTL`                 | 元メッセージと Bot 返信の対応を保持する秒数         | `86400`          |
| `HEALTH_PORT`               | ヘルスチェック HTTP サーバーのポート               | `9090`           |

## 開発

```bash
# Lint
npm run lint

# 型チェック
npm run compile:test

# 本番ビルド
npm run build

# すべてのテスト
npm test

# ユニットテスト
npm run test:unit

# カバレッジ
npm run test:coverage
```

Core、Adapter、Infrastructure を分離したレイヤードアーキテクチャを採用しています。
詳細は [アーキテクチャ資料](./docs/ARCHITECTURE.md) を参照してください。

## 関連リポジトリ

- [TwitterRX Dashboard](https://github.com/rx-twitter/rx-twitter-dashboard) — チャンネル設定を管理する Web UI

## ライセンス

[GNU Affero General Public License v3.0 or later](./LICENSE)（`AGPL-3.0-or-later`）

Copyright (C) 2023 shika

本 Bot を改変してネットワーク越しに提供する場合、AGPL 第 13 条により、その Bot を利用する
ユーザーに対して改変後のソースコード（Corresponding Source）を提供する義務が生じます。
セルフホストして手を入れる場合はご注意ください。改変せずに運用するぶんには追加の義務はありません。

**v3.1.0 までのリリースは MIT License** で配布されています。MIT の通知保持条項に基づき、
当時の著作権表示は [LICENSE.MIT](./LICENSE.MIT) に保持しています。
