# Dashboard デプロイ・運用ガイド

> このドキュメントは [DASHBOARD_SPEC.md](DASHBOARD_SPEC.md) のセクション10・16（Docker構成、運用トラブルシュート）から抽出した実装例を記載しています。

---

## 目次

- [Docker 構成](#docker-構成)
  - [compose.yml](#composeyml)
  - [Dashboard Dockerfile](#dashboard-dockerfile)
  - [nginx 設定例](#nginx-設定例)
  - [配布時の考慮事項](#配布時の考慮事項)
- [環境変数](#環境変数)
  - [Bot 側](#bot-側)
  - [Dashboard 側](#dashboard-側)
  - [シークレット生成方法](#シークレット生成方法)
- [運用上の前提・制約](#運用上の前提制約)
  - [障害時の挙動](#障害時の挙動)
  - [設計上の制約](#設計上の制約)
  - [復旧のシナリオ](#復旧のシナリオ)
  - [大規模環境での考慮事項](#大規模環境での考慮事項)
- [運用トラブルシュート](#運用トラブルシュート)
  - [よくある症状と対処法](#よくある症状と対処法)
  - [ヘルスチェック手順](#ヘルスチェック手順)
  - [緊急時の対応](#緊急時の対応)
  - [バックアップ・復旧手順](#バックアップ復旧手順)

---

## Docker 構成

### compose.yml

```yaml
services:
  twitter-rx:
    container_name: TwitterEmbedRX
    image: ghcr.io/t1nyb0x/discord-twitter-embed-rx:latest
    restart: unless-stopped
    env_file: .env
    depends_on:
      redis:
        condition: service_healthy
    environment:
      - REDIS_URL=redis://redis:6379

  dashboard:
    container_name: TwitterRX-Dashboard
    image: ghcr.io/t1nyb0x/discord-twitter-embed-rx-dashboard:latest
    restart: unless-stopped
    env_file: .env
    depends_on:
      redis:
        condition: service_healthy
    ports:
      - "127.0.0.1:4321:4321"  # localhost のみ公開（nginx 経由でアクセス）
    environment:
      - REDIS_URL=redis://redis:6379
      - DATABASE_URL=file:/app/data/dashboard.db
      - NODE_ENV=production
    volumes:
      - dashboard_data:/app/data

  redis:
    container_name: TwitterRX-Redis
    image: redis:8.2.2-alpine
    restart: unless-stopped
    volumes:
      - redis_data:/data
    command: redis-server --appendonly yes
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 3

volumes:
  redis_data:
  dashboard_data:
```

### Dashboard Dockerfile

```dockerfile
# dashboard/Dockerfile

FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# 非 root ユーザーで実行
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 astro
USER astro

COPY --from=builder --chown=astro:nodejs /app/dist ./dist
COPY --from=builder --chown=astro:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=astro:nodejs /app/package.json ./

# マイグレーション実行スクリプト
COPY --from=builder --chown=astro:nodejs /app/scripts/migrate.sh ./scripts/

# データディレクトリ
RUN mkdir -p /app/data && chown astro:nodejs /app/data
VOLUME /app/data

EXPOSE 4321

# 起動時にマイグレーションを実行
CMD ["sh", "-c", "./scripts/migrate.sh && node dist/server/entry.mjs"]
```

### nginx 設定例

> **他サービスとの共存について**:
> 
> `limit_req_zone` は `http` ブロックに配置する必要があるが、`nginx.conf` を直接編集すると
> 同じサーバーで動作する他のサービスに影響が出る可能性がある。
> 
> **推奨方法**: `conf.d/` ディレクトリに専用ファイルを作成して `include` する。
> これにより他のサービスに影響を与えず、TwitterRX 用のレート制限を定義できる。

```nginx
# /etc/nginx/conf.d/twitterrx-ratelimit.conf
# ★ このファイルは nginx.conf の http ブロック内で自動的に include される
# ★ zone 名を一意にすることで他のサービスと衝突しない

# TwitterRX Dashboard 専用のレート制限ゾーン
limit_req_zone $binary_remote_addr zone=twitterrx_dashboard:10m rate=30r/m;
```

> **Note**: 多くの nginx 環境では `nginx.conf` に `include /etc/nginx/conf.d/*.conf;` が
> 既に記述されているため、`conf.d/` にファイルを置くだけで読み込まれる。
> 
> zone 名を `twitterrx_dashboard` のようにプロジェクト固有の名前にすることで、
> 他のサービスが定義した zone と衝突するリスクを回避できる。

```nginx
# /etc/nginx/sites-available/twitterrx-dashboard

upstream twitterrx_dashboard_backend {
    server 127.0.0.1:4321;
    keepalive 32;
}

server {
    listen 443 ssl http2;
    server_name dashboard.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    # セキュリティヘッダー
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    # ★ X-XSS-Protection はモダンブラウザでは無効化されている（Chrome 78+, Edge 等）
    # 無害だが過信しないこと。CSP (Content-Security-Policy) の方が効果的
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    
    # ★ P2対応: HSTS（HTTPS 運用時のみ）
    # HTTPS を使用している場合は有効化を強く推奨
    # max-age=31536000 は 1年間（サブドメインを含めない）
    # includeSubDomains は Dashboard 専用ドメインの場合のみ追加
    add_header Strict-Transport-Security "max-age=31536000" always;
    
    # ★ P2対応: CSP（Content-Security-Policy）
    # Astro/Preact では一部インラインスクリプトが必要なため、現時点では unsafe-inline を許可
    # 将来的には nonce ベースの CSP に移行してセキュリティを強化
    #
    # 現時点の方針:
    # - default-src 'self': 基本的に同一オリジンのみ許可
    # - script-src 'self' 'unsafe-inline': Astro の hydration スクリプト用
    # - style-src 'self' 'unsafe-inline': CSS-in-JS 等のインラインスタイル用
    # - img-src 'self' https://cdn.discordapp.com: Discord CDN の画像（アバター等）
    # - connect-src 'self': API 呼び出し用
    #
    # ロードマップ:
    # 1. Phase 1: 上記の CSP を有効化（unsafe-inline 許可）
    # 2. Phase 2: nonce ベースの script-src に移行
    # 3. Phase 3: unsafe-inline を完全撤廃
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https://cdn.discordapp.com; connect-src 'self'" always;

    # レート制限の適用（zone は conf.d/twitterrx-ratelimit.conf で定義）
    limit_req zone=twitterrx_dashboard burst=10 nodelay;

    location / {
        proxy_pass http://twitterrx_dashboard_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # タイムアウト
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }

    # 静的ファイルのキャッシュ（Astro のビルドアセット）
    # ★ P0修正: upstream 名を twitterrx_dashboard_backend に統一
    location /_astro/ {
        proxy_pass http://twitterrx_dashboard_backend;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # 静的アセットはイミュータブル（ファイル名にハッシュが含まれる）
        proxy_cache_valid 200 1y;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
}

# HTTP → HTTPS リダイレクト
server {
    listen 80;
    server_name dashboard.example.com;
    return 301 https://$server_name$request_uri;
}
```

### 配布時の考慮事項

#### nginx を持っていないユーザー向け

`compose.yml.with-nginx` を別途提供：

```yaml
# compose.yml.with-nginx（nginx 込みの完結版）
services:
  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf:ro
      - ./certs:/etc/nginx/certs:ro
    depends_on:
      - dashboard

  # 以下 twitter-rx, dashboard, redis は同じ
```

#### 環境変数のテンプレート

```bash
# .env.example

# Bot
DISCORD_BOT_TOKEN=your_bot_token_here

# Dashboard
DISCORD_CLIENT_ID=your_client_id_here
DISCORD_CLIENT_SECRET=your_client_secret_here
DISCORD_REDIRECT_URI=https://dashboard.example.com/api/auth/discord/callback

# Session
SESSION_SECRET=generate_a_random_32_char_string

# ★ P0: 必須 - 未設定だと Dashboard が起動しません
# ENCRYPTION_SALT は環境ごとに異なる値を設定してください
ENCRYPTION_SALT=generate_a_random_32_char_string

# Redis（デフォルト）
REDIS_URL=redis://redis:6379

# Database（デフォルト）
DATABASE_URL=file:/app/data/dashboard.db
```

> **⚠️ 重要: 本番環境では必ず HTTPS を使用してください**
>
> `secure: NODE_ENV === 'production'` により、本番環境では Secure Cookie が有効になります。
> これは HTTPS 経由でのみ Cookie が送信されることを意味します。
>
> **HTTP のまま運用すると**:
> - Cookie が送信されず、ログイン状態が維持できない
> - セッションハイジャックのリスクが高まる
>
> **推奨構成**:
> - nginx + Let's Encrypt で HTTPS を終端
> - Cloudflare Tunnel など CDN 経由でのアクセス
>
> **README に以下を記載すること（必須）**:
> ```markdown
> ## ⚠️ セキュリティ要件
> 
> Dashboard は本番環境で **必ず HTTPS を使用** してください。
> HTTP のまま運用すると、セッション Cookie が正しく動作しません。
> ```

---

## 環境変数

### Bot 側

| 変数名 | 必須 | 説明 | 例 |
|--------|------|------|-----|
| `DISCORD_BOT_TOKEN` | ✅ | Discord Bot トークン | `OTk...` |
| `REDIS_URL` | ✅ | Redis 接続 URL | `redis://redis:6379` |
| `REDIS_DOWN_FALLBACK` | - | Redis 障害時の挙動（`allow`/`deny`）デフォルト: `allow` | `allow` |
| `CONFIG_NOT_FOUND_FALLBACK` | - | 設定未作成時の挙動（`allow`/`deny`）デフォルト: `allow` | `allow` |
| `ENABLE_ORPHAN_CLEANUP` | - | 起動時の孤立キー掃除（デフォルト: `false`）。有効化は文字列 `"true"` のみ | `false` |
| `LOG_DIR` | - | ログの出力先ディレクトリ（省略時はリポジトリの1つ上の `logs/`）。空文字を設定するとカレントディレクトリになる | `/app/bot/logs` |
| `REDIS_TTL` | - | リプライログの保持期間（秒）。デフォルト: `86400` | `86400` |
| `ENABLE_METRICS` | - | **（未実装）** `/metrics` エンドポイント有効化。設定しても現時点では何も起きない。設計は「メトリクス収集」の節を参照 | - |

### Dashboard 側

| 変数名 | 必須 | 説明 | 例 |
|--------|------|------|-----|
| `DISCORD_CLIENT_ID` | ✅ | Discord アプリケーション ID | `123456789012345678` |
| `DISCORD_CLIENT_SECRET` | ✅ | Discord OAuth2 シークレット | `abc...xyz` |
| `DISCORD_REDIRECT_URI` | ✅ | OAuth2 コールバック URL | `https://dashboard.example.com/api/auth/discord/callback` |
| `REDIS_URL` | ✅ | Redis 接続 URL | `redis://redis:6379` |
| `DATABASE_URL` | ✅ | SQLite ファイルパス | `file:/app/data/dashboard.db` |
| `SESSION_SECRET` | ✅ | セッション署名用シークレット（32文字以上推奨） | `your-random-secret-here` |
| `ENCRYPTION_SALT` | ✅ | トークン暗号化用 salt（**未設定時は起動失敗**） | `your-unique-salt-here` |
| `NODE_ENV` | - | 実行環境（`production` で Secure Cookie 有効） | `production` |

> **★ P0対応: ENCRYPTION_SALT は必須**
>
> 従来はデフォルト値が設定されていたが、配布版でコピペ運用されると
> 全員同じ鍵派生になりセキュリティ事故につながるため、必須に変更。
> 未設定時は Dashboard が起動時にエラーを出して停止する。

### シークレット生成方法

```bash
# SESSION_SECRET の生成
openssl rand -base64 32

# ENCRYPTION_SALT の生成
openssl rand -base64 32
```

---

## 運用上の前提・制約

このセクションでは、システム運用時の前提条件と制約事項を明記する。

### 障害時の挙動

| 障害 | 影響 | 復旧方法 |
|------|------|----------|
| **Dashboard ダウン** | 設定変更不可。Bot は動作継続（キャッシュから設定取得） | Dashboard 再起動 |
| **Redis ダウン** | Dashboard: ログイン不可、設定変更不可。Bot: キャッシュが効いている間は動作継続、キャッシュ切れ後は環境変数に従いフォールバック | Redis 再起動 |
| **SQLite 破損** | 設定の永続データ消失 | バックアップから復元、または再設定 |
| **Redis データ消失** | `joined` フラグ消失 → Dashboard で「Bot 未参加」表示。config キャッシュ消失 → Bot は全チャンネル許可で動作 | Bot 再起動で `joined` 復旧。Dashboard でギルド設定を開くと config キャッシュ再作成 |

> **Redis ダウン時のフォールバック挙動について**
> 
> Redis が落ちた場合、Bot は以下の挙動をとる：
> 1. インメモリキャッシュが有効な間は、キャッシュから設定を読み取って動作継続
> 2. キャッシュ切れ後は環境変数 `REDIS_DOWN_FALLBACK` に従う（revalidate 間隔は 5分）
> 
> **環境変数での切替**:
> ```
> REDIS_DOWN_FALLBACK=allow  # 全チャンネル許可（★デフォルト、可用性優先）
> REDIS_DOWN_FALLBACK=deny   # 全チャンネル拒否（障害中も whitelist を維持する）
> ```
> 
> **デフォルトが `allow` である理由**:
> - チャンネルを個別に絞る運用者はマイノリティであり、多数派は設定を触らない
> - 既定を `deny` にすると、障害時に「Bot が壊れた」と見える形で多数派に影響が出る
> - 制限したい運用者は `deny` を明示でき、その選択は起動時ログで確認できる
> 
> **受け入れているトレードオフ**:
> - **Bot 再起動 × Redis 障害中**の交差では、インメモリキャッシュが空のまま `error` 経路に入るため、
>   whitelist を設定済みのギルドでも一時的に全チャンネルで反応する
> - ただし Redis エラー時にキャッシュは破棄されない（`not_found` のときのみ破棄）ため、
>   障害中でもキャッシュに乗っているギルドは正常に動作し続ける。影響はキャッシュミス時に限定される
> - この挙動を避けたい場合は `REDIS_DOWN_FALLBACK=deny` を明示する
> 
> **設定の確認方法**:
> 起動時に `[ChannelConfig] Fallback policy: REDIS_DOWN=..., CONFIG_NOT_FOUND=...` が INFO ログに出力される。
> 解釈できない値（`DENY` 以外の綴り違いなど）は WARN で警告され、既定の `allow` に倒れる。

> **joined 復旧の運用考慮**:
>
> Redis が消えると Dashboard は「Bot 未参加」扱いになる。
> Bot 再起動で joined 復旧、と書いているのは正しいが、運用者は再起動しないことがある。
>
> **対策**:
>
> 1. **Dashboard 側の「Bot 未参加」表示に注釈を追加**:
>    ```tsx
>    // Dashboard UI
>    {!botJoined && (
>      <div className="warning-banner">
>        <p>Bot がこのサーバーに参加していないようです。</p>
>        <p className="hint">
>          ※ Redis がリセットされた可能性があります。
>          Bot が実際に参加している場合は、Bot を再起動すると復旧します。
>        </p>
>      </div>
>    )}
>    ```
>
> 2. **Bot が定期的に joined を再 SET する（オプション）**:
>    ```typescript
>    // Bot 側: 1時間ごとに joined を再 SET（TTL なしなので idempotent）
>    const JOINED_REFRESH_INTERVAL = 60 * 60 * 1000; // 1時間
>    
>    setInterval(async () => {
>      for (const [guildId] of client.guilds.cache) {
>        try {
>          await redis.set(`app:guild:${guildId}:joined`, '1');
>        } catch (err) {
>          console.error(`[Guild] Failed to refresh joined for ${guildId}:`, err);
>        }
>      }
>      console.log(`[Guild] Refreshed joined flags for ${client.guilds.cache.size} guilds`);
>    }, JOINED_REFRESH_INTERVAL);
>    ```
>    
>    この方式なら、Redis がリセットされても最大 1 時間で復旧する。
>    TTL なしなので何度 SET しても副作用はない。

### 設計上の制約

| 制約 | 理由 | 回避策 |
|------|------|--------|
| **pub/sub はベストエフォート** | 配信保証なし、Bot 再起動中のメッセージは取り逃す | 5分間隔の revalidate で補完 |
| **whitelist 500 件上限** | DB・Redis パフォーマンス考慮 | 通常のユースケースでは十分 |
| **Dashboard は Bot トークンを持たない** | 配布時のセキュリティリスク軽減 | Redis 経由で情報連携 |
| **refresh_token 未使用** | 実装複雑化を避ける | 期限切れ時は再ログインで対応 |
| **guilds キャッシュ TTL 1時間** | 権限変更への追従を早めるため 7日から短縮 | 設定保存時は forceRefresh で再検証 |

### 復旧のシナリオ

**Redis が消えた場合**:

1. Bot 再起動で `joined` フラグが復旧（`ready` イベント）
2. Bot 再起動で `channels` キャッシュが復旧（`ready` イベント）
3. Dashboard でギルド設定を開くと `config` キャッシュが再作成

**pub/sub を取り逃した場合**:

1. Bot は通常通り動作（古い設定のまま）
2. 次回そのギルドでメッセージを受信した際、キャッシュが 5分以上経過していれば Redis を確認
3. version 比較で新しい設定があれば更新

### 大規模環境での考慮事項

| 項目 | 閾値 | 対策 |
|------|------|------|
| ギルド数 | 1,000+ | LRU キャッシュ上限で制御済み |
| Redis キー数 | 10,000+ | `cleanupOrphanedConfigs` を無効化可能（環境変数） |
| チャンネル変更頻度 | 高頻度 | debounce（30秒）で API 連打を防止 |

---

## 運用トラブルシュート

> **Note**: 本セクションは README に切り出すことを推奨。技術的に正しくても、ユーザーは長い仕様書を読まない。

### よくある症状と対処法

| 症状 | 原因 | 対処 |
|------|------|------|
| **設定を変更したのに Bot が反映しない** | ① pub/sub 取り逃し ② Bot がオフライン ③ そのギルドにメッセージが来ていない | ① 最大 5分待つ（自動 revalidate） ② Bot コンテナを確認 ③ 任意のメッセージを投稿して反映トリガを発生させる |
| **Dashboard で「Bot 未参加」と表示される** | ① Bot が本当に未参加 ② Bot がオフライン ③ Redis が消えた | ① Bot を招待 ② Bot コンテナを確認 ③ Bot を再起動（joined キー復旧） |
| **ログインできない** | ① Redis がダウン ② OAuth の redirect_uri ミスマッチ ③ セッション期限切れ | ① Redis コンテナを確認 ② 環境変数 `DISCORD_REDIRECT_URI` を確認 ③ 再ログイン |
| **「セッションが切れました」が頻発** | Discord アクセストークンの期限切れ | 再ログインで復旧（仕様通りの動作） |
| **チャンネル一覧が空のまま** | ① Bot がチャンネル情報を取得できていない ② Bot がオフライン | ① 「再取得ボタン」を押して 10分待つ ② Bot コンテナを確認 |
| **設定変更が 409 Conflict になる** | 別のユーザー/タブが同時に設定を変更した | ページをリロードして最新の設定を取得し直す |
| **Bot がどこでも反応しない** | ① Redis がダウン + `REDIS_DOWN_FALLBACK=deny` を明示している ② `CONFIG_NOT_FOUND_FALLBACK=deny` を明示していて設定が未作成 ③ whitelist が空 | ① Redis コンテナを確認（既定の `allow` なら障害中も反応する） ② 起動時の `[ChannelConfig] Fallback policy` ログで有効値を確認 ③ Dashboard で whitelist を設定 |
| **Dashboard が 503 を返す** | Redis への接続に失敗 | ① Redis コンテナを確認 ② `docker compose logs redis` でエラー確認 |

### ヘルスチェック手順

```bash
# 1. Bot コンテナの状態確認
docker compose ps

# 2. Bot ログで Redis 接続状況を確認
docker compose logs twitter-rx | grep -E "(Health|Redis|Degraded)"

# 3. Redis が起動しているか確認
docker compose exec redis redis-cli ping
# 期待: PONG

# 4. Redis の pub/sub 接続を確認
docker compose exec redis redis-cli PUBSUB CHANNELS
# 期待: app:config:update が表示される

# 5. Dashboard の起動ログを確認
docker compose logs dashboard | grep -E "(Reseed|Health|Error)"
```

### 緊急時の対応

**Redis が消えた場合（volume 飛ばし等）**:
```bash
# Dashboard を再起動すると SQLite から Redis に reseed される
docker compose restart dashboard

# Bot を再起動すると joined キーが復旧
docker compose restart twitter-rx
```

**Bot が無反応な場合**:
```bash
# ログでエラーを確認
docker compose logs twitter-rx --tail 100

# 強制再起動
docker compose restart twitter-rx
```

**設定を初期状態に戻したい場合**:
```bash
# SQLite のバックアップから復元
docker run --rm \
  -v twitterrx_dashboard_data:/target \
  -v $(pwd)/backup:/backup \
  alpine tar xvf /backup/dashboard-backup.tar -C /target

docker compose restart dashboard
```

### バックアップ・復旧手順

#### 定期バックアップ（推奨: 日次）

```bash
# 1. SQLite（named volume）のバックアップ
docker run --rm \
  -v twitterrx_dashboard_data:/source:ro \
  -v $(pwd)/backup:/backup \
  alpine tar cvf /backup/dashboard-$(date +%Y%m%d).tar -C /source .

# 2. Redis（AOF が有効な場合）のバックアップ
docker run --rm \
  -v twitterrx_redis_data:/source:ro \
  -v $(pwd)/backup:/backup \
  alpine tar cvf /backup/redis-$(date +%Y%m%d).tar -C /source .
```

#### 復旧手順

| 状況 | 手順 |
|------|------|
| **SQLite が壊れた** | 1. `docker compose stop dashboard` 2. バックアップから復元 3. `docker compose start dashboard` |
| **Redis が消えた** | 1. Dashboard を再起動（SQLite→Redis reseed が発動） 2. Bot を再起動（joined キー復旧） |
| **両方消えた** | 1. SQLite を先に復元 2. Dashboard を起動（reseed） 3. Bot を起動（joined） |

#### 復元コマンド

```bash
# SQLite の復元
docker compose stop dashboard
docker run --rm \
  -v twitterrx_dashboard_data:/target \
  -v $(pwd)/backup:/backup \
  alpine tar xvf /backup/dashboard-YYYYMMDD.tar -C /target
docker compose start dashboard

# Redis の復元（通常は不要、reseed で復旧するため）
docker compose stop redis
docker run --rm \
  -v twitterrx_redis_data:/target \
  -v $(pwd)/backup:/backup \
  alpine tar xvf /backup/redis-YYYYMMDD.tar -C /target
docker compose start redis
```

#### バックアップの保持期間

| データ | 推奨保持期間 | 理由 |
|--------|--------------|------|
| SQLite | 30日以上 | 設定の永続データ、復旧に必須 |
| Redis | 7日程度 | reseed で復旧可能なため短めでも可 |

---

## 関連ドキュメント

- [DASHBOARD_SPEC.md](DASHBOARD_SPEC.md) - メイン仕様書
- [DASHBOARD_API_IMPLEMENTATION.md](DASHBOARD_API_IMPLEMENTATION.md) - API 実装ガイド
- [DASHBOARD_AUTH_IMPLEMENTATION.md](DASHBOARD_AUTH_IMPLEMENTATION.md) - 認証・認可実装
- [DASHBOARD_BOT_IMPLEMENTATION.md](DASHBOARD_BOT_IMPLEMENTATION.md) - Bot 側実装
- [DASHBOARD_FRONTEND_IMPLEMENTATION.md](DASHBOARD_FRONTEND_IMPLEMENTATION.md) - フロントエンド UI
