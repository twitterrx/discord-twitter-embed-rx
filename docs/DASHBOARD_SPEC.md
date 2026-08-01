# Dashboard 機能仕様書

## 1. 概要

### 1.1 目的

Discord Bot「TwitterRX」において、特定のチャンネルでのみ応答する機能を実現するため、Web ダッシュボードを提供する。

関連 Issue: [#136](https://github.com/t1nyb0x/discord-twitter-embed-rx/issues/136)

### 1.2 機能概要

- **チャンネルホワイトリスト設定**: サーバー管理者が Bot の応答を許可するチャンネルを指定
- **全選択 ON/OFF**: 全チャンネル許可 / 個別選択の切り替え
- **設定反映**: 設定更新後、Bot は数秒以内に反映（通常は瞬時）

### 1.3 SLO（Service Level Objectives）

| 指標 | 目標値 | 備考 |
|------|--------|------|
| 設定反映レイテンシ | p95 < 3秒 | Redis pub/sub による通常ケース |
| Dashboard 可用性 | 99% | Bot 稼働には影響しない |
| 設定取り逃し復旧（通常） | 最大 5分遅延 | キャッシュ期限切れ時の revalidate による |
| 設定取り逃し復旧（劣化） | 次のメッセージ受信時に最大30秒で追従 | subscribe 切断時は30秒間隔で Redis 確認 |

> **SLO の解釈について**
>
> - 「設定取り逃し復旧」は **Bot がメッセージを受信したタイミング** で発動する
> - Dashboard への「アクセス」ではなく、Bot への「メッセージ受信」がトリガー
> - 劣化モード時は 30秒間隔で Redis を確認するため、最大30秒遅延

> **★ P0対応: 設定反映「次のメッセージ受信時」の厳密な保証**
>
> 仕様では「そのギルドで次にメッセージ受信した時に getConfig を呼んで反映」とある。
> しかし Bot 側は LRU キャッシュ + 5分 revalidate を採用しているため、以下のズレが発生しうる：
>
> 1. pub/sub を取り逃した
> 2. その後メッセージが来た
> 3. しかし Bot がキャッシュが新しいから Redis を見に行かない
> 4. 結果「メッセージ来たのに反映されない」
>
> **★ 設計方針: シンプルさ優先**
>
> 「次のメッセージ受信時に必ず反映」は **SLO・期待値の話** であり、
> 厳密保証に落とすべきではない。複雑なロジックは実装バグの温床になる。
>
> **対策: pub/sub + 定期 revalidate のみ**
>
> ```typescript
> const REVALIDATE_INTERVAL = 5 * 60 * 1000; // 5分
> const DEGRADED_REVALIDATE_INTERVAL = 30 * 1000; // 劣化時: 30秒
>
> // pub/sub メッセージ受信時: キャッシュ無効化のみ
> this.subscriber.on('message', (channel, message) => {
>   if (channel !== 'app:config:update') return;
>   const { guildId, version } = JSON.parse(message);
>   
>   // キャッシュが古ければ無効化（version 比較）
>   const cached = this.cache.get(guildId);
>   if (cached && cached.data.version < version) {
>     this.cache.delete(guildId);
>   }
> });
>
> async getConfig(guildId: string): Promise<ConfigResult> {
>   const cached = this.cache.get(guildId);
>   if (cached) {
>     const age = Date.now() - cached.fetchedAt;
>     const interval = this.isSubscribed 
>       ? REVALIDATE_INTERVAL 
>       : DEGRADED_REVALIDATE_INTERVAL;
>     
>     if (age < interval) {
>       return { kind: 'found', data: cached.data };
>     }
>   }
>   // キャッシュなし or 期限切れ → Redis から取得
>   return this.fetchFromRedis(guildId);
> }
> ```
>
> **削除した過剰ロジック**:
> - ~~`latestKnownVersions` Map~~ → pub/sub 受信時の無効化で十分
> - ~~`lastDegradedFetch` Map~~ → 単純な interval 判定で十分
> - ~~getConfig 内での version 再比較~~ → pub/sub で無効化済み
>
> **設計根拠**:
> - pub/sub 取り逃しは「5分後の revalidate」で追従すれば十分
> - 劣化モードは 30秒間隔で十分（3秒は過剰）
> - 複雑なロジックより「壊れにくさ」を優先

> **重要: 設定反映のタイミング（SLO）**
>
> 設定変更の反映は **ベストエフォート** であり、厳密な即時保証はしない。
>
> | ケース | 期待される反映タイミング |
> |--------|----------------|
> | pub/sub 成功（通常） | 即時〜数秒 |
> | pub/sub 取り逃し | 最大5分後（revalidate 間隔） |
> | 劣化モード（subscribe 失敗） | 最大30秒後 |
> | Bot 再起動中 | 再起動後、最初のメッセージ受信時 |
>
> **管理者が「設定変えたのに反映されない」と感じるケース**:
> - そのギルドに **メッセージが来ていない**（Bot が getConfig を呼ばない）
> - これは正常な動作。メッセージが来れば設定は反映される。
>
> **ユーザーへの説明例（UI に表示）**:
> ```
> 設定は保存されました。
> 通常は数秒で反映されますが、最大5分かかる場合があります。
> ```
>
> **設計方針**: 「必ず次のメッセージで反映」は過剰保証。UI 表示で吸収する。

> **Note**: Redis pub/sub は配信保証がないため、「ミリ秒単位で即時反映」は保証できない。
> Bot 再起動中・subscribe 前の publish は取り逃す可能性がある。
> 取り逃した場合、そのギルドで次にメッセージを受信した際（キャッシュが 5分以上経過していれば）に Redis から再取得して追従する。

---

## 2. 技術スタック

| 層 | 技術 | 備考 |
|----|------|------|
| フロントエンド | Astro SSR + Preact Islands | 軽量・高速な Islands Architecture |
| 認証 | Discord OAuth2 + lucia-auth | サーバー管理権限チェック |
| セッション | Redis | TTL 付きセッション管理（7日） |
| 永続 DB | SQLite + Drizzle ORM | 自己ホスト型に適した軽量 DB |
| Redis クライアント | ioredis | pub/sub・再接続サポートのため採用 |
| 設定同期 | Redis pub/sub + 定期 revalidate | 取り逃し対策込み |
| デプロイ | Docker Compose (3コンテナ) | Bot / Dashboard / Redis |

### 2.1 技術選定の理由

#### Redis クライアント: ioredis を採用

- **理由**: pub/sub の再接続サポート、Promise API、TypeScript 対応
- **不採用**: `@upstash/redis` は REST ベースで pub/sub 非対応のため不採用

---

## 3. アーキテクチャ

### 3.1 システム構成図

```
┌─────────────────────────────────────────────────────────────┐
│                     既存 nginx                              │
│                        │                                    │
│                        ▼ (リバースプロキシ)                   │
├─────────────────────────────────────────────────────────────┤
│                   Docker Compose                            │
├─────────────────┬─────────────────┬─────────────────────────┤
│   Bot Container │ Dashboard       │         Redis           │
│   (Node.js)     │ (Astro SSR)     │                         │
│                 │                 │  ┌───────────────────┐  │
│  ┌───────────┐  │  ┌───────────┐  │  │ app:config:update │  │
│  │ Discord   │  │  │ Preact    │  │  │ (pub/sub channel) │  │
│  │ Client    │  │  │ Islands   │  │  ├───────────────────┤  │
│  └─────┬─────┘  │  └───────────┘  │  │ lucia:session:{id}│  │
│        │        │        │        │  │ (セッション)       │  │
│  ┌─────▼─────┐  │  ┌─────▼─────┐  │  ├───────────────────┤  │
│  │ Channel   │◄─┼──│ Settings  │──┼─►│ app:guild:*:config│  │
│  │ Config    │  │  │ API       │  │  │ (設定キャッシュ)   │  │
│  │ Service   │  │  └─────┬─────┘  │  └───────────────────┘  │
│  └───────────┘  │        │        │                         │
│   (subscribe)   │        ▼        │                         │
│                 │  ┌───────────┐  │                         │
│                 │  │  SQLite   │  │                         │
│                 │  │ (永続化)  │  │                         │
│                 │  └───────────┘  │                         │
└─────────────────┴─────────────────┴─────────────────────────┘
```

### 3.2 コンテナ構成

| コンテナ | 役割 | ポート |
|----------|------|--------|
| `twitter-rx` | Discord Bot | - (outbound only) |
| `dashboard` | Web ダッシュボード | 4321 (内部) |
| `redis` | セッション / キャッシュ / pub/sub | 6379 (内部) |

### 3.3 別コンテナ構成を採用した理由

1. **障害分離**: Dashboard のクラッシュが Bot に影響しない
2. **デプロイ独立性**: Dashboard 更新時に Bot を再起動不要
3. **既存 Redis 基盤の活用**: pub/sub による即時反映が容易

### 3.4 障害時の動作仕様

> **運用時のクイックリファレンスは [README.md](../README.md#トラブルシューティング) を参照**

#### 3.4.1 システム状態サマリー（通常系 / 劣化系 / 復旧系）

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         システム状態サマリー                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  【通常系】すべて正常                                                        │
│  ┌─────────┐    pub/sub     ┌─────────┐    SQLite     ┌───────────┐        │
│  │   Bot   │◄──────────────►│  Redis  │◄─────────────►│ Dashboard │        │
│  └─────────┘   (即時反映)   └─────────┘   (永続化)    └───────────┘        │
│       │                          │                          │              │
│       │                    config キャッシュ           設定変更 UI          │
│       └── isChannelAllowed() → Redis GET → 許可判定                        │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  【劣化系】pub/sub 切断（Redis 本体は生存）                                   │
│  ┌─────────┐       ✗       ┌─────────┐               ┌───────────┐        │
│  │   Bot   │◄─────────────►│  Redis  │◄─────────────►│ Dashboard │        │
│  └─────────┘  (subscribe   └─────────┘               └───────────┘        │
│       │        切断)             │                                         │
│       │                          │                                         │
│       └── 【劣化モード発動】30秒間隔で Redis GET （通常5分→短縮）              │
│           → 設定反映は「次のメッセージ受信時」に最大30秒遅延                         │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  【劣化系】Redis 完全ダウン                                                  │
│  ┌─────────┐       ✗       ┌─────────┐       ✗       ┌───────────┐        │
│  │   Bot   │◄─────────────►│  Redis  │◄─────────────►│ Dashboard │        │
│  └─────────┘               └─────────┘               └───────────┘        │
│       │                         ✗                          │              │
│       │                                            セッション失敗          │
│       └── REDIS_DOWN_FALLBACK に従う                Dashboard ログイン不可  │
│           allow（デフォルト）: 全チャンネル許可                              │
│           deny: 全メッセージ無視（whitelist を維持したい場合）                │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  【復旧系】Redis 再起動後                                                    │
│  ┌─────────┐               ┌─────────┐               ┌───────────┐        │
│  │   Bot   │──────────────►│  Redis  │◄──────────────│ Dashboard │        │
│  └─────────┘   ready で    └─────────┘   起動時に    └───────────┘        │
│       │        re-subscribe       │        SQLite→Redis                   │
│       │                           │        reseed 実行                     │
│       └── 自動復旧（5分以内に正常化）                                        │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### 3.4.2 障害パターン別の挙動

> **★ 矛盾解消: Redis キー消失時の Bot 挙動を統一**
>
> 従来の仕様では「Redisキー消失 → not_found → 全許可」と「全許可に戻って荒れる → reseed/reconcileで防ぐ」が混在していた。
> これを以下のように統一する：
>
> | 状況 | Bot の挙動 | 説明 |
> |------|------------|------|
> | config キーが存在しない（not_found） | `CONFIG_NOT_FOUND_FALLBACK` に従う | デフォルト allow。制限するには環境変数で `deny` を明示 |
> | Redis 自体に接続できない（error） | `REDIS_DOWN_FALLBACK` に従う | デフォルト allow。|
>
> **これにより「設定未作成」と「Redis 障害」を明確に分離しつつ、両方デフォルト allow で可用性を優先する（#549）。**

| 障害パターン | Bot の挙動 | Dashboard の挙動 | 復旧方法 |
|-------------|-----------|-----------------|---------|
| **Redis 死亡** | `REDIS_DOWN_FALLBACK` に従う（デフォルト: allow = 全許可） | ログイン不可、設定保存不可 | 自動復旧 |
| **pub/sub 切断** | 劣化モード（ギルド単位最小間隔で Redis GET） | 正常動作 | 自動再接続 |
| **Bot 再起動** | 起動後に自動復旧 | 正常動作 | 自動復旧 |
| **Dashboard 再起動** | 正常動作（Bot は影響なし） | 起動時に SQLite→Redis reseed | 自動復旧 |
| **Redis キー消失** | `CONFIG_NOT_FOUND_FALLBACK` に従う（デフォルト: allow） | 起動時/10分ごとの reconcile で補完 | Dashboard 再起動で強制 reseed |
| **SQLite 破損** | Redis キャッシュが残っていれば継続動作 | DB エラー | バックアップから復元 |

---

## 4. ドメインモデル

### 4.1 GuildConfig

サーバー（ギルド）単位の設定を管理する。

```typescript
// src/core/models/GuildConfig.ts

interface GuildConfig {
  guildId: string;           // Discord サーバー ID
  allowAllChannels: boolean; // true: 全チャンネル許可, false: ホワイトリスト制
  version: number;           // 楽観的ロック用バージョン（更新ごとにインクリメント）
  createdAt: Date;
  updatedAt: Date;
}
```

### 4.2 ChannelWhitelist

許可されたチャンネルのリストを管理する。

```typescript
// src/core/models/ChannelWhitelist.ts

interface ChannelWhitelist {
  guildId: string;          // Discord サーバー ID（複合主キー）
  channelId: string;        // 許可されたチャンネル ID（複合主キー）
}
```

> **設計判断**: `id` カラムは不要。`(guild_id, channel_id)` の複合主キーで十分。
> `createdAt` も不要（設定更新時に丸ごと置換するため個別の作成日時に意味がない）。

### 4.3 ConfigAuditLog

設定変更の監査ログ。

```typescript
// src/core/models/ConfigAuditLog.ts

interface ConfigAuditLog {
  id: number;               // 主キー
  guildId: string;          // 対象サーバー ID
  userId: string;           // 変更したユーザーの Discord ID
  action: 'update';         // アクション種別
  previousConfig: string;   // 変更前の設定（JSON）
  newConfig: string;        // 変更後の設定（JSON）
  createdAt: Date;
}
```

### 4.4 判定ロジック

> **注記（#549 以降）**: 以下は設計当時の実装例であり、既定値は当時のもの。
> 現行の既定は両変数とも `allow` で、実装は `src/core/services/ChannelConfigService.ts` の `parseFallback()` を参照。

```typescript
function isChannelAllowed(guildId: string, channelId: string): boolean {
  const config = getGuildConfig(guildId);
  
  // ★ P0対応: 設定が存在しない場合のデフォルトは deny（環境変数で制御可能）
  // 配布版では「設定未作成 = まだ管理されていない状態」としてdenyがセキュリティ上安全
  // 既存ユーザー互換のため CONFIG_NOT_FOUND_FALLBACK=allow を用意
  if (!config) {
    const fallback = process.env.CONFIG_NOT_FOUND_FALLBACK || 'deny';
    return fallback === 'allow';
  }
  
  // 全選択 ON の場合は許可
  if (config.allowAllChannels) return true;
  
  // ホワイトリストに含まれているか確認
  return isInWhitelist(guildId, channelId);
}
```

---

## 5. データベース設計

### 5.1 SQLite テーブル定義

#### guild_configs テーブル

| カラム | 型 | 制約 | 説明 |
|--------|------|------|------|
| guild_id | TEXT | PRIMARY KEY | Discord サーバー ID |
| allow_all_channels | INTEGER | NOT NULL DEFAULT 1 | 1: 全許可, 0: ホワイトリスト制 |
| version | INTEGER | NOT NULL DEFAULT 1 | 楽観的ロック用バージョン |
| created_at | TEXT | NOT NULL | ISO 8601 形式 |
| updated_at | TEXT | NOT NULL | ISO 8601 形式 |

#### channel_whitelist テーブル

| カラム | 型 | 制約 | 説明 |
|--------|------|------|------|
| guild_id | TEXT | NOT NULL | Discord サーバー ID |
| channel_id | TEXT | NOT NULL | 許可チャンネル ID |

**制約**:
- `PRIMARY KEY(guild_id, channel_id)` - 複合主キー
- `FOREIGN KEY(guild_id) REFERENCES guild_configs(guild_id) ON DELETE CASCADE`

#### config_audit_logs テーブル

| カラム | 型 | 制約 | 説明 |
|--------|------|------|------|
| id | INTEGER | PRIMARY KEY AUTOINCREMENT | 主キー |
| guild_id | TEXT | NOT NULL | 対象サーバー ID |
| user_id | TEXT | NOT NULL | 変更したユーザー ID |
| action | TEXT | NOT NULL | アクション種別 |
| previous_config | TEXT | NOT NULL | 変更前設定（JSON） |
| new_config | TEXT | NOT NULL | 変更後設定（JSON） |
| created_at | TEXT | NOT NULL | ISO 8601 形式 |

**インデックス**:
- `idx_audit_logs_guild_id` ON `config_audit_logs(guild_id)`
- `idx_audit_logs_created_at` ON `config_audit_logs(created_at)`

> **監査ログの保持期間について**
> 
> ~~現状は保持期間の制限を設けていない（永続保存）。~~
> 
> **★ 必須-2対応: 保持期間 180 日をデフォルト ON に明確化**
>
> 「配布先によっては永続にしてたら数年後に遅い/バックアップ重い」問題に加え、
> **監査ログに含まれる userId は個人識別子**であり、GDPR 等の観点からも
> 適切な保持期間を設けることが推奨される。
>
> | 環境変数 | 説明 | デフォルト |
> |----------|------|-----------|
> | `AUDIT_LOG_RETENTION_DAYS` | 保持日数。0 で無制限 | `180` |
>
> **デフォルト 180 日の根拠**:
> - Discord のサーバー監査ログと同程度の保持期間
> - 個人識別子の長期保持を回避（GDPR/プライバシー配慮）
> - SQLite ファイルの肥大化防止
>
> **userId（個人識別子）の取り扱いについて**:
> - `user_id` カラムに Discord ユーザー ID（snowflake）が記録される
> - ユーザーから削除要求があった場合は `cleanupByUserId()` で対応可能
> - 保持期間経過後は自動削除されるため、通常は個別対応不要
>
> **実装例**:
> ```typescript
> const RETENTION_DAYS = parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || '180', 10);
>
> async function cleanupOldAuditLogs(): Promise<void> {
>   if (RETENTION_DAYS === 0) {
>     console.log('[AuditLog] Retention is unlimited, skipping cleanup');
>     return;
>   }
>   
>   const cutoffDate = new Date();
>   cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
>   
>   const result = await db.run(sql`
>     DELETE FROM config_audit_logs 
>     WHERE created_at < ${cutoffDate.toISOString()}
>   `);
>   
>   console.log(`[AuditLog] Cleaned up ${result.changes} old records (older than ${RETENTION_DAYS} days)`);
> }
>
> // Dashboard 起動時 + 日次で実行
> setInterval(cleanupOldAuditLogs, 24 * 60 * 60 * 1000);
> ```
>
> **ユーザー削除要求への対応**:
>
> **★ P1対応: cleanupByUserId の権限・認可仕様（MUST）**
>
> | 項目 | 仕様 |
> |------|------|
> | **実行権限** | アプリ運用者のみ（サーバー管理者は不可） |
> | **認可方法** | CLI ツールまたは内部 API（Dashboard UI からは呼び出せない） |
> | **監査** | 削除操作自体を別テーブル `audit_log_deletions` に記録 |
> | **レート制限** | 1 分あたり 10 回まで（乱用防止） |
>
> **★ 重要: 公開 HTTP API にしてはいけない（MUST NOT）**
>
> この関数を HTTP API として公開すると「任意ユーザーの監査ログ削除 API」になり、
> セキュリティ事故の原因となる。以下を MUST とする：
>
> 1. **HTTP エンドポイントを作成しない**: `/api/audit-logs/cleanup` のような API は作らない
> 2. **CLI ツールとして提供**: `npx tsx scripts/cleanup-user-audit-logs.ts <userId>` のような形式
> 3. **環境変数で実行者を識別**: `OPERATOR_ID` を必須とし、誰が実行したか記録
> 4. **本番環境のみ**: ローカル開発では動作しないようにガード
>
> **CLI ツール実装例**:
> ```typescript
> // scripts/cleanup-user-audit-logs.ts
> // ★ HTTP API としては公開しない。CLI からのみ実行可能
>
> const userId = process.argv[2];
> const operatorId = process.env.OPERATOR_ID;
>
> if (!userId || !operatorId) {
>   console.error('Usage: OPERATOR_ID=<your-id> npx tsx scripts/cleanup-user-audit-logs.ts <userId>');
>   process.exit(1);
> }
>
> // 本番環境チェック（オプション）
> if (process.env.NODE_ENV !== 'production') {
>   console.error('This script should only run in production');
>   process.exit(1);
> }
>
> const deleted = await cleanupByUserId(userId, operatorId);
> console.log(`Deleted ${deleted} audit log records for user ${userId}`);
> ```
>
> **内部関数実装例**:
> ```typescript
> // GDPR/プライバシー対応: 特定ユーザーの監査ログを削除
> // ★ CLI ツールまたは内部 API からのみ呼び出し可能
> async function cleanupByUserId(userId: string, operatorId: string): Promise<number> {
>   // 削除前に件数を取得
>   const countResult = await db.get(sql`
>     SELECT COUNT(*) as count FROM config_audit_logs 
>     WHERE user_id = ${userId}
>   `);
>   
>   const result = await db.run(sql`
>     DELETE FROM config_audit_logs 
>     WHERE user_id = ${userId}
>   `);
>   
>   // ★ 削除操作自体の監査ログを記録
>   await db.run(sql`
>     INSERT INTO audit_log_deletions (target_user_id, deleted_count, operator_id, deleted_at)
>     VALUES (${userId}, ${result.changes}, ${operatorId}, ${new Date().toISOString()})
>   `);
>   
>   console.log(`[AuditLog] Deleted ${result.changes} records for user ${userId} by operator ${operatorId}`);
>   return result.changes;
> }
> ```
>
> **audit_log_deletions テーブル**:
> | カラム | 型 | 説明 |
> |--------|------|------|
> | id | INTEGER | PRIMARY KEY AUTOINCREMENT |
> | target_user_id | TEXT | 削除対象のユーザー ID |
> | deleted_count | INTEGER | 削除した件数 |
> | operator_id | TEXT | 操作を実行した運用者 ID |
> | deleted_at | TEXT | ISO 8601 形式 |
>
> **バックアップ手順への追記**:
> - 軽量化オプション: バックアップ前に `cleanupOldAuditLogs()` を実行することで容量削減

### 5.2 Drizzle ORM スキーマ

```typescript
// dashboard/src/db/schema.ts

import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

export const guildConfigs = sqliteTable('guild_configs', {
  guildId: text('guild_id').primaryKey(),
  allowAllChannels: integer('allow_all_channels', { mode: 'boolean' }).notNull().default(true),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const channelWhitelist = sqliteTable('channel_whitelist', {
  guildId: text('guild_id').notNull().references(() => guildConfigs.guildId, { onDelete: 'cascade' }),
  channelId: text('channel_id').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.guildId, table.channelId] }),
}));

export const configAuditLogs = sqliteTable('config_audit_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  guildId: text('guild_id').notNull(),
  userId: text('user_id').notNull(),
  action: text('action').notNull(),  // 'update' | 'create_default'
  previousConfig: text('previous_config').notNull(),
  newConfig: text('new_config').notNull(),
  createdAt: text('created_at').notNull(),
});
```

> **監査ログの JSON フィールド設計**
>
> **★ P1対応: _metadata は JSON に含めない**
>
> `previousConfig` / `newConfig` に保存する JSON は、**フィールドを固定**すること。
> trigger / description などのメタ情報は `action` カラムで表現する。
>
> **action カラムの値**（トリガー情報はここで表現）:
> | action | 説明 |
> |--------|------|
> | `update` | ユーザーによる通常の設定変更 |
> | `create_default` | デフォルト設定の作成 |
> | `manual_initialize` | ユーザー明示の初期化 |
> | `auto_create_on_get` | GET による自動作成（非推奨、後方互換用） |
>
> **許可するフィールド**（これ以外は含めない）:
> ```typescript
> interface AuditLogConfig {
>   allowAllChannels: boolean;
>   whitelist: string[];  // チャンネル ID のみ（名前は含めない）
>   // ★ _metadata は含めない
> }
> ```
>
> **含めてはいけない情報**:
> - ~~`_metadata`~~ → action カラムで表現
> - ギルド名、チャンネル名（Discord 側で変わる可能性）
> - ユーザー名、アバター（PII に該当）
> - 権限情報（変動する）
>
> **実装例**:
> ```typescript
> function buildAuditConfig(config: GuildConfig, whitelist: string[]): string {
>   // 必要なフィールドのみを抽出（_metadata は含めない）
>   return JSON.stringify({
>     allowAllChannels: config.allowAllChannels,
>     whitelist,
>   });
> }
> ```

### 5.3 マイグレーション戦略

#### 初回セットアップ

```bash
# Dashboard コンテナ起動時に自動実行
npx drizzle-kit push:sqlite
```

#### バージョンアップ時

1. Drizzle Kit でマイグレーションファイル生成
2. Docker イメージビルド時にマイグレーションを含める
3. コンテナ起動時に `drizzle-kit migrate` を実行

#### バックアップ・復旧

> **★ P1対応: Volume 方針の統一**
>
> 配布版では **named volume** を推奨（`docker compose down -v` しない限りデータ永続）。
> bind mount（`./data/...`）はホスト側のパーミッション問題が起きやすいため、上級者向け。
>
> | 方式 | メリット | デメリット |
> |------|----------|------------|
> | named volume | パーミッション問題が起きにくい、compose down -v しなければ永続 | ホストから直接見えにくい |
> | bind mount | ホストから直接ファイル操作可能 | パーミッション問題、パス管理が必要 |
>
> **推奨: named volume**（compose.yml で採用している方式）

```yaml
# compose.yml での volume 設定（★ named volume を使用）
volumes:
  dashboard_data:  # named volume 定義

services:
  dashboard:
    volumes:
      - dashboard_data:/app/data  # named volume をマウント
```

**バックアップ手順（named volume の場合）**:

```bash
# named volume のバックアップ（推奨）
docker run --rm \
  -v twitterrx_dashboard_data:/source:ro \
  -v $(pwd)/backup:/backup \
  alpine tar cvf /backup/dashboard-backup.tar -C /source .

# 復旧
docker run --rm \
  -v twitterrx_dashboard_data:/target \
  -v $(pwd)/backup:/backup \
  alpine tar xvf /backup/dashboard-backup.tar -C /target
```

**bind mount を使いたい場合（上級者向け）**:

```yaml
# compose.yml.bind-mount（bind mount 版）
services:
  dashboard:
    volumes:
      - ./data:/app/data  # bind mount
```

```bash
# bind mount のバックアップ
cp ./data/dashboard.db ./data/dashboard.db.bak

# 復旧
cp ./data/dashboard.db.bak ./data/dashboard.db
docker compose restart dashboard
```

- **破損時**: バックアップから復元、または `guild_configs` を空にして再設定

### 5.4 Redis キー設計

#### 5.4.1 キー名前空間の分離

責任の所在を明確にするため、Redis キーは **prefix で名前空間を分離**する。

| Prefix | 管理責任 | 説明 |
|--------|----------|------|
| `lucia:*` | lucia-auth | セッション・ユーザー情報（lucia-auth の内部形式に従う） |
| `app:*` | アプリケーション | Dashboard/Bot が直接操作するキー |

> **重要**: lucia-auth は `RedisAdapter` に指定した prefix でキーを生成する。
> アプリケーションが直接使うキーは `app:` prefix を付けることで、
> 「このキーは誰の責任か」が一目でわかり、運用時の混乱を防止する。

#### 5.4.2 キーパターン一覧

**lucia-auth 管轄（触らない）**:

| キーパターン | 型 | TTL | 用途 |
|-------------|------|-----|------|
| `lucia:session:{sessionId}` | Hash/JSON | 7日 | lucia-auth が管理するセッション |
| `lucia:user:{userId}` | Hash/JSON | 7日 | lucia-auth が管理するユーザー情報 |

**アプリケーション管轄**:

| キーパターン | 型 | TTL | 用途 |
|-------------|------|-----|------|
| `app:meta:config_schema_version` | String | なし | ★ P1: 設定スキーマバージョン（reseed 判定用） |
| `app:user:{userId}:guilds` | String (JSON) | 1時間 | ユーザーのギルド一覧キャッシュ（複数セッション共有） |
| `app:guild:{guildId}:joined` | String (`1`) | なし | Bot 参加フラグ（botJoined 判定用） |
| `app:guild:{guildId}:config` | String (JSON) | なし | 設定キャッシュ（永続） |
| `app:guild:{guildId}:channels` | String (JSON) | 1時間 | チャンネル一覧キャッシュ（Bot が供給） |
| `app:oauth:state:{state}` | String | 10分 | OAuth2 state 一時保存 |
| `app:csrf:{sessionId}` | String | セッションと同期 | CSRF トークン |
| `app:config:update` | Pub/Sub Channel | - | 設定変更通知 |

> **セッションキー設計の補足**:
> - `lucia:session:{sessionId}`: lucia-auth が管理するセッション本体（sessionId 単位）
> - `app:user:{userId}:guilds`: ギルド一覧キャッシュ（userId 単位、1ユーザー複数セッションでも共有）
> - CSRF トークンは sessionId 単位で発行（セッションごとに異なる）

#### データソースの明確化

| データ | ソースオブトゥルース | キャッシュ | 作成責任 |
|--------|---------------------|------------|----------|
| ギルド設定（whitelist 等） | SQLite (`guild_configs`, `channel_whitelist`) | Redis (`app:guild:{id}:config`) | **Dashboard** |
| Bot 参加状態 | Discord（Bot の `guildCreate`/`guildDelete` イベント） | Redis (`app:guild:{id}:joined`) | **Bot** |
| チャンネル一覧 | Discord API（Bot が取得） | Redis (`app:guild:{id}:channels`) | **Bot** |

> **重要**: 
> - Bot は SQLite を直接読み書きしない。Dashboard のみが SQLite を操作し、Redis を経由して Bot と同期する。
> - **config の作成責任は Dashboard にある**。Bot は config がない場合 `CONFIG_NOT_FOUND_FALLBACK` に従う（デフォルト: allow）。
> - Bot は `joined` フラグと `channels` キャッシュのみを管理する。

> **★ P0対応: Redis消失時の復旧導線（SQLite→Redis再シード）**
>
> Bot の SoT が Redis で、Dashboard の SoT が SQLite という設計のため、
> Redis の `app:guild:{id}:config` が失われた場合、Bot は「未設定」として全許可で動作してしまう。
> これは配布版で「全チャンネル許可に戻って荒れる」というセキュリティ事故につながる。
>
> **★ P1対応: メタキーによる reseed 条件の強化**
>
> Redis AOF + SQLite → Redis 再シードが両方ある。これは"保険が二枚"で良いが、
> AOF が壊れた/巻き戻った場合に「config キーは残っているが古い」という状態が起こりうる。
>
> **対策**: `app:meta:config_schema_version` メタキーを使用して reseed 判定を強化。
>
> | 状況 | reseed 実行 |
> |------|-------------|
> | メタキーが存在しない | ✅ 実行 |
> | メタキーが期待値と異なる | ✅ 実行（スキーマ変更時の自動マイグレーション） |
> | メタキーが期待値と一致 | ❌ スキップ |
>
> **対策: Dashboard 起動時に SQLite→Redis 再シードを実行**
>
> ```typescript
> // dashboard/src/lib/redis-reseed.ts
> 
> const EXPECTED_SCHEMA_VERSION = '1';  // スキーマ変更時にインクリメント
>
> /**
>  * Dashboard 起動時に SQLite の設定を Redis に再シードする
>  * Redis が空の場合、またはスキーマバージョンが異なる場合に実行
>  */
> async function reseedRedisFromSQLite(): Promise<void> {
>   const startTime = Date.now();
>   
>   // ★ P1対応: メタキーでスキーマバージョンを確認
>   const schemaVersion = await redis.get('app:meta:config_schema_version');
>   
>   if (schemaVersion === EXPECTED_SCHEMA_VERSION) {
>     // ★ P1対応: schema version が一致しても、部分的なキー欠落をチェック
>     // Redis AOF 破損などで一部キーだけ消えるケースに対応
>     console.log(`[Reseed] Schema version matches (v${schemaVersion}), checking for partial key loss...`);
>     
>     // joined なギルドで config が欠落しているものがないか確認
>     const missingConfigs = await checkForMissingConfigs();
>     if (missingConfigs.length > 0) {
>       console.log(`[Reseed] Found ${missingConfigs.length} guilds with missing config, performing partial reseed...`);
>       await partialReseed(missingConfigs);
>     } else {
>       console.log('[Reseed] All configs intact, skipping reseed');
>     }
>     return;
>   }
>   
>   if (schemaVersion && schemaVersion !== EXPECTED_SCHEMA_VERSION) {
>     console.log(`[Reseed] Schema version mismatch: expected v${EXPECTED_SCHEMA_VERSION}, found v${schemaVersion}`);
>     console.log('[Reseed] Performing schema migration reseed...');
>   } else {
>     console.log('[Reseed] No schema version found, checking config keys...');
>     
>     // 従来のロジック: config キー数を確認
>     let configCount = 0;
>     let cursor = '0';
>     do {
>       const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'app:guild:*:config', 'COUNT', 100);
>       cursor = nextCursor;
>       configCount += keys.length;
>       if (configCount > 0) break;
>     } while (cursor !== '0');
>     
>     if (configCount > 0) {
>       // config はあるがメタキーがない → v1 以前からの移行
>       console.log(`[Reseed] Found ${configCount}+ config keys but no schema version`);
>       console.log('[Reseed] Setting schema version without reseed (legacy migration)');
>       await redis.set('app:meta:config_schema_version', EXPECTED_SCHEMA_VERSION);
>       return;
>     }
>   }
>   
>   console.log('[Reseed] Reseeding from SQLite...');
>   // ... 既存の reseed ロジック ...
>   
>   // ★ 最後にスキーマバージョンを設定
>   await redis.set('app:meta:config_schema_version', EXPECTED_SCHEMA_VERSION);
>   
>   const elapsed = Date.now() - startTime;
>   console.log(`[Reseed] Completed in ${elapsed}ms`);
> }
>
> /**
>  * ★ P1対応: 部分的なキー欠落をチェック
>  * joined なギルドで config が Redis に存在しないものを検出
>  */
> async function checkForMissingConfigs(): Promise<string[]> {
>   const missingGuildIds: string[] = [];
>   
>   // 1. joined なギルド ID を収集
>   const joinedGuildIds: string[] = [];
>   let cursor = '0';
>   do {
>     const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'app:guild:*:joined', 'COUNT', 100);
>     cursor = nextCursor;
>     for (const key of keys) {
>       const guildId = key.split(':')[2];
>       joinedGuildIds.push(guildId);
>     }
>   } while (cursor !== '0');
>   
>   // 2. 各ギルドの config が存在するか確認（パイプラインで効率化）
>   if (joinedGuildIds.length === 0) return [];
>   
>   const pipeline = redis.pipeline();
>   for (const guildId of joinedGuildIds) {
>     pipeline.exists(`app:guild:${guildId}:config`);
>   }
>   const results = await pipeline.exec();
>   
>   for (let i = 0; i < joinedGuildIds.length; i++) {
>     const [err, exists] = results![i];
>     if (!err && exists === 0) {
>       // SQLite に設定が存在するか確認（存在しない場合は補完不要）
>       const dbConfig = await db.query.guildConfigs.findFirst({
>         where: eq(guildConfigs.guildId, joinedGuildIds[i])
>       });
>       if (dbConfig) {
>         missingGuildIds.push(joinedGuildIds[i]);
>       }
>     }
>   }
>   
>   return missingGuildIds;
> }
>
> /**
>  * ★ P1対応: 部分的な reseed（欠落したキーのみ補完）
>  */
> async function partialReseed(guildIds: string[]): Promise<void> {
>   for (const guildId of guildIds) {
>     const dbConfig = await db.query.guildConfigs.findFirst({
>       where: eq(guildConfigs.guildId, guildId)
>     });
>     if (!dbConfig) continue;
>     
>     const whitelist = await db.select()
>       .from(channelWhitelist)
>       .where(eq(channelWhitelist.guildId, guildId));
>     
>     const redisConfig = {
>       guildId: dbConfig.guildId,
>       allowAllChannels: dbConfig.allowAllChannels,
>       whitelist: whitelist.map(w => w.channelId),
>       version: dbConfig.version,
>       updatedAt: dbConfig.updatedAt,
>     };
>     
>     await redis.set(`app:guild:${guildId}:config`, JSON.stringify(redisConfig));
>     console.log(`[Reseed] Restored config for guild ${guildId}`);
>   }
> }
> ```
>   
>   // SQLite から全ギルド設定を取得
>   const configs = await db.select().from(guildConfigs);
>   let seededCount = 0;
>   
>   for (const config of configs) {
>     // ホワイトリストを取得
>     const whitelist = await db.select()
>       .from(channelWhitelist)
>       .where(eq(channelWhitelist.guildId, config.guildId));
>     
>     // Redis に SET（TTL なし）
>     const redisConfig = {
>       guildId: config.guildId,
>       allowAllChannels: config.allowAllChannels,
>       whitelist: whitelist.map(w => w.channelId),
>       version: config.version,
>       updatedAt: config.updatedAt,
>     };
>     
>     await redis.set(
>       `app:guild:${config.guildId}:config`,
>       JSON.stringify(redisConfig)
>     );
>     seededCount++;
>   }
>   
>   const elapsed = Date.now() - startTime;
>   console.log(`[Reseed] Completed: ${seededCount} configs reseeded in ${elapsed}ms`);
> }
> 
> // Dashboard 起動時に実行
> // astro.config.mjs または entry point で呼び出す
> ```
>
> **実行条件**:
> - Redis の `app:guild:*:config` キーが 0 件の場合のみ実行
> - 通常の運用では実行されない（既に config がある）
> - volume 飛ばし / `docker compose down -v` / Redis 初期化時のみ発動
>
> **マイルストーンへの追加**: Phase 1 に「Redis 再シード処理実装」を追加

> **★ P1対応: 定期リコンシル（整合化ジョブ）**
>
> 起動時 reseed だけでは、運用中のキー欠損を拾えない。
> Redis の AOF 破損や一部キー欠落は配布版で普通に起こりうる。
>
> **対策**: Dashboard に定期リコンシル処理を追加
>
> **★ P1-3対応: 実装例は別ドキュメントへ**
>
> 本仕様書には「要件」と「期待挙動」のみを記載し、
> 詳細な実装コード例は別ドキュメント（`docs/IMPLEMENTATION_EXAMPLES.md`）に分離することを推奨。
>
> **Reseed/Reconcile の要件サマリ**:
>
> | 機能 | トリガー | 要件 | 実装責務 |
> |------|----------|------|----------|
> | Reseed | Dashboard 起動時 | SQLite の全 config を Redis に書き込む。`app:meta:seeded` が存在しなければ実行 | Dashboard |
> | Reconcile | 10分ごと | `joined` があるギルドの `config` キーが欠落していれば SQLite から補完 | Dashboard（setInterval） |
> | Orphan Cleanup | 日次（デフォルト OFF） | `orphaned_at` + 保持期間を超えた設定を削除 | Dashboard（setInterval） |
>
> **10分間隔の根拠**:
> - Redis キー欠損は稀なイベント（AOF 破損、手動削除、etc.）
> - 頻繁すぎると Redis への負荷増加（SCAN コマンド）
> - 10分以内に復旧すれば運用上問題なし（SLO 5分 revalidate より緩い）
> - 環境変数 `RECONCILE_INTERVAL_MS` で調整可能にすることを推奨
>
> **期待挙動**:
> - Reseed: 起動時に 1 回のみ実行、冪等（何度実行しても同じ結果）
> - Reconcile: joined なギルドのみ対象、SCAN でキー取得（KEYS は使わない）
> - Orphan Cleanup: デフォルト OFF、`ENABLE_ORPHAN_CLEANUP=true` で有効化
>
> **実装例の配置先**: `docs/IMPLEMENTATION_EXAMPLES.md` セクション 3

> ~~詳細実装例（P1-3対応により別ドキュメントへ移動予定）~~
>
> ```typescript
> // dashboard/src/lib/reconcile.ts
>
> const RECONCILE_INTERVAL = 10 * 60 * 1000; // 10分ごと
>
> /**
>  * 定期的に joined なギルドの config キー存在を確認し、欠落があれば補完する
>  */
> async function startReconcileJob(): Promise<void> {
>   setInterval(async () => {
>     try {
>       await reconcileConfigs();
>     } catch (err) {
>       console.error('[Reconcile] Failed:', err);
>     }
>   }, RECONCILE_INTERVAL);
>   
>   console.log(`[Reconcile] Started reconcile job (interval: ${RECONCILE_INTERVAL / 1000}s)`);
> }
>
> async function reconcileConfigs(): Promise<void> {
>   const startTime = Date.now();
>   let reconciledCount = 0;
>   
>   // 1. Redis から joined なギルドを SCAN で取得
>   const joinedGuildIds: string[] = [];
>   let cursor = '0';
>   do {
>     const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'app:guild:*:joined', 'COUNT', 100);
>     cursor = nextCursor;
>     for (const key of keys) {
>       const guildId = key.split(':')[2]; // app:guild:{id}:joined
>       joinedGuildIds.push(guildId);
>     }
>   } while (cursor !== '0');
>   
>   // 2. 各ギルドの config キーが存在するか確認
>   for (const guildId of joinedGuildIds) {
>     const configExists = await redis.exists(`app:guild:${guildId}:config`);
>     if (configExists) continue;
>     
>     // 3. config が欠落している → SQLite から補完
>     const dbConfig = await db.query.guildConfigs.findFirst({
>       where: eq(guildConfigs.guildId, guildId)
>     });
>     
>     if (!dbConfig) {
>       // SQLite にも存在しない = まだ Dashboard で開かれていない（正常）
>       continue;
>     }
>     
>     // 4. whitelist も取得して Redis に再シード
>     const whitelist = await db.select()
>       .from(channelWhitelist)
>       .where(eq(channelWhitelist.guildId, guildId));
>     
>     const redisConfig = {
>       guildId: dbConfig.guildId,
>       allowAllChannels: dbConfig.allowAllChannels,
>       whitelist: whitelist.map(w => w.channelId),
>       version: dbConfig.version,
>       updatedAt: dbConfig.updatedAt,
>     };
>     
>     await redis.set(`app:guild:${guildId}:config`, JSON.stringify(redisConfig));
>     reconciledCount++;
>     
>     console.log(`[Reconcile] Restored config for guild ${guildId}`);
>   }
>   
>   const elapsed = Date.now() - startTime;
>   if (reconciledCount > 0) {
>     console.log(`[Reconcile] Completed: restored ${reconciledCount} configs in ${elapsed}ms`);
>   }
> }
>
> // Dashboard 起動時に開始
> startReconcileJob();
> ```
>
> **これにより解消される問題**:
> - Bot 再参加後に Dashboard が開かれないまま config が欠落しているケース
> - Redis AOF の部分的な破損でキーが一部消えたケース
>
> **負荷考慮**:
> - SCAN は Redis をブロックしない（KEYSと違い安全）
> - 10分ごとなので負荷は低い
> - 通常運用ではほとんど何もしない（config が揃っているため）

> **★ P1対応: 整合性モデルの明確化**
>
> **仕様上の整合性モデル: 結果整合（Eventual Consistency）**
>
> Dashboard の PUT は「SQLite commit + Redis SET + PUBLISH」を試みるが、
> **Redis SET 失敗時でもデータは最終的に整合する**ことを前提とした**結果整合モデル**を採用する。
>
> | 整合性モデル | 説明 | 本仕様での採用 |
> |--------------|------|----------------|
> | **強整合（Strong Consistency）** | 全操作が成功するまで commit しない | ❌ 不採用（Redis 障害時に UX が過剰に悪化） |
> | **結果整合（Eventual Consistency）** | 一時的な不整合を許容し、バックグラウンドで追いつく | ✅ 採用 |
>
> **結果整合を成立させる仕組み（MUST）**:
>
> 1. **定期リコンシル（10分ごと）**: Dashboard が SQLite→Redis の整合性をチェックし、欠落を補完
> 2. **起動時 reseed**: Dashboard 起動時に SQLite から Redis へ再シード
>
> **v2 候補: アウトボックス方式**:
> - より堅牢にするならペンディングテーブルで再試行を保証
> - 現行の「起動時 reseed + 10分 reconcile」で結果整合は成立しているため、v1 では採用しない
>
> **503 レスポンス時の挙動**:
> - Redis SET 失敗時は `503 Service Unavailable` を返す
> - ただし SQLite は既に commit 済みの可能性がある
> - レスポンスに「保存は完了している可能性があります」と現在 version を含める
> - **定期リコンシルにより最終的に Redis は追いつく**
>
> **運用者への説明**:
> ```
> このシステムは「結果整合」モデルを採用しています。
> Redis 障害時に一時的な不整合が発生しても、最大10分後には自動的に整合します。
> 503 エラーが発生した場合は、ページを再読み込みして現在の設定を確認してください。
> ```

> **★ v2 候補: アウトボックス方式（より堅牢な同期）**
>
> 現在の設計では「SQLite commit済みだが Redis SET 失敗」の状態が発生しうるが、
> **定期リコンシル（10分ごと）で最終的に整合するため、v1 では採用しない**。
>
> **v2 で採用を検討する条件**:
> - 大規模運用（100+ ギルド）で整合性の即時性が求められる場合
> - Redis 障害が頻繁に発生する環境
> - SLA で「最大10分遅延」が許容されない場合
>
> **実装コスト/運用コストの考慮**:
> - pending_redis_updates テーブルの追加
> - バックグラウンドジョブの実装・監視
> - リトライ上限到達時のアラート
>
> **結論**: v1 では「起動時 reseed + 10分 reconcile」で十分。アウトボックスは v2 で再評価。
>
> ~~以下は参考実装（v2 候補）~~
>
> **pending_redis_updates テーブル**:
> ```sql
> CREATE TABLE pending_redis_updates (
>   id INTEGER PRIMARY KEY AUTOINCREMENT,
>   guild_id TEXT NOT NULL,
>   operation TEXT NOT NULL,  -- 'SET' | 'DELETE'
>   payload TEXT NOT NULL,    -- JSON
>   created_at TEXT NOT NULL,
>   retry_count INTEGER NOT NULL DEFAULT 0
> );
> ```
>
> **実装イメージ**:
> ```typescript
> // 設定更新トランザクション内で pending も同時に INSERT
> await db.transaction(async (tx) => {
>   // ... 設定更新 ...
>   
>   // pending に追加（トランザクション内で確実に記録）
>   await tx.insert(pendingRedisUpdates).values({
>     guildId,
>     operation: 'SET',
>     payload: JSON.stringify(redisConfig),
>     createdAt: now.toISOString(),
>   });
> });
>
> // トランザクション外で Redis 更新を試行
> try {
>   await redis.set(`app:guild:${guildId}:config`, JSON.stringify(redisConfig));
>   // 成功したら pending を削除
>   await db.delete(pendingRedisUpdates).where(eq(pendingRedisUpdates.id, pendingId));
> } catch (err) {
>   console.error('[Redis] SET failed, pending will be retried:', err);
>   // pending に残るので、バックグラウンドジョブで再試行される
> }
> ```
>
> **バックグラウンドジョブ（1分ごと）**:
> ```typescript
> async function processPendingRedisUpdates(): Promise<void> {
>   const pendings = await db.select().from(pendingRedisUpdates)
>     .where(lt(pendingRedisUpdates.retryCount, 5))
>     .orderBy(asc(pendingRedisUpdates.createdAt))
>     .limit(100);
>   
>   for (const pending of pendings) {
>     try {
>       if (pending.operation === 'SET') {
>         await redis.set(`app:guild:${pending.guildId}:config`, pending.payload);
>       }
>       await db.delete(pendingRedisUpdates).where(eq(pendingRedisUpdates.id, pending.id));
>     } catch {
>       await db.update(pendingRedisUpdates)
>         .set({ retryCount: pending.retryCount + 1 })
>         .where(eq(pendingRedisUpdates.id, pending.id));
>     }
>   }
> }
> ```
>
> **採用判断**: v1 では「定期リコンシル」で代替。
> アウトボックス方式は v2 候補として再評価する。

#### Redis キャッシュの JSON スキーマ

**`app:guild:{guildId}:config`**:
```json
{
  "guildId": "123456789012345678",
  "allowAllChannels": true,
  "whitelist": ["111111111", "222222222"],
  "version": 1,
  "updatedAt": "2026-01-10T12:00:00.000Z"
}
```

| キー | 型 | 必須 | 説明 |
|------|------|------|------|
| `guildId` | string | ✅ | Discord サーバー ID |
| `allowAllChannels` | boolean | ✅ | 全チャンネル許可フラグ |
| `whitelist` | string[] | ✅ | 許可チャンネル ID 配列 |
| `version` | number | ✅ | 楽観的ロック用バージョン |
| `updatedAt` | string | ✅ | ISO 8601 形式の更新日時 |

**`app:guild:{guildId}:channels`**:
```json
[
  { "id": "111111111", "name": "general", "type": 0 },
  { "id": "222222222", "name": "bot-commands", "type": 0 }
]
```

**pub/sub メッセージ形式（`app:config:update` チャンネル）**:
```json
{
  "guildId": "123456789012345678",
  "version": 2
}
```

> **Note**: pub/sub チャンネル名は `app:config:update` で統一。
> 仕様内の記述が `config:update` になっている箇所は誤り。

> **セッションデータの保存先について**
>
> lucia-auth はセッションを `lucia:session:{sessionId}` キーに保存する。
> アプリケーションが直接操作するデータは以下のように分離する：
>
> | データ | キー | 管理責任 |
> |--------|-----|----------|
> | セッション本体 | `lucia:session:{sessionId}` | lucia-auth |
> | ギルド一覧キャッシュ | `app:user:{userId}:guilds` | アプリケーション |
> | CSRF トークン | `app:csrf:{sessionId}` | アプリケーション |
>
> **lucia-auth セッションに保存するデータ**（最小限）:
> ```typescript
> interface LuciaSessionData {
>   userId: string;
>   encryptedAccessToken: string;  // AEAD 暗号化済み
>   expiresAt: number;             // Discordのexpires_inから計算
> }
> ```
>
> **ギルド一覧は別キー**（`app:user:{userId}:guilds`）:
> - 1ユーザーが複数セッションを持つ場合でも共有
> - セッションサイズを小さく保つ

#### Redis キャッシュの永続性戦略

**設計方針: config は TTL なし（永続）**:

Bot は SQLite を読まず、Redis のみを参照する設計のため、config キャッシュは **TTL なしで永続保存** する。
これにより「24時間更新がないと設定が消えて全チャンネル許可に戻る」事故を防止する。

| キー | TTL | 備考 |
|-----|-----|------|
| `app:guild:{id}:config` | なし | Dashboard が更新時に `SET` で上書き |
| `app:guild:{id}:joined` | なし | Bot 参加状態（`guildCreate`/`guildDelete` で管理） |
| `app:guild:{id}:channels` | 1時間 | チャンネル一覧（頻繁に変わりうる、古くてもOK） |

> **重要**: Bot 視点では Redis が SoT（Source of Truth）である。
> SQLite は Dashboard の永続 DB だが、Bot は SQLite を読まない。
> そのため config は Redis から消えてはいけない。

```typescript
// 設定更新時：TTL なしで保存（永続）
await redis.set(`app:guild:${guildId}:config`, JSON.stringify(config));
```

#### ガベージコレクション

> **Note**: `app:guild:{id}:config` と `app:guild:{id}:joined` は TTL なし（永続）のため、
> Bot 離脱時に `guildDelete` イベントで明示的に削除する。
> これにより、離脱済みギルドのキーが残り続けることを防止する。

> **★ P1対応: 配布版デフォルトの軽量化**
>
> Reconcile/Reseed/Orphan cleanup を全部入れると壊れやすい。
> **配布版デフォルトはシンプルな構成に絞る**。
>
> | 機能 | デフォルト | 説明 |
> |------|-----------|------|
> | 起動時 reseed | ON | Dashboard 起動時に SQLite→Redis 再シード |
> | 10分ごと reconcile | ON | 稼働中のキー欠損を補完 |
> | orphan cleanup | **OFF** | 孤立キーの掃除（大規模運用向け） |
> | schema version チェック | ON | マイグレーション管理 |
>
> **設計根拠**:
> - orphan cleanup は大量ギルド運用でしか意味がない
> - 有効化したい場合は `ENABLE_ORPHAN_CLEANUP=true` で明示的に

> **オプション機能**: このクリーンアップは Bot 起動時に毎回実行すると、
> Redis のキー数が大きい環境では起動が遅くなる可能性がある。
> 配布版では環境変数で有効/無効を切り替えられるようにすることを推奨。

```typescript
// 環境変数で有効化（★ デフォルト: false）
const ENABLE_ORPHAN_CLEANUP = process.env.ENABLE_ORPHAN_CLEANUP === 'true';

async function cleanupOrphanedConfigs(client: Client, redis: Redis): Promise<void> {
  if (!ENABLE_ORPHAN_CLEANUP) {
    console.log('[Cleanup] Orphan cleanup is disabled');
    return;
  }
  
  const startTime = Date.now();
  const joinedGuildIds = new Set(client.guilds.cache.keys());
  let cursor = '0';
  let cleanedCount = 0;
  
  do {
    // SCAN でキーを段階的に取得（Redis をブロックしない）
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'app:guild:*:joined', 'COUNT', 100);
    cursor = nextCursor;
    
    for (const key of keys) {
      const guildId = key.split(':')[2]; // app:guild:{id}:joined
      if (!joinedGuildIds.has(guildId)) {
        // joined キーと関連キーを削除
        await redis.del(`app:guild:${guildId}:joined`);
        await redis.del(`app:guild:${guildId}:config`);
        await redis.del(`app:guild:${guildId}:channels`);
        cleanedCount++;
      }
    }
  } while (cursor !== '0');
  
  const elapsed = Date.now() - startTime;
  console.log(`[Cleanup] Removed ${cleanedCount} orphaned guilds in ${elapsed}ms`);
}
```

---

## 6. API 設計

> **詳細な実装例は [DASHBOARD_API_IMPLEMENTATION.md](DASHBOARD_API_IMPLEMENTATION.md) を参照してください。**

### 6.1 共通仕様

#### レスポンスヘッダー

全ての API エンドポイントで以下のヘッダーを返す：
- `Content-Type: application/json`
- `Cache-Control: no-store, no-cache, must-revalidate` ★ P1: 全APIでキャッシュ禁止
- `X-Content-Type-Options: nosniff`

#### GET の副作用禁止（P0）

`GET /api/guilds/{guildId}/config` は設定の取得のみを行う。設定が存在しない場合は 404 を返す。
初期化は `POST /api/guilds/{guildId}/config:initialize` で明示的に行う。

#### エラーレスポンス形式

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "whitelist must not be empty when allowAllChannels is false"
  }
}
```

#### 共通エラーコード

| HTTP | コード | 説明 |
|------|--------|------|
| 400 | `VALIDATION_ERROR` | リクエストの検証エラー |
| 401 | `UNAUTHORIZED` | 未認証 |
| 403 | `FORBIDDEN` | 権限なし |
| 404 | `NOT_FOUND` | リソースが見つからない |
| 404 | `BOT_NOT_JOINED_OR_OFFLINE` | Bot 未参加 or オフライン（復旧可能性あり） |
| 409 | `CONFLICT` | 競合（楽観的ロック失敗） |
| 429 | `RATE_LIMITED` | レート制限超過 |
| 503 | `SERVICE_UNAVAILABLE` | Redis 障害など一時的なエラー |

> **★ 矛盾解消: BOT_NOT_JOINED_OR_OFFLINE の HTTP ステータス**
>
> 「Not Found」なのに「一時的に復旧する可能性がある」というのは API 設計的に濁っている。
>
> **検討オプション**:
>
> | オプション | HTTP | 理由 |
> |------------|------|------|
> | 現行維持（404） | 404 | 「リソースが見つからない」という意味で正しい。ただし復旧可能性をエラーコードで表現 |
> | 503 に変更 | 503 | Bot の状態が原因なら「Service Unavailable」のほうが自然。フロントのリトライ判定がシンプルに |
>
> **採用: 現行維持（404）ただし以下を MUST とする**:
>
> 1. レスポンスヘッダーに `Cache-Control: no-store` を強制（CDN・ブラウザキャッシュ防止）
> 2. エラーレスポンスに `recoverable: true` フィールドを追加
> 3. フロントは `error.code` で分岐し、リトライ導線を表示
>
> ```typescript
> // ★ 矛盾解消: recoverable フラグを追加
> throw new NotFoundError({
>   code: 'BOT_NOT_JOINED_OR_OFFLINE',
>   message: 'Bot がこのギルドに参加していないか、Bot がオフラインの可能性があります',
>   recoverable: true,  // ★ 追加: フロントでのリトライ判定に使用
>   hint: 'Bot が起動しているか確認してください。起動直後の場合は数秒お待ちください。'
> });
> ```
>
> **代替案（503 を使う場合）**:
>
> 将来的に「Bot の状態に依存するエラーは全て 503」と統一する場合は、
> 以下のマイグレーションパスを検討：
>
> 1. v2 API で 503 に変更
> 2. v1 API は後方互換のため 404 を維持
> 3. フロントは `response.status === 404 || response.status === 503` で分岐

> **★ P0対応: 404 エラー（BOT_NOT_JOINED_OR_OFFLINE）のフロントエンド処理**
>
> `BOT_NOT_JOINED_OR_OFFLINE` は一般的な 404（存在しない）とは異なり、
> **復旧する可能性のあるエラー** である（Bot 再起動、ネットワーク復旧等）。
>
> **フロントエンドでの必須対応（MUST）**:
>
> 1. **エラーコードで分岐する**（HTTP ステータスだけで判断しない）
>    ```typescript
>    if (response.status === 404) {
>      // ★ P1対応: content-type を確認してから JSON パース
>      // SSR ルーティングミスや nginx エラーページで HTML が返る場合がある
>      const contentType = response.headers.get('content-type') || '';
>      if (!contentType.includes('application/json')) {
>        // JSON ではない 404（SSR ルーティングエラー等）
>        showGenericNotFoundError();
>        return;
>      }
>      
>      const data = await response.json();
>      if (data.error?.code === 'BOT_NOT_JOINED_OR_OFFLINE') {
>        // ★ 復旧可能性があるエラー → リトライ導線を表示
>        showRecoverableError(data.error);
>      } else {
>        // 通常の 404（リソースが存在しない）
>        showNotFoundError();
>      }
>    }
>    ```
>
> 2. **リトライ導線を表示する（MUST）**
>    ```tsx
>    function BotOfflineError({ hint }: { hint?: string }) {
>      const [retrying, setRetrying] = useState(false);
>      
>      const handleRetry = async () => {
>        setRetrying(true);
>        // 数秒待ってからリトライ
>        await new Promise(r => setTimeout(r, 3000));
>        window.location.reload();
>      };
>      
>      return (
>        <div className="error-banner recoverable">
>          <p>Bot がこのサーバーに参加していないか、オフラインの可能性があります。</p>
>          {/* ★ P0対応: Bot 起動直後の問い合わせ削減のための文言 */}
>          <p className="startup-notice">
>            ⏳ Bot 起動直後の場合、数秒後に再試行してください。
>          </p>
>          {hint && <p className="hint">{hint}</p>}
>          <button onClick={handleRetry} disabled={retrying}>
>            {retrying ? '確認中...' : '🔄 数秒後に再試行'}
>          </button>
>        </div>
>      );
>    }
>    ```
>
>    > **★ P0対応: Bot 起動直後の race condition について**
>    >
>    > Bot 起動直後に以下の順序で発生する可能性がある：
>    > 1. Bot 起動開始
>    > 2. `joined` キー未作成（ready イベント前）
>    > 3. Dashboard GET → 404 (`BOT_NOT_JOINED_OR_OFFLINE`)
>    > 4. 数秒後に ready イベント発火 → `joined` 作成
>    >
>    > これは正常な動作であり、UX 的には問題ないが、
>    > **UI 文言で「起動直後は数秒待つ」ことを伝える**ことで問い合わせを削減する。
>
> 3. **キャッシュしない**
>    - この 404 を CDN やブラウザキャッシュに保存すると、復旧後もエラーが表示され続ける
>    - レスポンスヘッダーに `Cache-Control: no-store` を付与すること

#### レート制限

| エンドポイント | 制限 | 単位 |
|---------------|------|------|
| `PUT /api/guilds/{guildId}/config` | 10回 | 1分 / ユーザー |
| `GET /api/guilds` | 30回 | 1分 / ユーザー |
| `POST /api/auth/*` | 5回 | 1分 / IP |

> **実装方式の詳細は [DASHBOARD_API_IMPLEMENTATION.md](DASHBOARD_API_IMPLEMENTATION.md#レート制限) を参照**
>
> **レート制限の基本方針**
>
> レート制限は **アプリケーション内 + nginx の二段構え** で実装する。
>
> **1. アプリケーション内（必須）**:
> - セッション ID からユーザーを識別
> - Redis を使用したスライディングウィンドウ方式
> - 認証済みエンドポイントはユーザー単位、未認証は IP 単位
>
> **★ P0対応: Lua スクリプトで原子的に実行**
>
> 従来の実装（`zremrangebyscore` → `zcard` → `zadd` を別コマンドで実行）は、
> 同時リクエストですり抜ける競合状態が発生する。
> ログイン周りは攻撃が来る場所なので、Lua スクリプトで原子的に処理する。
>
> ```lua
> // ★ P0対応: Lua スクリプトによる原子的なレート制限
> // KEYS[1] = レート制限キー
> // ARGV[1] = 現在時刻（ミリ秒）
> // ARGV[2] = ウィンドウ開始時刻（ミリ秒）
> // ARGV[3] = 制限回数
> // ARGV[4] = ウィンドウ秒数
> // ARGV[5] = ユニークメンバー（${now}-${uuid}）
> const RATE_LIMIT_SCRIPT = `
>   local key = KEYS[1]
>   local now = tonumber(ARGV[1])
>   local windowStart = tonumber(ARGV[2])
>   local limit = tonumber(ARGV[3])
>   local windowSeconds = tonumber(ARGV[4])
>   local member = ARGV[5]
>   
>   -- 古いエントリを削除
>   redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)
>   
>   -- 現在のカウント
>   local count = redis.call('ZCARD', key)
>   
>   -- ★ P1対応: resetAt の計算を統一（最古エントリのスコア + window）
>   local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
>   local resetAt = now + (windowSeconds * 1000)
>   if #oldest >= 2 then
>     resetAt = tonumber(oldest[2]) + (windowSeconds * 1000)
>   end
>   
>   if count >= limit then
>     -- 制限超過
>     return { 0, 0, resetAt }  -- allowed=false
>   end
>   
>   -- リクエストを記録
>   redis.call('ZADD', key, now, member)
>   redis.call('EXPIRE', key, windowSeconds)
>   
>   -- ★ P1対応: allowed 時も resetAt を統一して返す
>   -- これにより X-RateLimit-Reset ヘッダーの信用が向上
>   return { 1, limit - count - 1, resetAt }  -- allowed=true
> `;
> ```
> ```typescript
> import { randomUUID } from 'crypto';
> 
> // Redis を使用したレート制限（Lua スクリプトで原子的に実行）
> async function checkRateLimit(
>   key: string,  // 例: 'ratelimit:user:{userId}:PUT:/api/guilds'
>   limit: number,
>   windowSeconds: number
> ): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
>   const now = Date.now();
>   const windowStart = now - (windowSeconds * 1000);
>   const member = `${now}-${randomUUID()}`;
>   
>   // ★ Lua スクリプトで原子的に実行（競合状態を防止）
>   const result = await redis.eval(
>     RATE_LIMIT_SCRIPT,
>     1,           // KEYS の数
>     key,         // KEYS[1]
>     now,         // ARGV[1]
>     windowStart, // ARGV[2]
>     limit,       // ARGV[3]
>     windowSeconds, // ARGV[4]
>     member       // ARGV[5]
>   ) as [number, number, number];
>   
>   const [allowed, remaining, resetAt] = result;
>   return { allowed: allowed === 1, remaining, resetAt };
> }
> ```
>
> **従来の問題点**:
> ```typescript
> // ★ この実装は競合に弱い（同時リクエストですり抜ける）
> await redis.zremrangebyscore(key, '-inf', windowStart);  // 1. 削除
> const count = await redis.zcard(key);                     // 2. カウント
> // ↑ この間に他のリクエストが来ると、両方とも count < limit と判定される
> await redis.zadd(key, now, member);                       // 3. 追加
> ```
>
> **★ P1対応: 認証済み/未認証でレート制限方式を分離**
>
> Lua スクリプトは精密だが、キーの肥大とコストが読みにくい。
> 運用を楽にするため、認証状態によって方式を分離する。
>
> | 認証状態 | 方式 | 理由 |
> |----------|------|------|
> | 未認証（IP単位） | Fixed Window + INCR | シンプルで十分。攻撃時のキー肥大も予測可能 |
> | 認証済み（ユーザー単位） | ZSET + Lua | 精密なスライディングウィンドウが必要な場合に使用 |
>
> **未認証向け: Fixed Window + INCR（推奨）**
>
> ```typescript
> // Fixed Window（シンプル版）- 未認証エンドポイント向け
> async function checkRateLimitFixedWindow(
>   key: string,  // 例: 'ratelimit:ip:{ip}:auth'
>   limit: number,
>   windowSeconds: number
> ): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
>   const now = Date.now();
>   const windowKey = `${key}:${Math.floor(now / (windowSeconds * 1000))}`;
>   
>   // INCR は原子的なのでレースコンディションなし
>   const count = await redis.incr(windowKey);
>   if (count === 1) {
>     await redis.expire(windowKey, windowSeconds);
>   }
>   
>   const allowed = count <= limit;
>   const resetAt = (Math.floor(now / (windowSeconds * 1000)) + 1) * windowSeconds * 1000;
>   
>   return { allowed, remaining: Math.max(0, limit - count), resetAt };
> }
> ```
>
> **認証済み向け: ZSET + Lua（厳密版）**
>
> ログイン後の設定変更など、精密なレート制限が必要な場合は既存の Lua スクリプトを使用。
>
> **メリット**:
> - 未認証は攻撃を受けてもキー数が予測可能（IP × window 単位）
> - 認証済みは UUID を member にしてもキー肥大が限定的（ユーザー数に比例）
> - 実装・運用がシンプルになる
>
> **2. nginx（推奨・追加防御）**:
> - IP 単位のグローバル制限
> - DDoS 対策の第一防衛線
> - アプリケーションに到達する前にブロック
>
> ```nginx
> # nginx.conf
> limit_req_zone $binary_remote_addr zone=dashboard_limit:10m rate=30r/m;
> limit_req zone=dashboard_limit burst=10 nodelay;
> ```
>
> **ユーザー識別方法**:
> - 認証済み: セッション Cookie から sessionId を取得 → lucia-auth で userId を取得
> - 未認証（`/api/auth/*`）: `X-Forwarded-For` または `X-Real-IP` ヘッダー（nginx 経由）
>
> **レスポンスヘッダー**:
> ```
> X-RateLimit-Limit: 10
> X-RateLimit-Remaining: 7
> X-RateLimit-Reset: 1736553600
> ```

### 6.2 認証エンドポイント

#### Discord OAuth2 ログイン開始

```
GET /api/auth/discord/login
```

**処理**:
1. `state` を生成し、Redis に保存（TTL: 10分）
2. Discord OAuth2 認可画面へリダイレクト

**Response**: Discord OAuth2 認可画面へリダイレクト

**スコープ**: `identify`, `guilds`

#### OAuth2 コールバック

```
GET /api/auth/discord/callback?code={code}&state={state}
```

**処理**:
1. `state` を Redis から取得・検証（不一致なら 400）
2. Discord API でトークン取得
3. ユーザー情報 & ギルド一覧取得
4. lucia-auth でセッション作成（Redis に保存）
5. CSRF トークン生成・保存
6. セッション Cookie 設定

**Response**: ダッシュボードへリダイレクト + セッション Cookie 設定

#### ログアウト

```
POST /api/auth/logout
```

**Headers**:
- `X-CSRF-Token: {csrfToken}` (必須)

**Response**: セッション削除 + ログインページへリダイレクト

### 6.3 ギルド設定エンドポイント

#### ギルド一覧取得

```
GET /api/guilds
```

**認可**: 要ログイン

**Response**:
```json
{
  "guilds": [
    {
      "id": "123456789",
      "name": "My Server",
      "icon": "abc123",
      "hasManagePermission": true,
      "botJoined": true
    }
  ]
}
```

**`botJoined` の判定方法**:
- Dashboard は Bot トークンを持たない（セキュリティ上の理由）
- **Redis の `app:guild:{guildId}:joined` キーの存在で判定**（TTL なし）
- Bot が `guildCreate` イベントでキーを作成、`guildDelete` イベントで削除
- SQLite は Dashboard のみが操作し、Bot は Redis のみを使用

#### ギルド設定取得

```
GET /api/guilds/{guildId}/config
```

**認可**: 要ログイン + `MANAGE_GUILD` 権限

**Response Headers**:
- `ETag: "3"` (現在の version)
- `Cache-Control: no-store` (SSR ページはキャッシュしない)

**Response Body**:
```json
{
  "guildId": "123456789",
  "allowAllChannels": false,
  "whitelist": ["111111111", "222222222"],
  "version": 3,
  "availableChannels": [
    { "id": "111111111", "name": "general", "type": 0 },
    { "id": "222222222", "name": "bot-commands", "type": 0 }
  ]
}
```

**設計のポイント**:
- `botJoined` を先に確認（DB を汚す前に判定）
- 設定が存在しない場合はデフォルト作成（P1: `INSERT OR IGNORE` で冪等化）
- チャンネル一覧は Bot が Redis にキャッシュしたものを取得（TTL: 1時間）
- ★ P0: channels キャッシュは全件保存（上限撤廃）、UI はクライアントサイド検索

> **詳細な実装例は [DASHBOARD_API_IMPLEMENTATION.md](DASHBOARD_API_IMPLEMENTATION.md#ギルド設定取得) を参照**

#### ギルド設定更新

```
PUT /api/guilds/{guildId}/config
```

**認可**: 要ログイン + `MANAGE_GUILD` 権限

**Headers**:
- `X-CSRF-Token: {csrfToken}` (必須)
- `If-Match: "{version}"` (楽観的ロック、ETag 形式)

**Request Body**:
```json
{
  "allowAllChannels": false,
  "whitelist": ["111111111", "222222222"]
}
```

**バリデーション**:
- `allowAllChannels` が `false` の場合、`whitelist` は 1件以上必須
- `whitelist` の最大件数: 500件
- `channelId` は数字文字列のみ（Discord Snowflake 形式）

**トランザクション処理**:
1. 監査ログ記録
2. 既存 whitelist を削除
3. 新しい whitelist を挿入（100件ずつバッチ処理）
4. guild_configs を更新（★ P0: WHERE 句に version を含めて楽観ロック）
5. Redis 更新（TTL なし）
6. pub/sub で通知

**Redis 更新**:
- リトライ付きで Redis SET + PUBLISH を実行
- SET 失敗時は 503 を返す（★ P0: レスポンスに現在 version を含める）
- PUBLISH 失敗時は 200 + warning フラグ（P1対応）

> **詳細な実装例は [DASHBOARD_API_IMPLEMENTATION.md](DASHBOARD_API_IMPLEMENTATION.md#ギルド設定更新) を参照**

**エラー**:
- `409`: 競合（楽観的ロック失敗）
- `503`: Redis 障害（SQLite は更新済みの可能性あり）

---

## 7. 認証・認可・セキュリティ

> **詳細な実装例は [DASHBOARD_AUTH_IMPLEMENTATION.md](DASHBOARD_AUTH_IMPLEMENTATION.md) を参照してください。**

### 7.1 Discord OAuth2 フロー

```
1. ユーザーが /api/auth/discord/login にアクセス
2. state を生成し Redis に保存（oauth:state:{state}, TTL: 10分）
3. Discord 認可画面にリダイレクト
4. ユーザーが許可
5. /api/auth/discord/callback にコールバック
6. state を検証（Redis から取得し、一致確認後削除）
7. アクセストークンでユーザー情報 & ギルド一覧を取得
8. lucia-auth でセッション作成（Redis に保存、TTL: 7日）
9. CSRF トークン生成・保存（app:csrf:{sessionId}）
10. Dashboard へリダイレクト
```

### 7.2 セッション管理

- **保存先**: Redis（TTL: 7日）
- **Cookie 属性**: `HttpOnly`, `Secure` (NODE_ENV=production), `SameSite=Lax`
- **セッション延長**: なし（期限切れ時は再ログイン）
- **refresh_token**: 使用しない（実装複雑化を避ける）

### 7.3 CSRF 対策

- **トークン生成**: 32バイトランダム文字列（hex）
- **保存**: Redis `app:csrf:{sessionId}` (TTL: セッションと同期)
- **検証**: `timingSafeEqual` で比較（★ P0: 長さチェック・形式バリデーション先行）
- **必須ヘッダー**: `X-CSRF-Token` (POST/PUT/DELETE)

### 7.4 アクセストークン暗号化

- **暗号化方式**: AES-256-GCM
- **鍵派生**: PBKDF2 (ENCRYPTION_SALT + セッションごとの salt)
- **保存場所**: セッション内に暗号化状態で保存
- ★ P0: ENCRYPTION_SALT は必須環境変数（未設定時は起動失敗）

### 7.5 認可ロジック

- **ギルド設定変更**: `MANAGE_GUILD` 権限必須
- **権限取得**: セッション内の guilds 配列から取得（TTL: 1時間）
- **forceRefresh**: 設定保存時は Discord API で権限を再検証

---

## 8. フロントエンド設計

> **詳細な実装例は [DASHBOARD_FRONTEND_IMPLEMENTATION.md](DASHBOARD_FRONTEND_IMPLEMENTATION.md) を参照してください。**

### 8.1 ディレクトリ構成

```
dashboard/
├── astro.config.mjs
├── package.json
├── src/
│   ├── pages/               # Astro ページ（SSG/SSR）
│   ├── components/          # UI コンポーネント
│   ├── layouts/             # 共通レイアウト
│   ├── lib/                 # ライブラリ（auth, db, redis）
│   └── middleware.ts        # 認証ミドルウェア
└── data/
    └── dashboard.db         # SQLite ファイル
```

### 8.2 ページ一覧

| パス | レンダリング | 認証 | 説明 |
|------|-------------|------|------|
| `/` | SSG | 不要 | ランディングページ |
| `/login` | SSG | 不要 | ログインボタン表示 |
| `/dashboard` | SSR | 必要 | ギルド一覧表示 |
| `/dashboard/{guildId}` | SSR | 必要 + 権限 | チャンネル設定 |

### 8.3 UI コンポーネント

- **ChannelSelector** (Preact Island): チャンネル選択 UI、クライアントサイド検索、チャンネル ID 直接指定
- **SessionExpiryWarning** (Preact Island): セッション期限警告（24時間以内）
- **ErrorBanner**: 各種エラー状態に応じたバナー表示

---

## 9. Bot 側の変更

> **詳細な実装例は [DASHBOARD_BOT_IMPLEMENTATION.md](DASHBOARD_BOT_IMPLEMENTATION.md) を参照してください。**

### 9.1 新規コンポーネント

#### IChannelConfigRepository インターフェース

```typescript
export type ConfigResult =
  | { kind: 'found'; data: GuildConfigData }  // 設定が存在する
  | { kind: 'not_found' }                      // 設定が存在しない
  | { kind: 'error'; reason: string };         // Redis障害など

export interface IChannelConfigRepository {
  getConfig(guildId: string): Promise<ConfigResult>;
  subscribe(callback: (guildId: string, version: number) => void): void;
  setJoined(guildId: string): Promise<void>;
  removeJoined(guildId: string): Promise<void>;
  cacheChannels(guildId: string, channels: ChannelInfo[]): Promise<void>;
}
```

#### RedisChannelConfigRepository 実装

- **LRU キャッシュ**: 上限 1000 ギルド、インメモリ
- **revalidate 間隔**: 通常 5分、劣化モード時 30秒
- **pub/sub subscribe**: config 更新通知を受信、version 比較でキャッシュ無効化
- **劣化モード**: subscribe 切断時は 30秒間隔で Redis 確認
- ★ P0: `fetchFromRedis` で error を明示的に返す（三値化）

#### ChannelConfigService

- **isChannelAllowed**: ConfigResult.kind に応じて分岐
  - `found`: 設定に従う
  - `not_found`: `CONFIG_NOT_FOUND_FALLBACK` に従う（デフォルト: allow）
  - `error`: `REDIS_DOWN_FALLBACK` に従う（デフォルト: allow）

### 9.2 MessageHandler への統合

```typescript
// ★ 新規追加: チャンネル許可チェック
if (message.guildId) {
  const isAllowed = await this.channelConfigService.isChannelAllowed(
    message.guildId,
    message.channelId
  );
  if (!isAllowed) {
    return; // 許可されていないチャンネルでは応答しない
  }
}
```

### 9.3 ギルド参加/離脱イベント

- `guildCreate`: `joined` フラグ + channels キャッシュ（config は作らない）
- `guildDelete`: `joined` フラグ削除（★ P0: config は削除しない）
- `ready`: 全参加ギルドの `joined` + channels をキャッシュ

---

## 10. Docker 構成

> **詳細な実装例は [DASHBOARD_DEPLOYMENT.md](DASHBOARD_DEPLOYMENT.md) を参照してください。**

### 10.1 compose.yml

```yaml
services:
  twitter-rx:
    image: ghcr.io/t1nyb0x/discord-twitter-embed-rx:latest
    env_file: .env
    depends_on:
      redis:
        condition: service_healthy
    environment:
      - REDIS_URL=redis://redis:6379

  dashboard:
    image: ghcr.io/t1nyb0x/discord-twitter-embed-rx-dashboard:latest
    env_file: .env
    depends_on:
      redis:
        condition: service_healthy
    ports:
      - "127.0.0.1:4321:4321"
    environment:
      - REDIS_URL=redis://redis:6379
      - DATABASE_URL=file:/app/data/dashboard.db
      - NODE_ENV=production
    volumes:
      - dashboard_data:/app/data

  redis:
    image: redis:8.2.2-alpine
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

### 10.2 nginx 設定

- **レート制限**: `/etc/nginx/conf.d/twitterrx-ratelimit.conf` で zone 定義
- **セキュリティヘッダー**: CSP, HSTS, X-Content-Type-Options
- **HTTPS 必須**: 本番環境では必ず HTTPS を使用（Secure Cookie 有効化のため）

---

## 11. データフロー

```typescript
// Dashboard API ハンドラ
async function getGuildConfig(guildId: string, sessionData: SessionData): Promise<GuildConfig> {
  // ★ 1. まず botJoined を確認（DB を汚す前に判定）
  const joined = await redis.exists(`app:guild:${guildId}:joined`);
  if (!joined) {
    // ★ P0対応: 「未参加」と断定せず、Bot オフラインの可能性も示唆
    // Bot が起動直後で joined キーがまだ作れていない場合がある
    throw new NotFoundError({
      code: 'BOT_NOT_JOINED_OR_OFFLINE',
      message: 'Bot がこのギルドに参加していないか、Bot がオフラインの可能性があります',
      hint: 'Bot が起動しているか確認してください。起動直後の場合は数秒お待ちください。'
    }); // 404
  }

  // 2. アクセス権検証（権限チェック）
  await validateGuildAccess(guildId, sessionData);
  
  // 3. SQLite から取得
  let config = await db.query.guildConfigs.findFirst({
    where: eq(guildConfigs.guildId, guildId)
  });
  
  // 4. 存在しなければデフォルト作成（UI を開いた瞬間に設定が整う）
  // ★ 監査ログにも初回作成を記録
  if (!config) {
    config = await createDefaultConfig(guildId, sessionData.userId);
  }
  
  // 5. ホワイトリスト取得
  const whitelist = await db.query.channelWhitelist.findMany({
    where: eq(channelWhitelist.guildId, guildId)
  });
  
  // 6. チャンネル一覧（Redis から取得）
  const availableChannels = await getAvailableChannels(guildId);
  
  return {
    ...config,
    whitelist: whitelist.map(w => w.channelId),
    availableChannels,
    // ★ P0対応: デフォルト作成されたことを UI に伝える
    isDefaultConfig: config.createdAt === config.updatedAt && config.version === 1,
  };
}

// ★ P1対応: INSERT OR IGNORE で冪等化し、同時アクセス競合を防止
async function createDefaultConfig(guildId: string, userId: string): Promise<GuildConfig> {
  const now = new Date();
  const config = {
    guildId,
    allowAllChannels: true,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  
  // ★ P1対応: INSERT OR IGNORE で冪等化
  // 同時アクセスで二重作成競合が発生しても、一方は無視される
  // その後 SELECT で実際のデータを取得（競合した場合は先に作られた方を取得）
  await db.transaction(async (tx) => {
    // INSERT OR IGNORE: 既に存在する場合は何もしない
    await tx.run(sql`
      INSERT OR IGNORE INTO guild_configs (guild_id, allow_all_channels, version, created_at, updated_at)
      VALUES (${guildId}, 1, 1, ${now.toISOString()}, ${now.toISOString()})
    `);
    
    // 実際に INSERT が行われたかを確認（changes() で判定）
    const changes = await tx.get<{ changes: number }>(sql`SELECT changes() as changes`);
    
    if (changes?.changes && changes.changes > 0) {
      // ★ 新規作成された場合のみ監査ログを記録
      // INSERT OR IGNORE で無視された場合は監査ログを記録しない（冪等性を保証）
      await tx.insert(configAuditLogs).values({
        guildId,
        userId,
        action: 'create_default',
        previousConfig: JSON.stringify(null),
        newConfig: JSON.stringify({
          allowAllChannels: true,
          whitelist: [],
        }),
        createdAt: now.toISOString(),
      });
      console.log(`[Config] Created default config for guild ${guildId} by user ${userId}`);
    } else {
      console.log(`[Config] Default config already exists for guild ${guildId}, skipping creation`);
    }
  });
  
  // 実際のデータを取得（競合した場合は先に作られた方を取得）
  const actualConfig = await db.query.guildConfigs.findFirst({
    where: eq(guildConfigs.guildId, guildId)
  });
  
  // Redis にもキャッシュ（TTL なしで永続保存）
  // ★ 既に存在する場合でもキャッシュを確実に設定
  await redis.set(
    `app:guild:${guildId}:config`,
    JSON.stringify({
      guildId,
      allowAllChannels: actualConfig?.allowAllChannels ?? true,
      whitelist: [],
      version: actualConfig?.version ?? 1,
      updatedAt: actualConfig?.updatedAt ?? now.toISOString(),
    })
  );
  
  return actualConfig ?? config;
}
```

> **GET でのデフォルト作成に関する設計決定**
>
> | 観点 | 対応 |
> |------|------|
> | **順序保証** | `botJoined` を **先に** 確認。404 なら DB を触らない |
> | **冪等化** | ★ P1対応: `INSERT OR IGNORE` で同時アクセス競合を防止 |
> | **監査ログ** | 初回作成時のみ `action: 'create_default'` として記録（競合時は記録しない） |
> | **副作用の明示** | 「見るだけ」のアクセスが DB を変更することをドキュメント化 |
>
> **★ P1対応: 同時アクセス競合の防止**
>
> 複数ユーザーが同時に同じギルドの設定ページを開くと、二重作成競合が発生する可能性がある。
> SQLite の UNIQUE 制約でエラーになると UX が悪いため、`INSERT OR IGNORE` で冪等化する。
>
> ```sql
> -- 既に存在する場合は何もしない
> INSERT OR IGNORE INTO guild_configs (guild_id, ...) VALUES (?, ...);
> 
> -- 実際に INSERT されたかを確認
> SELECT changes();  -- 1 なら新規作成、0 なら既存
> ```
>
> **代替案: 明示的な初期化 API**
>
> GET の副作用が気になる場合は、以下のような明示的な API を検討：
> ```
> POST /api/guilds/{guildId}/config:initialize
> ```
> ただし、「UI を開いたら設定が整う」という UX を優先するため、現状は GET での自動作成を採用。
>
> **UI での区別表示**:
>
> 「作られた」＝管理者が意図した設定 と誤解されないように、
> UI で「未設定（デフォルト）」と「ユーザーが変更済み」を区別表示することを推奨。
>
> ```tsx
> // UI での区別表示例
> const isDefaultConfig = config.createdAt === config.updatedAt && config.version === 1;
> 
> {isDefaultConfig && (
>   <div className="info-banner info-banner-default">
>     <p>📝 この設定はデフォルト状態です。</p>
>     <p className="hint">閲覧により初期化されました。変更すると保存されます。</p>
>   </div>
> )}
> ```
>
> **★ P0対応: 監査ログへの明示**
>
> GET でのデフォルト作成は監査ログに `action: 'create_default'` として記録される。
> これにより「誰が"設定を作った"のか」という監査上の曖昧さを解消する。
> - `create_default`: 閲覧により自動初期化された
> - `update`: 管理者が明示的に設定を変更した
>
> これにより「DB作ってから404」という事故を防ぎ、監査ログの意味も保たれる。

**`availableChannels` の取得方法**:
- Dashboard は Bot トークンを持たないため、Discord API から直接チャンネル一覧を取得できない
- **Bot が Redis の `app:guild:{guildId}:channels` にチャンネル一覧をキャッシュ**（TTL: 1時間）
- Dashboard は Redis からキャッシュを読み取って返す
- キャッシュがない場合は空配列を返し、UI で「Bot がチャンネル情報を取得中です」と表示

> **★ P1対応: チャンネル取得責務の整理**
>
> チャンネル一覧の取得/更新経路が複数あり仕様が肥大化していたため、以下に整理する。
>
> **Bot 側の channels キャッシュ更新トリガー（必須の3つ）**:
>
> | トリガー | タイミング | 説明 |
> |----------|------------|------|
> | `ready` | Bot 起動時 | 全参加ギルドの channels をキャッシュ |
> | `guildCreate` | ギルド参加時 | 新規参加ギルドの channels をキャッシュ |
> | `channels:refresh` | Dashboard からのリクエスト | refresh キーが存在すれば再取得 |
>
> **オプショナル（任意実装）**:
>
> | トリガー | タイミング | 説明 | 注意事項 |
> |----------|------------|------|----------|
> | `channelCreate/Update/Delete` | チャンネル変更時 | debounce 付きで更新 | rate limit 注意 |
> | message 受信時低頻度チェック | メッセージ受信時 | 5分以上経過で checkAndRefreshChannels | ギルド数に比例して負荷増 |
>
> **設計方針**:
> - 必須の3経路で十分な鮮度を確保できる（ready + guildCreate + refresh 要求）
> - `message 時低頻度チェック` はオプショナル。ギルド数が多い環境では負荷に注意が必要
> - 配布版では「動けば勝ち」なので、経路は少ないほうが良い

> **チャンネル一覧の再取得リクエスト機能**
>
> 単方向設計を維持しつつ、Dashboard から Bot へ「再取得してほしい」という意思表示を可能にする。
>
> **仕組み**:
> 1. Dashboard が `app:guild:{guildId}:channels:refresh` キーをセット（TTL: 60秒）
> 2. Bot はメッセージ処理のついで、または定期的にこのキーをチェック
> 3. キーが存在すれば `guild.channels.fetch()` を実行してキャッシュ更新
> 4. 更新完了後、refresh キーを削除
>
> **★ P0対応: Bot 側の channels:refresh チェック導線の強化**
>
> 「メッセージ受信ついでだけ」だと、非アクティブなギルドでは永遠に更新されない。
>
> **対策（MUST）**:
> 1. **ready 後の全ギルド初期キャッシュ**（既存）
> 2. **定期チェック（10分ごと）で refresh キーを確認**（新規追加）
>
> ```typescript
> // Bot 起動時: 定期的に refresh キーをチェック
> const REFRESH_CHECK_INTERVAL = 10 * 60 * 1000; // 10分
>
> setInterval(async () => {
>   for (const [guildId, guild] of client.guilds.cache) {
>     try {
>       await checkAndRefreshChannels(guild);
>     } catch (err) {
>       console.error(`[Channels] Failed to check refresh for ${guildId}:`, err);
>     }
>   }
> }, REFRESH_CHECK_INTERVAL);
> ```
>
> これにより、非アクティブなギルドでも Dashboard から「再取得」を押せば最大 10分以内に更新される。
>
> ```typescript
> // Dashboard 側: 再取得リクエスト
> async function requestChannelRefresh(guildId: string): Promise<void> {
>   await redis.setex(`app:guild:${guildId}:channels:refresh`, 60, '1');
> }
>
> // Bot 側: 定期チェック（10分ごと）または getConfig 時に確認
> async function checkAndRefreshChannels(guild: Guild): Promise<void> {
>   const shouldRefresh = await redis.get(`app:guild:${guild.id}:channels:refresh`);
>   if (shouldRefresh) {
>     await cacheGuildChannelsImmediate(guild);
>     await redis.del(`app:guild:${guild.id}:channels:refresh`);
>     console.log(`[Guild] Refreshed channels for ${guild.id} by request`);
>   }
> }
> ```
>
> **★ P0対応: 再取得ボタンを UI に標準搭載（MUST）**
>
> Discord 側の権限/インテント/一時的な API 失敗で空配列になった時、
> Dashboard は「取得中」と言い続けるだけになりがち。
>
> **対策（配布版では必須）**: UI に「再取得ボタン」を標準搭載し、詰まった時に人間が押せるようにする。
>
> ```tsx
> // Dashboard UI: 再取得ボタン（MUST）
> const [refreshing, setRefreshing] = useState(false);
> 
> const handleRefreshChannels = async () => {
>   setRefreshing(true);
>   try {
>     await fetch(`/api/guilds/${guildId}/channels/refresh`, { method: 'POST' });
>     // 3秒待ってから再取得
>     await new Promise(resolve => setTimeout(resolve, 3000));
>     const newChannels = await fetchChannels(guildId);
>     setChannels(newChannels);
>   } finally {
>     setRefreshing(false);
>   }
> };
> 
> {channels.length === 0 && (
>   <div className="no-channels-warning">
>     <p>Bot がチャンネル情報を取得中です。</p>
>     <button 
>       onClick={handleRefreshChannels}
>       disabled={refreshing}
>       className="btn-refresh"
>     >
>       {refreshing ? '取得中...' : '🔄 チャンネル一覧を再取得'}
>     </button>
>     <p className="hint">
>       ※ この状態が続く場合、Bot がオフラインの可能性があります。
>     </p>
>   </div>
> )}
> ```
>
> **★ P1対応: Bot 側でメッセージ受信時に低頻度で channels をリフレッシュ**
>
> channels キャッシュが空/古い場合、メッセージ受信時に `checkAndRefreshChannels` を走らせる。
> 完全定期よりも実用的で、アクティブなギルドでは自然に最新化される。
>
> ```typescript
> // Bot 側: MessageHandler 内で低頻度チェック
> // 最後のチェックから 5分以上経過している場合のみ実行
> const lastChannelCheck: Map<string, number> = new Map();
> const CHANNEL_CHECK_INTERVAL = 5 * 60 * 1000; // 5分
> 
> async function maybeRefreshChannels(guild: Guild): Promise<void> {
>   const lastCheck = lastChannelCheck.get(guild.id) ?? 0;
>   if (Date.now() - lastCheck < CHANNEL_CHECK_INTERVAL) return;
>   
>   lastChannelCheck.set(guild.id, Date.now());
>   await checkAndRefreshChannels(guild);
> }
> ```
>
> **キーパターン追加**:
> | キーパターン | 型 | TTL | 用途 |
> |-------------|------|-----|------|
> | `app:guild:{guildId}:channels:refresh` | String (`1`) | 60秒 | チャンネル再取得リクエスト |

**チャンネル数の制限**:
- ~~`availableChannels` は最大 100 件まで返す~~ → **★ P0対応: 上限撤廃（全件キャッシュ）**
- テキストチャンネル（type: 0）のみ対象
- カテゴリ・ボイスチャンネルは除外

> **★ P0対応: availableChannels 100件 vs whitelist 500件の整合性**
>
> UI が 100件しか見せないのに、API は 500件まで保存できる。
> この不整合で「隠れているチャンネルに設定できない」と**確実に苦情が来る**。
>
> **対策（P0 必須）**:
>
> 1. **Bot 側の channels キャッシュを全件保存（上限撤廃）**
>    - Redis 容量は増えるが、ギルド単位なら現実的（文字列 JSON）
>    - 平均的なギルドで 50〜100 チャンネル程度、大規模でも 500 程度
>
> ```typescript
> // Bot 側: 100件制限を撤廃し、全件キャッシュ
> async function cacheGuildChannelsImmediate(guild: Guild): Promise<void> {
>   try {
>     const channels = await guild.channels.fetch();
>     
>     // ★ P0対応: 100件制限を撤廃
>     const textChannels = channels
>       .filter(ch => ch !== null && ch.type === ChannelType.GuildText)
>       .map(ch => ({ id: ch!.id, name: ch!.name, type: ch!.type }));
>     
>     await redis.setex(
>       `app:guild:${guild.id}:channels`,
>       CHANNELS_CACHE_TTL,
>       JSON.stringify(Array.from(textChannels.values()))
>     );
>     
>     console.log(`[Guild] Cached ${textChannels.length} channels for ${guild.id}`);
>   } catch (err) {
>     console.error(`[Guild] Failed to cache channels for ${guild.id}:`, err);
>   }
> }
> ```
>
> 2. **Dashboard 側でクライアントサイド検索を実装（P0 必須）**
>    - Redis から全件取得し、JavaScript でフィルタリング
>    - 仮想スクロールは不要（500件程度なら DOM でも問題なし）
>
> ```tsx
> // Dashboard: クライアントサイド検索（P0 必須）
> const [searchQuery, setSearchQuery] = useState('');
> const filteredChannels = channels.filter(ch => 
>   ch.name.toLowerCase().includes(searchQuery.toLowerCase())
> );
> 
> return (
>   <div className="channel-selector">
>     <input
>       type="text"
>       placeholder="チャンネルを検索..."
>       value={searchQuery}
>       onChange={(e) => setSearchQuery(e.target.value)}
>       className="channel-search"
>     />
>     <div className="channel-list">
>       {filteredChannels.map(channel => (
>         <label key={channel.id} className="channel-item">
>           <input
>             type="checkbox"
>             checked={whitelist.has(channel.id)}
>             onChange={() => toggleChannel(channel.id)}
>           />
>           # {channel.name}
>         </label>
>       ))}
>     </div>
>   </div>
> );
> ```
>
> 3. **チャンネル ID 直接指定のエスケープハッチ（P0 必須）**
>    - 検索でも見つからない場合の救済措置
>
> ```tsx
> // チャンネル ID 直接入力フィールド
> const [directChannelId, setDirectChannelId] = useState('');
> 
> const handleAddDirectChannel = () => {
>   if (/^\d{17,19}$/.test(directChannelId)) {
>     setWhitelist(new Set([...whitelist, directChannelId]));
>     setDirectChannelId('');
>   } else {
>     setError('チャンネル ID は 17〜19 桁の数字です');
>   }
> };
> 
> <div className="direct-add">
>   <input
>     type="text"
>     placeholder="チャンネル ID を直接入力"
>     value={directChannelId}
>     onChange={(e) => setDirectChannelId(e.target.value)}
>   />
>   <button onClick={handleAddDirectChannel}>追加</button>
> </div>
> ```
>
> **マイルストーンへの追加**: Phase 3 に以下を追加
> - [ ] **P0: Bot 側 channels キャッシュの 100件制限撤廃**
> - [ ] **P0: Dashboard クライアントサイド検索実装**
> - [ ] **P0: チャンネル ID 直接指定エスケープハッチ**

**エラー**:
- `404`: ギルドが見つからない or Bot 未参加（`app:guild:{guildId}:joined` が存在しない）
- `403`: `MANAGE_GUILD` 権限なし

#### ギルド設定更新

```
PUT /api/guilds/{guildId}/config
```

**認可**: 要ログイン + `MANAGE_GUILD` 権限

**Headers**:
- `X-CSRF-Token: {csrfToken}` (必須)
- `If-Match: "{version}"` (楽観的ロック、ETag 形式)

> **Note**: GET レスポンスで `ETag: "3"` を返し、PUT で `If-Match: "3"` を要求する。
> version が一致しない場合は `409 Conflict` を返す。
>
> **★ P1対応: If-Match 形式の厳格化**
>
> プロキシや fetch 実装によっては弱い ETag（`W/"3"`）や複数 ETag の扱いが混ざることがある。
>
> **許可する形式**:
> - `If-Match: "3"` — 正確に `"${version}"` 形式のみ許可
>
> **拒否する形式（400 Bad Request）**:
> - `If-Match: 3` — 引用符なし
> - `If-Match: W/"3"` — 弱い ETag
> - `If-Match: "3", "4"` — 複数 ETag
> - `If-Match: *` — ワイルドカード
>
> **実装例**:
> ```typescript
> function parseIfMatch(header: string | null): number | null {
>   if (!header) return null;
>   
>   // 厳密に `"${number}"` 形式のみ許可
>   const match = header.match(/^"(\d+)"$/);
>   if (!match) {
>     throw new BadRequestError({
>       code: 'INVALID_IF_MATCH',
>       message: 'If-Match ヘッダーは "version" 形式（例: "3"）で指定してください',
>     });
>   }
>   
>   return parseInt(match[1], 10);
> }
> ```
>
> **Note**: HTTP 的には version を JSON ボディに含める設計も選択肢だが、
> 楽観的ロックは HTTP 標準の ETag/If-Match で表現するのが正攻法なため、現行設計を維持。

**Request Body**:
```json
{
  "allowAllChannels": false,
  "whitelist": ["111111111", "222222222"]
}
```

**バリデーション**:
- `allowAllChannels` が `false` の場合、`whitelist` は 1件以上必須
- `whitelist` の最大件数: 500件（※ 一般的なギルドのテキストチャンネル数は 50〜100 件程度。500件あれば大規模ギルドでも十分対応可能。将来、実測データに基づき調整を検討）
- `channelId` は数字文字列のみ（Discord Snowflake 形式）
- `allowAllChannels` が `true` の場合、`whitelist` は無視（保存されない）

> **設計判断: `allowAllChannels=true` 時の whitelist 保存**
> 
> | 方針 | メリット | デメリット |
> |------|----------|------------|
> | 保存しない（空にする） | データ一貫性が高い、素直な設計 | 「前の選択を復元」できない |
> | 保存する（そのまま残す） | OFF→ON→OFF で前の選択が復元可能 | 「全選択なのに whitelist がある」状態が発生 |
> 
> **採用**: 保存しない方式。データ一貫性を優先し、UX はシンプルに保つ。
> 復元機能が必要になった場合は、将来的に「テンプレート保存」機能として実装を検討する。

**処理フロー（トランザクション）**:

> **バルク INSERT の分割について**
>
> Drizzle ORM でバルク INSERT する際、プレースホルダ数やSQLサイズ制限に当たる可能性がある。
> 安全のため、100件ずつ分割して INSERT する。
>
> ```typescript
> // whitelist を 100 件ずつ分割して INSERT
> const BATCH_SIZE = 100;
> for (let i = 0; i < whitelist.length; i += BATCH_SIZE) {
>   const batch = whitelist.slice(i, i + BATCH_SIZE);
>   await tx.insert(channelWhitelist).values(
>     batch.map(channelId => ({ guildId, channelId }))
>   );
> }
> ```

```sql
BEGIN TRANSACTION;

-- ★ P0対応: 楽観ロックは UPDATE の WHERE 句で version を検証
-- SELECT で version 確認 → その後 UPDATE は競合に弱い（同時実行で両方通過しうる）
-- UPDATE の affected rows で判定することで、確実に競合を検出する

-- 1. 現在の設定を取得（監査ログ用の previousConfig 取得）
SELECT * FROM guild_configs WHERE guild_id = ?;

-- 2. 監査ログ記録
INSERT INTO config_audit_logs (...) VALUES (...);

-- 3. 既存 whitelist を削除
DELETE FROM channel_whitelist WHERE guild_id = ?;

-- 4. 新しい whitelist を挿入（100件ずつバッチ処理）
INSERT INTO channel_whitelist (guild_id, channel_id) VALUES (?, ?), ...;

-- 5. guild_configs を更新（★ P0対応: WHERE に version を含めて競合検出）
UPDATE guild_configs 
SET allow_all_channels = ?, version = version + 1, updated_at = ?
WHERE guild_id = ? AND version = ?;
-- ↑ affected rows が 0 なら 409 CONFLICT を返す

COMMIT;
```

> **★ P0対応: 楽観ロックの正しい実装**
>
> 従来の「SELECT で version 確認 → UPDATE」は競合に弱い。
> 同一トランザクション内でも、実装によっては version 一致確認が形骸化する。
>
> **正攻法**: UPDATE の WHERE 句に version を含め、affected rows で判定。
>
> ```typescript
> // Drizzle ORM での実装例
> const result = await tx
>   .update(guildConfigs)
>   .set({
>     allowAllChannels: data.allowAllChannels,
>     version: sql`version + 1`,
>     updatedAt: now.toISOString(),
>   })
>   .where(
>     and(
>       eq(guildConfigs.guildId, guildId),
>       eq(guildConfigs.version, expectedVersion) // ★ P0対応: version を WHERE に含める
>     )
>   );
>
> // affected rows で競合検出
> if (result.changes === 0) {
>   // version が一致しなかった = 競合発生
>   throw new ConflictError({
>     code: 'CONFLICT',
>     message: '設定が他のユーザーによって更新されました。再読み込みしてください。',
>   }); // 409
> }
> ```

**Response (成功)**:
```json
{
  "success": true,
  "version": 4,
  "message": "設定を更新しました"
}
```

**Response (競合)**:
```json
{
  "error": {
    "code": "CONFLICT",
    "message": "設定が他のユーザーによって更新されました。再読み込みしてください。",
    "currentVersion": 5
  }
}
```

**Redis 更新**:

> **重要: PUT 成功条件の厳格化**
>
> Dashboard の PUT は「SQLite commit + Redis SET + PUBLISH」が全て成功してはじめて `200 OK` を返す。
> Redis が一瞬死んでいた場合に「SQLite は最新、Redis は古い」状態になると、
> Bot は永遠に古い設定で動き続ける。
>
> 「設定保存できたように見えるのに Bot が変わらない」が最もユーザーを混乱させる。
>
> **★ P1対応: 成功条件の分解と publish 失敗時の挙動明確化**
>
> | 操作 | 成功条件 | 失敗時の HTTP |
> |------|----------|--------------|
> | SQLite commit | **必須** | 500（トランザクション失敗） |
> | Redis SET | **必須** | 503（リトライ後も失敗） |
> | Redis PUBLISH | **準必須** | 200 + warning フラグ |
>
> **理由**: PUBLISH が失敗しても、revalidate で追いつく設計があるため、
> PUBLISH 失敗だけで 503 にすると UX が過剰に悪化する。
>
> **PUBLISH 失敗時のレスポンス**:
> ```json
> {
>   "success": true,
>   "version": 4,
>   "message": "設定を更新しました",
>   "warning": "リアルタイム通知に失敗しました。反映に最大5分かかる場合があります。"
> }
> ```
>
> **実装**:
> ```typescript
> // Redis SET は必須、PUBLISH は警告のみ
> let publishWarning: string | null = null;
> 
> // SET（必須）
> await redis.set(`app:guild:${guildId}:config`, JSON.stringify(config));
> 
> // PUBLISH（準必須）
> try {
>   await redis.publish('app:config:update', JSON.stringify({ guildId, version }));
> } catch (publishErr) {
>   console.warn(`[Redis] PUBLISH failed for ${guildId}:`, publishErr);
>   publishWarning = 'リアルタイム通知に失敗しました。反映に最大5分かかる場合があります。';
> }
> 
> return {
>   success: true,
>   version: newVersion,
>   message: '設定を更新しました',
>   ...(publishWarning && { warning: publishWarning }),
> };
> ```

```typescript
// トランザクション成功後、Redis 更新（リトライ付き）
async function updateRedisWithRetry(
  guildId: string,
  config: RedisConfig,
  maxRetries: number = 3
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // ★ TTL なしで永続保存
      await redis.set(`app:guild:${guildId}:config`, JSON.stringify(config));
      await redis.publish('app:config:update', JSON.stringify({ 
        guildId, 
        version: config.version 
      }));
      return; // 成功
    } catch (err) {
      console.error(`[Redis] Update failed (attempt ${attempt}/${maxRetries}):`, err);
      if (attempt === maxRetries) {
        throw err; // リトライ上限に達した
      }
      // 指数バックオフでリトライ（100ms, 200ms, 400ms）
      await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, attempt - 1)));
    }
  }
}

// PUT ハンドラ
// ★ Redis 更新が失敗したら 503 を返す（200 を返さない）
try {
  await db.transaction(async (tx) => {
    // SQLite トランザクション...
  });
  
  // ★ SQLite 成功後、Redis 更新（ここが失敗したら API 全体を失敗扱い）
  await updateRedisWithRetry(guildId, {
    guildId,
    allowAllChannels,
    whitelist,
    version: newVersion,
    updatedAt: new Date().toISOString(),
  });
  
  return { success: true, version: newVersion };
} catch (err) {
  if (err instanceof RedisError || err.message?.includes('Redis')) {
    // Redis 障害時は 503 Service Unavailable
    // ★ P0対応: 「保存自体は完了した可能性」と現在 version を返す
    // SQLite は既に commit 済みのため、UI は自動で GET し直して state を合わせる
    const currentConfig = await db.query.guildConfigs.findFirst({
      where: eq(guildConfigs.guildId, guildId)
    });
    
    return new Response(JSON.stringify({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: '設定の同期に失敗しました。保存は完了している可能性があります。',
        // ★ P0対応: 現在の version を返すことで、再試行時の 409 を防止
        currentVersion: currentConfig?.version ?? null,
        hint: 'ページを再読み込みして、現在の設定を確認してください。'
      }
    }), { status: 503 });
  }
  throw err;
}
```

> **★ P0対応: 503 時の UX 改善**
>
> SQLite commit + Redis SET + publish が全て成功するまで 200 を返さない設計は正しいが、
> Redis が一瞬死んだだけで 503 になった場合、ユーザー体験が荒れる可能性がある。
>
> **問題のシナリオ**:
> 1. ユーザーが設定を保存
> 2. SQLite は commit 成功
> 3. Redis SET が失敗 → 503 を返す
> 4. ユーザーは「保存失敗」と思い再試行
> 5. SQLite は既に更新済みで version が進んでいる → If-Match で 409 が起きやすい
> 6. 体験が「503→再試行→409→は？」になる
>
> **対策**:
> - 503 のレスポンスに **「保存自体は完了した可能性」** と **現在 version** を返す
> - UI は 503 を受け取ったら自動で GET し直して state を合わせる
>
> **UI 側の対応（推奨）**:
> ```tsx
> // 503 エラー時の UI 対応
> async function handleSaveError(response: Response, guildId: string) {
>   if (response.status === 503) {
>     const data = await response.json();
>     // ★ 503 時は自動で最新の設定を取得し直す
>     const latestConfig = await fetchConfig(guildId);
>     setVersion(latestConfig.version);
>     setWhitelist(new Set(latestConfig.whitelist));
>     setAllowAll(latestConfig.allowAllChannels);
>     
>     // ユーザーに通知（★ 結果整合モデルに対応した文言）
>     setError('保存は完了している可能性があります。最新の状態を表示しました。再読み込みして確認してください。');
>   }
> }
> ```
>
> **補足: アウトボックス方式**
>
> より堅牢にするなら「アウトボックス」方式も検討できる：
>
> 1. SQLite に `pending_redis_updates` テーブルを作成
> 2. トランザクション内で config 更新と pending レコードを同時作成
> 3. 別ワーカー（または Dashboard 起動時）が pending を処理
>
> ただし、自己ホスト配布で複雑化を嫌うなら、上記のリトライ方式で十分。

---

## 7. 認証・認可・セキュリティ

> **詳細な実装例は [DASHBOARD_AUTH_IMPLEMENTATION.md](DASHBOARD_AUTH_IMPLEMENTATION.md) を参照してください。**

### 7.1 Discord OAuth2 フロー

```
1. ユーザーが /api/auth/discord/login にアクセス
2. state を生成し Redis に保存（oauth:state:{state}, TTL: 10分）
3. Discord 認可画面にリダイレクト
4. ユーザーが許可
5. /api/auth/discord/callback にコールバック
6. state を検証（Redis から取得し、一致確認後削除）
7. アクセストークンでユーザー情報 & ギルド一覧を取得
8. lucia-auth でセッション作成（Redis に保存、TTL: 7日）
9. CSRF トークン生成・保存（app:csrf:{sessionId}）
10. Dashboard へリダイレクト
```

### 7.2 セッション管理

- **保存先**: Redis（TTL: 7日）
- **Cookie 属性**: `HttpOnly`, `Secure` (NODE_ENV=production), `SameSite=Lax`
- **セッション延長**: なし（期限切れ時は再ログイン）
- **refresh_token**: 使用しない（実装複雑化を避ける）

### 7.3 CSRF 対策

- **トークン生成**: 32バイトランダム文字列（hex）
- **保存**: Redis `app:csrf:{sessionId}` (TTL: セッションと同期)
- **検証**: `timingSafeEqual` で比較（★ P0: 長さチェック・形式バリデーション先行）
- **必須ヘッダー**: `X-CSRF-Token` (POST/PUT/DELETE)

#### CSRF トークンの発行

```typescript
// ログイン成功時
const csrfToken = crypto.randomBytes(32).toString('hex');
// ★ CSRF トークンの TTL はセッションと同期（7日）
// セッション削除時に CSRF トークンも同時に削除することを保証
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7日
await redis.setex(`app:csrf:${sessionId}`, SESSION_TTL_SECONDS, csrfToken);
// トークンはレスポンスヘッダーまたは HTML に埋め込んで返す
```

> **★ CSRF トークンのライフサイクル管理**
>
> | イベント | 対応 |
> |----------|------|
> | ログイン成功 | CSRF トークン生成、TTL はセッションと同じ 7日 |
> | セッション更新 | CSRF トークンの TTL も延長（任意、未実装でも問題なし） |
> | ログアウト | CSRF トークンを明示的に削除 |
> | セッション期限切れ | TTL によりCSRF トークンも自動削除 |
>
> ```typescript
> // ログアウト時の削除
> await lucia.invalidateSession(sessionId);
> await redis.del(`app:csrf:${sessionId}`);  // ★ 明示的に削除
> ```

#### CSRF トークンの検証

```typescript
// ★ P0対応: timingSafeEqual は長さが異なると例外を投げるため、事前チェックが必須
async function validateCsrfToken(sessionId: string, token: string | undefined): Promise<boolean> {
  // 1. token が存在しない/空の場合は即座に拒否
  if (!token || typeof token !== 'string') {
    return false;
  }
  
  // 2. token の形式バリデーション（hex 64文字 = 32バイト）
  // これにより不正な形式の token を早期に拒否
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return false;
  }
  
  // 3. Redis から保存されたトークンを取得
  const storedToken = await redis.get(`app:csrf:${sessionId}`);
  if (!storedToken) {
    return false;
  }
  
  // 4. ★ P0対応: 長さが一致しない場合は false を返す（例外を投げない）
  // timingSafeEqual は長さが異なると TypeError を投げるため
  if (storedToken.length !== token.length) {
    return false;
  }
  
  // 5. タイミング攻撃を防ぐ定時間比較
  return crypto.timingSafeEqual(
    Buffer.from(storedToken, 'utf8'),
    Buffer.from(token, 'utf8')
  );
}
```

> **★ P0対応: CSRF 検証の堅牢化**
>
> `timingSafeEqual` は入力バッファの長さが異なると `TypeError` を投げる。
> これにより、以下のケースで 500 エラーが発生する危険があった：
>
> - storedToken が存在しない/壊れている
> - ヘッダーの token が短い/欠けている
>
> **対策**:
> 1. token の存在・型チェック
> 2. hex 形式のバリデーション
> 3. 長さチェックを timingSafeEqual の前に実行

### 7.4 権限チェックとトークン管理

**要点**:
- 権限チェック: Discord の `MANAGE_GUILD` (0x20) 権限が必須
- トークン暗号化: AES-256-GCM で `accessToken` を暗号化保存
- セッション構造: `encryptedAccessToken`, `expiresAt` をRedis に保存
- 401 時の処理: セッション破棄 + 関連キャッシュ削除 + UI で再ログイン促進

**エラーコード設計**:

| 状況 | HTTP | コード | 理由 |
|------|------|--------|------|
| 未ログイン / セッション切れ | 401 | `UNAUTHORIZED` | 認証が必要 |
| ギルドが見つからない / 権限なし | 403 | `FORBIDDEN` | アクセス権限がない |
| Bot 未参加 | 404 | `NOT_FOUND` | リソースが存在しない（Bot がいない = 設定対象がない） |

**セキュリティ考慮**:
- `ENCRYPTION_SALT` は環境変数で必須指定（起動時チェックあり）
- GCM モードの IV は 12 bytes（NIST 推奨）
- `SESSION_SECRET` 変更時は既存セッションを全破棄（鍵ローテーションに対応）
- `validateGuildAccess` に `forceRefresh` オプション（PUT時は必須、権限再検証）

**UX 考慮（P0: 配布版では必須）**:
- 401 時は「セッションが切れました」バナー + 再ログインボタンを明確表示
- セッション有効期限を UI に表示（残り24時間で警告）
- refresh_token は使用しない（実装複雑化を避ける）

詳細な実装例は [DASHBOARD_AUTH_IMPLEMENTATION.md](DASHBOARD_AUTH_IMPLEMENTATION.md) を参照してください。

### 7.5 botJoined の判定方式

**設計方針**: Dashboard は Bot トークンを持たない（配布時のセキュリティリスク軽減）

**判定方法**:
1. Bot が `guildCreate` イベントで Redis に `app:guild:{guildId}:joined` キーを作成（TTL なし）
2. Bot が `guildDelete` イベントでキーを削除
3. Dashboard は `app:guild:{guildId}:joined` の存在で判定

**重要**:
- Bot 離脱時に `config` は削除しない（再参加時の「全許可」復帰を防止）
- 孤立した config は日次クリーンアップで削除（環境変数 `ORPHAN_CONFIG_RETENTION_DAYS` で設定、デフォルト30日）

詳細な実装例は [DASHBOARD_BOT_IMPLEMENTATION.md](DASHBOARD_BOT_IMPLEMENTATION.md) を参照してください。

### 7.6 チャンネル一覧のキャッシュ

Dashboard は Bot トークンを持たないため、Bot がチャンネル一覧を Redis にキャッシュして提供します。

**キャッシュ仕様**:
- キー: `app:guild:{guildId}:channels`
- TTL: 1時間
- 更新タイミング: `guildCreate`、`channelCreate`、`channelDelete` イベント

詳細な実装例は [DASHBOARD_BOT_IMPLEMENTATION.md](DASHBOARD_BOT_IMPLEMENTATION.md) を参照してください。

**レート制限対策**: チャンネル変更イベントが連続すると Discord API を連打してしまうため、
**ギルド単位で debounce（30秒）** を適用する。

```typescript
// Bot 側: チャンネル一覧のキャッシュ（debounce 付き）
const CHANNELS_CACHE_TTL = 60 * 60; // 1時間
const CHANNEL_UPDATE_DEBOUNCE_MS = 30 * 1000; // 30秒

// ギルド単位の debounce タイマー管理
const channelUpdateTimers: Map<string, NodeJS.Timeout> = new Map();

/**
 * チャンネル一覧を Redis にキャッシュ（debounce 付き）
 * 連続したイベントでは最後の1回だけ実行される
 */
function scheduleCacheGuildChannels(guild: Guild): void {
  const guildId = guild.id;
  
  // 既存のタイマーがあればキャンセル
  const existingTimer = channelUpdateTimers.get(guildId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  
  // 30秒後に実行（連続イベントでは最後の1回だけ）
  const timer = setTimeout(async () => {
    channelUpdateTimers.delete(guildId);
    await cacheGuildChannelsImmediate(guild);
  }, CHANNEL_UPDATE_DEBOUNCE_MS);
  
  channelUpdateTimers.set(guildId, timer);
}

/**
 * チャンネル一覧を即座に Redis にキャッシュ（内部用）
 */
async function cacheGuildChannelsImmediate(guild: Guild): Promise<void> {
  try {
    // cache だけだと起動直後に揃わないことがあるので fetch() で取得
    const channels = await guild.channels.fetch();
    
    // ★ P0対応: 100件制限を撤廃し全件キャッシュ
    const textChannels = channels
      .filter(ch => ch !== null && ch.type === ChannelType.GuildText)
      .map(ch => ({ id: ch!.id, name: ch!.name, type: ch!.type }));
    
    await redis.setex(
      `app:guild:${guild.id}:channels`,
      CHANNELS_CACHE_TTL,
      JSON.stringify(Array.from(textChannels.values()))
    );
    
    console.log(`[Guild] Cached ${textChannels.length} channels for ${guild.id}`);
  } catch (err) {
    console.error(`[Guild] Failed to cache channels for ${guild.id}:`, err);
    // 失敗してもプロセスは続行（空配列になるだけ）
    // 次の ready イベントや次のチャンネル変更で再挑戦
  }
}

/**
 * 起動時やギルド参加時は即座にキャッシュ（debounce なし）
 */
async function cacheGuildChannels(guild: Guild): Promise<void> {
  await cacheGuildChannelsImmediate(guild);
}

// チャンネル更新時にキャッシュを更新（debounce 付き）
client.on('channelCreate', async (channel) => {
  if (channel.type === ChannelType.GuildText && channel.guild) {
    scheduleCacheGuildChannels(channel.guild);
  }
});

client.on('channelDelete', async (channel) => {
  if (channel.type === ChannelType.GuildText && 'guild' in channel && channel.guild) {
    scheduleCacheGuildChannels(channel.guild);
  }
});

client.on('channelUpdate', async (oldChannel, newChannel) => {
  if (newChannel.type === ChannelType.GuildText && 'guild' in newChannel && newChannel.guild) {
    scheduleCacheGuildChannels(newChannel.guild);
  }
});
```

```typescript
// Dashboard 側: チャンネル一覧の取得
interface ChannelInfo {
  id: string;
  name: string;
  type: number;
}

async function getAvailableChannels(guildId: string): Promise<ChannelInfo[]> {
  const cached = await redis.get(`app:guild:${guildId}:channels`);
  if (!cached) {
    return []; // キャッシュがない場合は空配列
  }
  
  try {
    return JSON.parse(cached) as ChannelInfo[];
  } catch {
    return [];
  }
}
```

### 7.6 lucia-auth 設定

```typescript
// dashboard/src/lib/auth.ts

import { Lucia } from 'lucia';
import { RedisAdapter } from '@lucia-auth/adapter-redis';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

// lucia-auth 管轄のキーは lucia: prefix を使用
// これにより app: prefix と明確に分離される
const adapter = new RedisAdapter(redis, {
  session: 'lucia:session',
  user: 'lucia:user',
});

export const lucia = new Lucia(adapter, {
  sessionCookie: {
    name: 'session',
    attributes: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    },
  },
  sessionExpiresIn: new TimeSpan(7, 'd'),
  getUserAttributes: (attributes) => ({
    discordId: attributes.discord_id,
    username: attributes.username,
    avatar: attributes.avatar,
  }),
});
```

---

## 8. フロントエンド設計

### 8.1 技術スタック

- **フレームワーク**: Astro SSR + Preact Islands
- **認証**: lucia-auth（Redis セッション）
- **データベース**: SQLite + Drizzle ORM

### 8.2 ディレクトリ構成

```
dashboard/
├── src/
│   ├── pages/               # ページ定義（SSR/SSG）
│   │   ├── index.astro
│   │   ├── login.astro
│   │   ├── dashboard/
│   │   │   ├── index.astro             # ギルド一覧
│   │   │   └── [guildId].astro         # ギルド設定ページ
│   │   └── api/                         # API エンドポイント
│   ├── components/          # UI コンポーネント
│   │   ├── ChannelSelector.tsx         # チャンネル選択 (Preact Island)
│   │   └── ToggleSwitch.tsx
│   ├── layouts/             # 共通レイアウト
│   ├── lib/                 # ライブラリ（auth, db, redis）
│   └── middleware.ts        # 認証ミドルウェア
└── data/
    └── dashboard.db         # SQLite ファイル
```

### 8.3 ページ一覧

| パス | レンダリング | 認証 | 説明 |
|------|-------------|------|------|
| `/` | SSG | 不要 | ランディングページ |
| `/login` | SSG | 不要 | ログインボタン表示 |
| `/dashboard` | SSR | 必要 | ギルド一覧表示 |
| `/dashboard/{guildId}` | SSR | 必要 + 権限 | チャンネル設定 |

### 8.4 主要コンポーネント

**ChannelSelector (Preact Island)**:
- チャンネル一覧から許可チャンネルを選択
- 「全チャンネルで応答」トグル対応
- CSRF トークンを X-CSRF-Token ヘッダーで送信
- 楽観的ロック（If-Match / ETag）による競合検知

詳細な実装例は [DASHBOARD_FRONTEND_IMPLEMENTATION.md](DASHBOARD_FRONTEND_IMPLEMENTATION.md) を参照してください。

---

## 9. Bot 側の変更

### 9.1 新規コンポーネント

**追加インターフェース**:
- `IChannelConfigRepository`: 設定の取得、pub/sub 購読、チャンネルキャッシュ
- `ChannelConfigService`: ビジネスロジック層（設定取得、フォールバック処理）

**Redis キーの責務**:
- `app:guild:{id}:config`: ギルド設定（allowAllChannels, whitelist, version）
- `app:guild:{id}:joined`: Bot 参加フラグ（TTL なし）
- `app:guild:{id}:channels`: チャンネル一覧キャッシュ（TTL 1時間）

### 9.2 MessageHandler への統合

既存の MessageHandler に `ChannelConfigService` を DI し、メッセージ受信時に `isChannelAllowed` でチェックします。

**フォールバック動作**:
- 設定未作成（not_found）: `CONFIG_NOT_FOUND_FALLBACK` に従う（デフォルトは `ALLOW_ALL`）
- Redis 障害（error）: `REDIS_DOWN_FALLBACK` に従う（デフォルトは `ALLOW_ALL`）

### 9.3 ギルド参加/離脱イベント

- `guildCreate`: joined フラグ設定 + チャンネルキャッシュ（config は作らない）
- `guildDelete`: joined フラグ削除 + チャンネルキャッシュ削除（config は残す）
- `channelCreate/Delete/Update`: チャンネルキャッシュを debounce 付きで更新

### 9.4 LRU キャッシュと劣化モード

**RedisChannelConfigRepository の特徴**:
- LRU キャッシュ（最大1000ギルド）でメモリ使用量を一定に保つ
- pub/sub 購読で設定変更をリアルタイム反映
- subscribe 切断時は「劣化モード」で Redis を30秒間隔でポーリング

詳細な実装例は [DASHBOARD_BOT_IMPLEMENTATION.md](DASHBOARD_BOT_IMPLEMENTATION.md) を参照してください。
    // TTL なしで joined フラグをセット
    await this.redis.set(`app:guild:${guildId}:joined`, '1');
  }

  async removeJoined(guildId: string): Promise<void> {
    await this.redis.del(`app:guild:${guildId}:joined`);
    // ★ P0対応: config は削除しない（Bot再参加時の「全許可」復帰を防止）
    // joined キーだけ消せば Dashboard は「Bot未参加」と表示し、設定変更もブロックされる。
    // config は残しておくことで、再参加時に以前の設定がそのまま適用される。
    await this.redis.del(`app:guild:${guildId}:channels`);
    this.cache.delete(guildId);
  }

  async cacheChannels(guildId: string, channels: ChannelInfo[]): Promise<void> {
    const CHANNELS_CACHE_TTL = 60 * 60; // 1時間
    await this.redis.setex(
      `app:guild:${guildId}:channels`,
      CHANNELS_CACHE_TTL,
      JSON.stringify(channels)
    );
  }

  // ギルド離脱時にキャッシュをクリア
  removeFromCache(guildId: string): void {
    this.cache.delete(guildId);
  }

  async close(): Promise<void> {
    await this.subscriber.quit();
    await this.redis.quit();
  }

  // ★ P0対応: 起動時ヘルスチェック
  async performHealthCheck(): Promise<{ redis: boolean; subscribe: boolean; errors: string[] }> {
    const errors: string[] = [];
    let redisOk = false;
    
    try {
      const pong = await this.redis.ping();
      redisOk = pong === 'PONG';
    } catch (err) {
      errors.push(`Redis PING failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
    
    if (!this.isSubscribed) {
      errors.push('Redis pub/sub subscription is not active');
    }
    
    return {
      redis: redisOk,
      subscribe: this.isSubscribed,
      errors,
    };
  }
}

// ★ P0対応: Bot 起動時のヘルスチェックと可視化
// index.ts の ready イベント内で呼び出す
async function checkHealthOnStartup(repository: RedisChannelConfigRepository): Promise<void> {
  const health = await repository.performHealthCheck();
  
  if (health.errors.length > 0) {
    console.error('╔════════════════════════════════════════════════════════════╗');
    console.error('║                 ⚠️  HEALTH CHECK FAILED  ⚠️                 ║');
    console.error('╠════════════════════════════════════════════════════════════╣');
    for (const error of health.errors) {
      console.error(`║  ❌ ${error.padEnd(54)}║`);
    }
    console.error('╠════════════════════════════════════════════════════════════╣');
    console.error('║  Bot will operate in degraded mode.                        ║');
    console.error('║  Settings may not sync correctly.                          ║');
    console.error('╚════════════════════════════════════════════════════════════╝');
  } else {
    console.log('[Health] ✅ Redis connection OK');
    console.log('[Health] ✅ Pub/sub subscription active');
  }
}
```

> **★ P0対応: Redis 障害の可視化（MUST）**
>
> **状況（#549 以降）**: 既定は `allow` になったため、Redis 障害で沈黙するのは
> `REDIS_DOWN_FALLBACK=deny` を明示した運用者に限られる。
> ただし「deny を明示したつもりが効いていない」ことにも気づけないため、
> 起動時に `[ChannelConfig] Fallback policy: ...` を INFO 出力し、
> 解釈できない値は WARN する実装を入れた（`parseFallback()`）。
>
> 以下は当時の提案内容。
>
> **MUST: Bot 側のログ出力**
>
> ```typescript
> // Bot が Redis 障害で deny する際は必ず warn ログを出力
> if (result.kind === 'error') {
>   console.warn(`[ChannelConfig] ⚠️ Redis障害により安全側停止中: guild=${guildId}`);
>   console.warn(`[ChannelConfig] REDIS_DOWN_FALLBACK=${process.env.REDIS_DOWN_FALLBACK || 'deny'}`);
> }
> ```
>
> **MUST: Dashboard への状態表示**
>
> Dashboard のヘッダーまたはステータスバーに Redis 接続状態を表示する。
>
> ```tsx
> // Dashboard UI: Redis 障害時の表示（MUST）
> function HealthStatusBanner() {
>   const { data: health } = useHealthCheck();
>   
>   if (health?.redis === 'down') {
>     return (
>       <div className="banner banner-error">
>         ⚠️ Redis に接続できません。Bot は安全側停止モードで動作中です。
>         設定変更は Redis 復旧後に反映されます。
>       </div>
>     );
>   }
>   
>   if (health?.subscription === 'disconnected') {
>     return (
>       <div className="banner banner-warning">
>         ⚡ リアルタイム同期が一時的に無効です。
>         設定変更の反映に最大30秒かかる場合があります。
>       </div>
>     );
>   }
>   
>   return null;
> }
> ```
>
> **SHOULD: 起動時ヘルスチェック**
>
> 1. Redis ping + subscriptionStatus を確認し、異常なら明確に警告ログを出力
> 2. 劣化モード突入時にログを出力
>
> **将来拡張: Discord webhook 通知**
>
> 上級者向けに、環境変数 `HEALTH_ALERT_WEBHOOK_URL` が設定されている場合、
> Redis 障害を Discord webhook で通知する機能を検討。
>
> ```typescript
> // 将来的な実装イメージ
> if (process.env.HEALTH_ALERT_WEBHOOK_URL && health.errors.length > 0) {
>   await fetch(process.env.HEALTH_ALERT_WEBHOOK_URL, {
>     method: 'POST',
>     headers: { 'Content-Type': 'application/json' },
>     body: JSON.stringify({
>       content: `⚠️ **TwitterRX Health Alert**\n${health.errors.join('\n')}`,
>     }),
>   });
> }
> ```

#### ChannelConfigService

```typescript
// src/core/services/ChannelConfigService.ts

import { IChannelConfigRepository, ConfigResult } from './IChannelConfigRepository';

export class ChannelConfigService {
  constructor(private repository: IChannelConfigRepository) {
    // 設定変更の購読開始
    this.repository.subscribe((guildId, version) => {
      console.log(`[ChannelConfig] 設定更新通知: ${guildId} (v${version})`);
    });
  }

  // ★ P0対応: ConfigResult（三値）を適切に処理
  // 注記(#549): 以下の既定値は設計当時のもの。現行の既定は両変数とも allow
  async isChannelAllowed(guildId: string, channelId: string): Promise<boolean> {
    const result = await this.repository.getConfig(guildId);
    
    switch (result.kind) {
      case 'found': {
        // 設定が存在する場合
        const config = result.data;
        if (config.allowAllChannels) return true;
        return config.whitelist.includes(channelId);
      }
      
      case 'not_found': {
        // 設定が存在しない場合は CONFIG_NOT_FOUND_FALLBACK に従う
        // ★ P0対応: デフォルト deny。後方互換が必要なら環境変数で allow を指定
        const fallback = process.env.CONFIG_NOT_FOUND_FALLBACK || 'deny';
        console.log(`[ChannelConfig] Config not found for ${guildId}, fallback: ${fallback}`);
        return fallback === 'allow';
      }
      
      case 'error':
        // ★ P0対応: Redis 障害時は REDIS_DOWN_FALLBACK に従う
        // 既存の null 返却だとここに来ずに「未設定扱い」で allow されていた
        console.error(`[ChannelConfig] Redis error for ${guildId}: ${result.reason}`);
        const fallback = process.env.REDIS_DOWN_FALLBACK || 'deny';
        console.warn(`[ChannelConfig] Applying fallback: ${fallback}`);
        return fallback === 'allow';
    }
  }

  async onGuildJoin(guildId: string): Promise<void> {
    // joined フラグのみセット（config は Dashboard が作成する）
    await this.repository.setJoined(guildId);
  }

  async onGuildLeave(guildId: string): Promise<void> {
    await this.repository.removeJoined(guildId);
  }

  async cacheChannels(guildId: string, channels: ChannelInfo[]): Promise<void> {
    await this.repository.cacheChannels(guildId, channels);
  }
}
```

### 9.2 MessageHandler への統合

> **★ パフォーマンス考慮: isChannelAllowed は I/O を含む**
>
> `isChannelAllowed()` は以下の条件で Redis への I/O が発生する：
>
> | 条件 | I/O 発生 |
> |------|---------|
> | LRU キャッシュヒット + 5分以内 | **なし**（インメモリで完結） |
> | キャッシュミス or 5分超過 | **あり**（Redis GET） |
> | 劣化モード（subscribe 切断時） | **毎回あり** |
>
> **P0 時点では問題なし**。理由：
> - Discord.js の message イベント頻度は、個人〜中規模 Bot では十分低い
> - Redis GET は通常 1ms 以下で完了
> - キャッシュヒット率が高ければ実質ほぼ I/O なし
>
> **高頻度 Bot（1000+ ギルド）を想定する場合の注意**:
> - 劣化モード突入時に Redis GET が毎メッセージ発生 → 負荷集中
> - 対策: Redis Cluster、または subscribe 復旧までの一時的な allow フォールバック
>
> **将来的な最適化候補（P2 以降）**:
> - `isChannelAllowed()` の結果を短時間（10秒程度）追加キャッシュ
> - Redis pipelining で複数ギルドの config を一括取得
>
> **README への記載推奨**:
> ```markdown
> ## パフォーマンス
> 
> - `isChannelAllowed()` は通常キャッシュから応答（I/O なし）
> - Redis 障害時は30秒間隔で Redis 確認に切り替わるため、高頻度 Bot でも安全
> ```

```typescript
// src/adapters/discord/MessageHandler.ts

export class MessageHandler {
  constructor(
    private tweetProcessor: TweetProcessor,
    private embedBuilder: EmbedBuilder,
    private replyLogger: IReplyLogger,
    private channelConfigService: ChannelConfigService, // 追加
  ) {}

  async handleMessage(client: Client, message: Message): Promise<void> {
    // ボットメッセージや自身のメッセージは無視
    if (this.shouldIgnore(client, message)) {
      return;
    }

    // ★ 新規追加: チャンネル許可チェック
    // 注意: キャッシュミス時は Redis I/O が発生する
    if (message.guildId) {
      const isAllowed = await this.channelConfigService.isChannelAllowed(
        message.guildId,
        message.channelId
      );
      if (!isAllowed) {
        return; // 許可されていないチャンネルでは応答しない
      }
    }

    // 以降は既存処理...
  }
}
```

### 9.3 ギルド参加/離脱イベント

> **Note**: チャンネルキャッシュの実装詳細は「7.6 チャンネル一覧のキャッシュ（Bot 側）」を参照。
> ここでは全体の統合方法のみを示す。

```typescript
// src/index.ts（追加部分）

import { ChannelType, Guild } from 'discord.js';

// ★ チャンネルキャッシュの実装は 7.6 節の cacheGuildChannelsImmediate() を使用
// debounce 付き版は scheduleCacheGuildChannels() を使用

// ギルド参加時：joined フラグ + チャンネルキャッシュ（config は作らない）
// ★ 参加時は即座にキャッシュ（debounce なし）
client.on('guildCreate', async (guild) => {
  try {
    await channelConfigService.onGuildJoin(guild.id);
    await cacheGuildChannelsImmediate(guild);  // 7.6 節の関数
    console.log(`[Guild] Joined: ${guild.name} (${guild.id})`);
  } catch (err) {
    console.error(`[Guild] Failed to initialize for ${guild.id}:`, err);
  }
});

// ギルド離脱時：設定を削除
client.on('guildDelete', async (guild) => {
  try {
    await channelConfigService.onGuildLeave(guild.id);
    console.log(`[Guild] Left: ${guild.name} (${guild.id})`);
  } catch (err) {
    console.error(`[Guild] Failed to cleanup config for ${guild.id}:`, err);
  }
});

// チャンネル変更時：キャッシュを更新（debounce 付き）
// ★ 連続したイベントでは最後の1回だけ実行
client.on('channelCreate', async (channel) => {
  if (channel.type === ChannelType.GuildText && channel.guild) {
    scheduleCacheGuildChannels(channel.guild);  // 7.6 節の関数
  }
});

client.on('channelDelete', async (channel) => {
  if (channel.type === ChannelType.GuildText && 'guild' in channel && channel.guild) {
    scheduleCacheGuildChannels(channel.guild);
  }
});

client.on('channelUpdate', async (oldChannel, newChannel) => {
  if (newChannel.type === ChannelType.GuildText && 'guild' in newChannel && newChannel.guild) {
    scheduleCacheGuildChannels(newChannel.guild);
  }
});

// Bot 起動時：joined フラグとチャンネルのみキャッシュ（config は作らない）
client.on('ready', async () => {
  console.log(`[Bot] Logged in as ${client.user?.tag}`);
  
  // 全参加ギルドの joined フラグとチャンネルをキャッシュ
  // ★ config は作らない（Dashboard が作成責任を持つ）
  for (const [guildId, guild] of client.guilds.cache) {
    try {
      await channelConfigRepository.setJoined(guildId);
      await cacheGuildChannelsImmediate(guild);  // 起動時は即座に
    } catch (err) {
      console.error(`[Guild] Failed to cache guild ${guildId}:`, err);
    }
  }
  
  // 孤立キーのクリーンアップ（オプション）
  await cleanupOrphanedConfigs(client, redis);
});
```

### 9.4 DI 更新 (index.ts)

```typescript
// src/index.ts（変更部分のみ）

import { RedisChannelConfigRepository } from './infrastructure/db/RedisChannelConfigRepository';
import { ChannelConfigService } from './core/services/ChannelConfigService';

// Infrastructure層
const channelConfigRepository = new RedisChannelConfigRepository(redisUrl);

// Core層
const channelConfigService = new ChannelConfigService(channelConfigRepository);

// Adapter層
const messageHandler = new MessageHandler(
  tweetProcessor,
  embedBuilder,
  replyLogger,
  channelConfigService, // 追加
);

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[Shutdown] Received SIGTERM');
  await channelConfigRepository.close();
  client.destroy();
  process.exit(0);
});
```

---

## 10. Docker 構成とデプロイ

### 10.1 サービス構成

**追加サービス**:
- `dashboard`: Astro SSR アプリケーション（ポート 4321）
- `redis`: lua-auth セッション + pub/sub + キャッシュ

**既存サービス**:
- `twitter-rx`: Discord Bot本体

### 10.2 環境変数

| 環境変数 | 説明 | デフォルト |
|----------|------|-----------|
| `DISCORD_OAUTH2_CLIENT_ID` | Discord アプリケーション Client ID | 必須 |
| `DISCORD_OAUTH2_CLIENT_SECRET` | Discord アプリケーション Client Secret | 必須 |
| `DISCORD_OAUTH2_REDIRECT_URI` | OAuth2 リダイレクト URI（`https://yourdomain.com/api/auth/discord/callback`） | 必須 |
| `SESSION_SECRET` | lucia-auth セッション暗号化鍵 | 必須（32文字以上推奨） |
| `ENCRYPTION_SALT` | accessToken 暗号化用 salt | 必須（未設定時は起動失敗） |
| `DATABASE_URL` | SQLite ファイルパス | `file:/app/data/dashboard.db` |
| `REDIS_URL` | Redis 接続 URL | `redis://redis:6379` |
| `ORPHAN_CONFIG_RETENTION_DAYS` | 孤立 config 保持日数 | `30` |

### 10.3 nginx 設定とレート制限

Dashboard は nginx をリバースプロキシとして使用します。

**レート制限**:
- `/api/auth/discord/login`: 30 回/分（ゾーン: `twitterrx_dashboard`）
- その他の API エンドポイント: アプリケーション側で実装

**セキュリティヘッダー**:
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`

詳細な実装例は [DASHBOARD_DEPLOYMENT.md](DASHBOARD_DEPLOYMENT.md) を参照してください。

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

### 10.4 配布時の考慮事項

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

## 11. データフロー

### 11.1 設定変更時のシーケンス

```
┌──────────┐     ┌───────────┐     ┌───────────┐     ┌───────────┐
│  ユーザー │     │ Dashboard │     │   Redis   │     │    Bot    │
└────┬─────┘     └─────┬─────┘     └─────┬─────┘     └─────┬─────┘
     │                 │                 │                 │
     │ 設定変更        │                 │                 │
     │────────────────>│                 │                 │
     │                 │                 │                 │
     │                 │ BEGIN TRANSACTION                │
     │                 │ (SQLite)        │                 │
     │                 │                 │                 │
     │                 │ version チェック │                 │
     │                 │ (楽観的ロック)  │                 │
     │                 │                 │                 │
     │                 │ 監査ログ記録    │                 │
     │                 │                 │                 │
     │                 │ whitelist 置換  │                 │
     │                 │                 │                 │
     │                 │ COMMIT          │                 │
     │                 │                 │                 │
     │                 │ SET app:guild:{id}:config        │
     │                 │ (TTL なし)      │                 │
     │                 │────────────────>│                 │
     │                 │                 │                 │
     │                 │ PUBLISH app:config:update         │
     │                 │────────────────>│                 │
     │                 │                 │                 │
     │                 │                 │ MESSAGE         │
     │                 │                 │────────────────>│
     │                 │                 │                 │
     │                 │                 │ キャッシュ無効化 │
     │                 │                 │                 │
     │ 完了 (version)  │                 │                 │
     │<────────────────│                 │                 │
     │                 │                 │                 │
```

> **★ P1対応: シーケンス図と本文の整合性**
>
> 以前は `SETEX guild:{id}` と記載されていたが、本文の設計では config は TTL なし。
> シーケンス図を `SET app:guild:{id}:config (TTL なし)` に修正し、本文と一致させた。

### 11.2 pub/sub 取り逃し時のリカバリ

```
┌───────────┐     ┌───────────┐     ┌───────────┐
│    Bot    │     │   Redis   │     │ Dashboard │
└─────┬─────┘     └─────┬─────┘     └─────┬─────┘
      │                 │                 │
      │ メッセージ受信  │                 │
      │                 │                 │
      │ getConfig()     │                 │
      │────────────────>│                 │
      │                 │                 │
      │ キャッシュヒット│                 │
      │ (5分以上経過)   │                 │
      │                 │                 │
      │ GET guild:{id}  │                 │
      │────────────────>│                 │
      │                 │                 │
      │ version 比較    │                 │
      │                 │                 │
      │ [remote > local]│                 │
      │ キャッシュ更新  │                 │
      │                 │                 │
      │ 最新設定で判定  │                 │
      │                 │                 │
```

**ポイント**:
- pub/sub を取り逃しても、キャッシュが 5分以上経過した次回 getConfig 呼び出し時に Redis を確認
- version を比較することで、不要な更新を回避
- SLO: 取り逃し時は「次回アクセス時に最大 5分遅延」で追従

> **注意**: Bot がそのギルドでメッセージを受信しない限り、getConfig は呼ばれない。
> そのため「絶対的な 5分保証」ではなく「次回アクセス時に最大 5分遅延」という表現が正確。

### 11.3 メッセージ受信時のシーケンス

```
┌──────────┐     ┌───────────┐     ┌───────────┐
│ Discord  │     │    Bot    │     │   Redis   │
└────┬─────┘     └─────┬─────┘     └─────┬─────┘
     │                 │                 │
     │ メッセージ      │                 │
     │────────────────>│                 │
     │                 │                 │
     │                 │ キャッシュ確認   │
     │                 │ (インメモリ)     │
     │                 │                 │
     │                 │ [キャッシュなし or 期限切れ]
     │                 │ GET guild:{id}  │
     │                 │────────────────>│
     │                 │                 │
     │                 │ 設定取得        │
     │                 │<────────────────│
     │                 │                 │
     │                 │ チャンネル許可判定
     │                 │                 │
     │                 │ [許可の場合]    │
     │ 埋め込み返信    │                 │
     │<────────────────│                 │
     │                 │                 │
```

---

## 12. 環境変数

### 12.1 Bot 側

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

### 12.2 Dashboard 側

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

### 12.3 シークレット生成方法

```bash
# SESSION_SECRET の生成
openssl rand -base64 32

# ENCRYPTION_SALT の生成
openssl rand -base64 32
```

---

## 13. マイルストーン

### Phase 1: 基盤構築（P0 対応込み）✅ **完了！**

- [x] Dashboard ディレクトリ構成作成
- [x] Astro + Preact 環境構築
- [x] SQLite + Drizzle ORM セットアップ
- [x] マイグレーションスクリプト作成
- [x] Discord OAuth2 認証実装
- [x] CSRF トークン発行・検証実装（TTL をセッションと同期）
  - [x] **P0: CSRF 検証で長さチェック・形式バリデーション追加（例外落ち防止）**
- [x] Cookie 属性設定（HttpOnly, Secure, SameSite）
- [x] **P0: ENCRYPTION_SALT 必須化（未設定時は起動失敗）**
- [x] **P0: レート制限を Lua スクリプトで原子化**
- [x] **P0: 401 時の再ログイン導線 UI**
- [x] **P0: Redis 再シード処理実装（Dashboard 起動時に SQLite→Redis）**
- [x] **P1: API 共通ヘッダーで Cache-Control: no-store を強制（createApiResponse / createApiError）**
- [x] **P1: 404 エラー（BOT_NOT_JOINED_OR_OFFLINE）で Cache-Control: no-store 付与確認**
- [x] **P1: Redis reseed 時のメタキー（config_schema_version）導入**
- [x] **P1: reseed 時の部分キー欠落チェック（checkForMissingConfigs）**
- [x] **P1: 定期リコンシルジョブ（10分ごとに joined なギルドの config 補完）**
- [x] **P2: 監査ログ保持期間設定化（AUDIT_LOG_RETENTION_DAYS 環境変数）**

### Phase 2: Bot 側統合（P0 対応込み）✅ **完了！**

- [x] `IChannelConfigRepository` インターフェース定義
  - [x] **P0: ConfigResult 型（三値: found/not_found/error）を定義**
- [x] `RedisChannelConfigRepository` 実装
  - [x] LRU キャッシュ（上限 1000）
  - [x] config 永続キャッシュ（TTL なし）
  - [x] version ベースの revalidate（5分間隔）
  - [x] Redis 再接続時の subscribe 再設定
  - [x] **P0: fetchFromRedis で error を明示的に返す**
  - [x] **P0: 劣化モード（subscribe 切断時は30秒間隔で Redis 確認）**
  - [x] **P0: guildDelete で config を削除しない（再参加時の全許可防止）**
  - [x] **P0: 起動時ヘルスチェック（performHealthCheck）**
  - [x] **P0: isRedisHealthy で PING 確認**
  - [x] **P2: エラー分類（JSON_PARSE_ERROR / REDIS_CONNECTION_ERROR 等）**
- [x] `ChannelConfigService` 実装
  - [x] **P0: isChannelAllowed で ConfigResult.kind に応じた分岐**
  - [x] **P0: error 時は REDIS_DOWN_FALLBACK を適用**
  - [x] **P0: not_found 時は CONFIG_NOT_FOUND_FALLBACK を適用**
- [x] `MessageHandler` への統合
- [x] `guildCreate` / `guildDelete` イベントハンドリング
- [x] **P0: channels キャッシュの 100件制限撤廃（全件保存）**
- [x] **P0: channels:refresh 定期チェック（10分ごと）**
- [x] **P0: ready 時に全ギルドの初期化（joined + channels）**
- [x] **P1: メッセージ受信時の低頻度 channels リフレッシュ**
- [x] Graceful shutdown 実装
- [x] **環境変数追加（REDIS_DOWN_FALLBACK, CONFIG_NOT_FOUND_FALLBACK）**

### Phase 3: Dashboard UI

- [x] ギルド一覧ページ
  - [x] GET /api/guilds 実装
  - [x] Bot 参加状態の表示
  - [x] レート制限統合 (10req/10sec)
- [x] チャンネル設定ページ
  - [x] テキストチャンネルのみフィルタ
  - [x] 設定反映タイミングの説明表示（最大遅延を明記）
- [x] ChannelSelector コンポーネント
  - [x] **P0: クライアントサイド検索実装**
  - [x] **P0: チャンネル ID 直接指定エスケープハッチ**
  - [x] **P0: チャンネル再取得ボタン標準搭載（MUST）**
- [x] **P0: 404 (BOT_NOT_JOINED_OR_OFFLINE) のリトライ導線 UI**
  - [x] **P1: 404 レスポンスの content-type 確認ガード追加**
- [x] **P1: セッション期限警告 UI（セッション期限切れページ）**
- [x] 設定保存 API
  - [x] トランザクション処理
  - [x] **P0: 楽観的ロックを UPDATE WHERE version で担保（affected rows 判定）**
  - [x] **P1: If-Match 形式の厳格化（"version" 形式のみ許可）**
  - [x] 監査ログ記録
  - [x] バリデーション（whitelist 上限 500 件）
  - [x] **P1: INSERT OR IGNORE でデフォルト作成を冪等化**
  - [x] **P0: 503 時のレスポンスに現在 version を含める**
  - [x] **P1: PUBLISH 失敗時は warning を返す（200 OK）**
- [x] レート制限実装
  - [x] GET /api/guilds: 10req/10sec
  - [x] GET /api/guilds/:id/config: 10req/10sec
  - [x] PUT /api/guilds/:id/config: 5req/60sec
  - [x] GET /api/guilds/:id/channels: 15req/10sec
  - [x] POST /api/guilds/:id/channels/refresh: 3req/60sec
- [x] エラーハンドリング UI
  - [x] ErrorDisplay コンポーネント作成
  - [x] レート制限エラーの適切な表示
  - [x] セッション期限切れ時の自動リダイレクト
  - [x] 409 Conflict の自動リロード処理
  - [x] 503 Degraded Mode の警告表示

### Phase 4: デプロイ

- [x] Dashboard Dockerfile 作成
  - [x] **P0: node:24-alpine → node:24-slim への移行（npm ci 高速化）**
  - [x] better-sqlite3 ネイティブビルド対応（python3, make, g++ 追加）
- [x] compose.yml 更新
  - [x] **P1: named volume 方式に統一**
- [x] compose.yml.with-nginx 作成（nginx 込み版）
  - [x] **P0: upstream 名を統一（twitterrx_dashboard_backend）**
- [x] .env.example 作成
  - [x] ENCRYPTION_SALT を必須として記載
- [x] **P0: lucia-auth から Oslo + Arctic への移行**
  - [x] oslo パッケージ導入（セッション管理）
  - [x] arctic パッケージ導入（OAuth2 クライアント）
  - [x] `src/lib/auth.ts` の書き換え（Oslo Session API 利用）
  - [x] `src/lib/discord.ts` の書き換え（Arctic Discord Provider 利用）
  - [x] `src/middleware.ts` の Oslo 対応（session validation ロジック更新）
  - [x] 認証フローの動作確認（login → callback → logout）
  - [x] セッション TTL・Cookie 属性の維持確認
  - [x] ドキュメント更新（CHANGELOG に移行理由を記載）
- [x] **P0: Bot 起動時の Redis 接続順序修正（connectRedis → login）**
  - [x] joined フラグの正確な書き込み確保
- [x] **P0: Dashboard セッション管理の修正**
  - [x] `getAccessToken` のキー修正（app:session → lucia:session）
  - [x] Response.redirect() の immutable エラー修正（全認証エンドポイント）
  - [x] ビルド時 DB 接続エラー修正（Proxy による遅延初期化）
  - [x] 日本語リダイレクト URL のエンコード対応
- [x] CI/CD パイプライン更新
  - [x] Dashboard ビルドジョブの追加（.github/workflows/ci.yml）
  - [x] Dashboard Docker イメージのビルド・プッシュ（.github/workflows/push-image.yml）
  - [x] hadolint による Dashboard Dockerfile のリント追加
  - [x] GitHub Container Registry への両イメージプッシュ対応
- [x] ドキュメント更新（README）
  - [x] バックアップ手順を named volume 前提に更新

### Phase 5: 品質向上（P2）

- [x] Dashboardのロギング充実化
  - [x] winston ロガー導入（`src/lib/logger.ts`）
  - [x] 構造化ログ対応（JSON形式、context付き）
  - [x] 主要エンドポイントへのロガー統合
    - [x] `src/startup.ts`
    - [x] `src/pages/api/guilds/index.ts`
    - [x] `src/pages/api/guilds/[guildId]/config.ts`
    - [x] `src/pages/api/guilds/[guildId]/channels.ts`
    - [x] `src/pages/api/auth/discord/callback.ts`
  - [x] エラー情報の詳細記録（stack trace、context情報）
- [x] バグ解消
  - [x] 設定保存処理
  - [x] チャンネル一覧更新
- [ ] 監査ログ閲覧 UI
- [ ] ガベージコレクション実装（Bot 起動時）
- [ ] E2E テスト作成

### Phase 6: メトリクス計測・チューニング

運用開始後、以下の実測データを収集し、設計パラメータの妥当性を検証する。

#### 計測対象と方法

| 計測項目 | 目的 | 計測方法 | 判断基準 |
|----------|------|----------|----------|
| ギルドごとのチャンネル数分布 | whitelist 上限 500 件の妥当性検証 | Bot 起動時に `guild.channels.cache.size` を集計してログ出力 | p99 が 500 未満なら現行で十分 |
| アクティブギルド数 | LRU キャッシュ上限 1000 の妥当性検証 | 1日あたりメッセージを受信したユニークギルド数をカウント | 1000 を超える日が頻発するなら上限見直し |
| キャッシュヒット率 | インメモリ LRU の効果測定 | `getConfig()` でキャッシュヒット/ミスをカウント | 90% 以上ならキャッシュサイズは適切 |
| Redis 参照頻度 | revalidate 間隔 5分の妥当性検証 | Redis GET の呼び出し回数をカウント | 過剰なら間隔延長、不足なら短縮を検討 |
| 監査ログ件数 | 保持期間ポリシーの必要性判断 | `SELECT COUNT(*) FROM config_audit_logs` を定期実行 | 10万件超で保持期間ポリシー導入を検討 |
| pub/sub 取り逃し率 | SLO 達成度の確認 | version 不一致による revalidate 発生回数をカウント | 1% 以上なら対策強化を検討 |

#### 実装方針

```typescript
// src/infrastructure/metrics/MetricsCollector.ts

interface Metrics {
  cacheHits: number;
  cacheMisses: number;
  redisGets: number;
  revalidations: number;  // version 不一致による再取得
  activeGuilds: Set<string>;  // その日にメッセージを受信したギルド
  // ★ pub/sub 取り逃し率を見るためのメトリクスを追加
  pubsubMessagesReceived: number;  // pub/sub メッセージ受信回数
  cacheInvalidations: number;      // cache.delete 回数（pub/sub 経由）
}

class MetricsCollector {
  private metrics: Metrics = {
    cacheHits: 0,
    cacheMisses: 0,
    redisGets: 0,
    revalidations: 0,
    activeGuilds: new Set(),
    pubsubMessagesReceived: 0,
    cacheInvalidations: 0,
  };

  recordCacheHit(): void { this.metrics.cacheHits++; }
  recordCacheMiss(): void { this.metrics.cacheMisses++; }
  recordRedisGet(): void { this.metrics.redisGets++; }
  recordRevalidation(): void { this.metrics.revalidations++; }
  recordActiveGuild(guildId: string): void { this.metrics.activeGuilds.add(guildId); }
  // ★ 追加: pub/sub 関連のメトリクス
  recordPubsubMessage(): void { this.metrics.pubsubMessagesReceived++; }
  recordCacheInvalidation(): void { this.metrics.cacheInvalidations++; }

  getCacheHitRate(): number {
    const total = this.metrics.cacheHits + this.metrics.cacheMisses;
    return total === 0 ? 0 : this.metrics.cacheHits / total;
  }

  getActiveGuildCount(): number {
    return this.metrics.activeGuilds.size;
  }

  // 日次でログ出力 & リセット
  flushDaily(): void {
    console.log('[Metrics] Daily Summary:', {
      cacheHitRate: `${(this.getCacheHitRate() * 100).toFixed(1)}%`,
      activeGuilds: this.getActiveGuildCount(),
      redisGets: this.metrics.redisGets,
      revalidations: this.metrics.revalidations,
      // ★ pub/sub 取り逃し率の推計に使える
      pubsubMessagesReceived: this.metrics.pubsubMessagesReceived,
      cacheInvalidations: this.metrics.cacheInvalidations,
    });
    this.reset();
  }

  private reset(): void {
    this.metrics = {
      cacheHits: 0,
      cacheMisses: 0,
      redisGets: 0,
      revalidations: 0,
      activeGuilds: new Set(),
      pubsubMessagesReceived: 0,
      cacheInvalidations: 0,
    };
  }
}
```

> **メトリクスの使い方**:
> 
> | メトリクス | 用途 |
> |-------------|------|
> | `pubsubMessagesReceived` | pub/sub 経由で受け取った更新通知の回数 |
> | `cacheInvalidations` | pub/sub で cache.delete した回数 |
> | `revalidations` | version 不一致で Redis から再取得した回数 |
> 
> `revalidations` が大きい = pub/sub を取り逃している可能性が高い。
> `pubsubMessagesReceived` と `cacheInvalidations` の比較で、
> 「通知は受けているがキャッシュになかった」ケースも見える。
```

#### タスク

- [ ] MetricsCollector 実装
- [ ] RedisChannelConfigRepository にメトリクス計測を組み込み
- [ ] 日次サマリーログ出力（cron or setInterval）
- [ ] 1ヶ月運用後にデータ分析・パラメータ見直し

#### 将来の拡張：監視基盤（別リポジトリ）

本体の軽量設計を維持するため、監視基盤は **別リポジトリでオプション提供** とする。

**リポジトリ案**: `t1nyb0x/TwitterRX-monitoring`

**提供内容**:

| コンポーネント | 役割 |
|---------------|------|
| Prometheus exporter | Bot の `/metrics` エンドポイントからメトリクス収集 |
| Grafana ダッシュボード | 可視化用 JSON 定義ファイル |
| docker-compose.monitoring.yml | Prometheus + Grafana の構成 |
| アラートルール | キャッシュヒット率低下、Redis 接続エラー等 |

**前提条件**:
- 本体側に `/metrics` エンドポイント（Prometheus 形式）をオプションで実装
- 環境変数 `ENABLE_METRICS=true` で有効化

**本体側の対応（Phase 6+）**:
```typescript
// 環境変数で有効化
const ENABLE_METRICS = process.env.ENABLE_METRICS === 'true';

// Express or Fastify で /metrics エンドポイントを公開
if (ENABLE_METRICS) {
  app.get('/metrics', (req, res) => {
    res.set('Content-Type', 'text/plain');
    res.send(metricsCollector.toPrometheusFormat());
  });
}
```

**対象ユーザー**:
- 既存の監視基盤（Prometheus + Grafana）を持っている上級者
- 本番環境で詳細な監視が必要なケース

**スコープ外（本体には含めない）**:
- Prometheus / Grafana コンテナ
- ダッシュボード JSON
- アラート設定

> **Note**: 監視基盤リポジトリは Dashboard 機能が安定稼働した後（Phase 6 完了後）に着手予定。

## 14. 設計上の決定事項まとめ

### 14.1 P0（必須）対応

| 課題 | 対応 |
|------|------|
| **Bot再参加時の全許可防止** | guildDelete で config を削除しない。joined キーのみ削除し、config は残す |
| **劣化モードの確実な統合** | subscribe 切断時は revalidate 間隔を30秒に短縮 |
| **楽観ロックの競合耐性** | UPDATE の WHERE 句に version を含め、affected rows で競合検出 |
| **CSRF 検証の例外落ち防止** | 長さチェック・hex 形式バリデーションを timingSafeEqual の前に実行 |
| **Redis消失時の復旧導線** | Dashboard 起動時に SQLite→Redis 再シードを実行（config キーが 0 件の場合） |
| **100件/500件の不整合** | Bot 側 channels キャッシュの 100件制限撤廃 + Dashboard クライアントサイド検索 + チャンネル ID 直接指定 |
| **503 時の UX 改善** | レスポンスに「保存完了の可能性」と現在 version を返す。UI は自動で GET し直して state を合わせる |
| **BOT_NOT_JOINED_OR_OFFLINE** | joined 判定で Bot オフラインの可能性も示唆するエラーメッセージに改善 |
| **getConfig() 三値化** | `ConfigResult` 型で `found`/`not_found`/`error` を明確に分離。Redis 障害と未設定を区別可能に |
| **REDIS_DOWN_FALLBACK** | `error` 時に適用。`not_found`（未設定）は `CONFIG_NOT_FOUND_FALLBACK` に従う（両方デフォルト allow / #549 で deny から変更） |
| **Nginx upstream 統一** | `/_astro/` も `twitterrx_dashboard_backend` に統一 |
| **レート制限の原子化** | Lua スクリプトで ZREMRANGEBYSCORE → ZCARD → ZADD を原子的に実行 |
| **ENCRYPTION_SALT 必須化** | デフォルト値を禁止、未設定時は起動失敗 |
| **再ログイン導線 UI** | 401 時に再ログインボタンを目立たせる（P0 必須） |
| pub/sub 取り逃し | `version` + 5分間隔 revalidate で補完 |
| トランザクション | SQLite TRANSACTION で whitelist 丸ごと置換 |
| CSRF 対策 | `X-CSRF-Token` ヘッダー必須 + Redis 保存（TTL はセッションと同期） |
| Cookie 属性 | `HttpOnly`, `Secure`, `SameSite=Lax` |
| subscribe エラー耐性 | 再接続時の自動 resubscribe、JSON パース失敗時は error を返す |
| botJoined 判定 | Redis `app:guild:{id}:joined` キーの存在で判定（TTL なし） |
| availableChannels 取得 | Bot が Redis `app:guild:{id}:channels` にキャッシュ、Dashboard が読み取り |
| SLO 表現 | 「通常は数秒、最大5分後」+ 「メッセージ受信時に反映」を明記 |
| LRU 実装 | Map の delete/set でアクセス順を維持 |
| KEYS コマンド | SCAN に変更（Redis ブロック回避） |

### 14.2 P1 対応

| 課題 | 対応 |
|------|------|
| **定期リコンシルジョブ** | 10分ごとに joined なギルドの config キー欠落を補完 |
| **部分 reseed 対応** | schema version 一致でも joined ギルドの config 欠落をチェック |
| **404 の content-type 確認** | SSR ルーティングミスで HTML が返る場合のガード追加 |
| **アウトボックス方式** | pending_redis_updates テーブルで SQLite→Redis 同期の整合性を堅牢化（オプション） |
| **guilds キャッシュ TTL 短縮** | 7日 → 1時間に変更。設定保存時は forceRefresh で Discord API 再検証 |
| **channels 再取得ボタン** | UI に標準搭載。詰まった時に人間が押せるようにする |
| **メッセージ受信時の channels リフレッシュ** | キャッシュが古い場合、低頻度で checkAndRefreshChannels を実行 |
| **resetAt 計算の統一** | Lua スクリプト内で allowed 時も「最古エントリ + window」に統一 |
| **GET でのデフォルト作成冪等化** | `INSERT OR IGNORE` で同時アクセス競合を防止 |
| **シーケンス図の SETEX 修正** | `SET app:guild:{id}:config (TTL なし)` に統一 |
| **volume 方針統一** | named volume を推奨、バックアップ手順も更新 |
| botJoined 判定 | Redis `app:guild:{id}:joined` キーの存在で判定（Bot トークン不使用） |
| 巨大ギルド対策 | テキストチャンネルのみ、whitelist 500 件上限 |
| Redis TTL | config: **TTLなし（永続）**、joined: TTL なし、channels: 1時間 TTL、guilds: 1時間 TTL |
| キャッシュ肥大化 | LRU（上限 1000）+ ギルド離脱時削除 |
| KEYS コマンドの危険性 | SCAN を使用して段階的に取得 |
| If-Match の HTTP 準拠 | ETag 形式（`"3"`）で返却・検証 |

### 14.3 P2 対応

| 課題 | 対応 |
|------|------|
| **エラー分類** | JSON_PARSE_ERROR / REDIS_CONNECTION_ERROR / REDIS_TIMEOUT 等を分類してメトリクスに活用 |
| **LRU メモリ見積もり** | 1 config あたり 1KB〜10KB、1000 件で約 1MB〜10MB（Node.js ヒープに対して十分小さい） |
| 監査ログ | `config_audit_logs` テーブルで変更履歴記録 |
| 競合更新 | `version` による楽観的ロック + `If-Match` ヘッダー |
| アウトボックス方式 | SQLite + pending_redis_updates で Redis 同期の整合性を堅牢化（将来検討） |

### 14.4 採用しなかった選択肢

| 選択肢 | 不採用理由 |
|--------|-----------|
| Redis Streams | 自己ホスト配布の運用コスト増、pub/sub + revalidate で十分 |
| PostgreSQL | 自己ホスト型には過剰、SQLite で要件を満たせる |
| `@upstash/redis` | REST ベースで pub/sub 非対応 |
| Dashboard に Bot トークン | セキュリティリスク、配布時の複雑化 |
| Bot と Dashboard が SQLite 共有 | コンテナ間でのロック・破損リスク、複雑化 |
| KEYS コマンド | Redis をブロックする地雷、SCAN を使用 |
| ENCRYPTION_SALT のデフォルト値 | 配布版で全員同じ鍵派生になる事故を防止するため禁止 |
| Bot が ready で createConfig | 再起動のたびに設定が初期化される事故を防止 |
| refresh_token によるトークン更新 | 実装複雑化、期限切れ時は再ログインで十分 |

### 14.5 config 作成責任の明確化

**問題**: Bot が `ready` で `createConfig()` を実行すると、再起動のたびに Dashboard で設定したホワイトリストが初期化されてしまう。

**解決策**: config の作成責任を Dashboard に寄せる。

- Bot は `joined` フラグと `channels` キャッシュのみ管理
- Dashboard の `GET /api/guilds/{guildId}/config` で SQLite に行がなければデフォルト作成
- Bot は config がない場合 `CONFIG_NOT_FOUND_FALLBACK` に従う（デフォルト: allow）
- 「設定は UI を開いた瞬間に整う」設計

### 14.6 guild.channels.cache の信頼性

**問題**: `guild.channels.cache` は起動直後や大規模ギルドで全件揃わないことがある。

**解決策**: `guild.channels.fetch()` を使用して確実に取得。

- Discord API を呼ぶので失敗する可能性がある
- 失敗時はログを出してプロセス続行（空配列になるだけ）

### 14.7 アクセストークンの保管

**問題**: Discord API を叩くには Bearer トークンが必要だが、保管場所が未定義だった。

**解決策**:

- ログイン時に `access_token` と `expiresAt` をセッションに保存
- ギルド一覧もログイン時に取得してセッションにキャッシュ
- refresh_token は使わず、期限切れ時は再ログインを促す
- シンプルな設計を優先（refresh フローは複雑になる）

---

## 15. 運用上の前提・制約

このセクションでは、システム運用時の前提条件と制約事項を明記する。

### 15.1 障害時の挙動

| 障害 | 影響 | 復旧方法 |
|------|------|----------|
| **Dashboard ダウン** | 設定変更不可。Bot は動作継続（キャッシュから設定取得） | Dashboard 再起動 |
| **Redis ダウン** | Dashboard: ログイン不可、設定変更不可。Bot: キャッシュが効いている間は動作継続、キャッシュ切れ後は環境変数に従いフォールバック | Redis 再起動 |
| **SQLite 破損** | 設定の永続データ消失 | バックアップから復元、または再設定 |

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
> **デフォルトが `allow` である理由**（#549 で deny から変更）:
> - チャンネルを個別に絞る運用者はマイノリティであり、多数派は設定を触らない
> - 既定を `deny` にすると、障害時に「Bot が壊れた」と見える形で多数派に影響が出る
> - 制限したい運用者は `deny` を明示でき、その選択は起動時ログで確認できる
> 
> **受け入れているトレードオフ**:
> - **Bot 再起動 × Redis 障害中**の交差では、インメモリキャッシュが空のまま `error` 経路に入るため、
>   whitelist を設定済みのギルドでも一時的に全チャンネルで反応する
> - ただし Redis エラー時にキャッシュは破棄されない（`not_found` のときのみ破棄）ため、
>   障害中でもキャッシュに乗っているギルドは正常に動作し続ける。影響はキャッシュミス時に限定される
> 
> **★ P0対応: not_found も error も同じく環境変数で制御**
> 
> | 状況 | 適用する環境変数 | デフォルト |
> |------|-------------------|------------|
> | `not_found`（設定未作成） | `CONFIG_NOT_FOUND_FALLBACK` | `allow` |
> | `error`（Redis障害） | `REDIS_DOWN_FALLBACK` | `allow` |
> 
> 値は `trim().toLowerCase()` で正規化される。解釈できない値は WARN を出して既定の `allow` に倒れる。
> 有効な設定は起動時に `[ChannelConfig] Fallback policy: ...` として INFO ログに出力される。
> 
> **制限したい運用者向け**:
> - `CONFIG_NOT_FOUND_FALLBACK=deny` … Dashboard で設定するまで反応させない
> - `REDIS_DOWN_FALLBACK=deny` … 障害中も whitelist を維持する
> 
> **★ P0対応: 三値による明確な分離**
> 
> 従来の `getConfig()` は `null` を返していたが、これでは「未設定」と「エラー」の区別ができず、
> Redis 障害時も「未設定扱い」で全許可になる危険があった。
> 
> 三値（`found` / `not_found` / `error`）を返すことで、この問題を解決：
> 
> ```typescript
> // ★ P0対応: try/catch ではなく、戻り値の kind で分岐
> async function isChannelAllowed(guildId: string, channelId: string): Promise<boolean> {
>   const result = await this.repository.getConfig(guildId);
>   
>   switch (result.kind) {
>     case 'found': {
>       const config = result.data;
>       if (config.allowAllChannels) return true;
>       return config.whitelist.includes(channelId);
>     }
>     
>     case 'not_found': {
>       // 設定が存在しない場合は CONFIG_NOT_FOUND_FALLBACK に従う
>       const fallback = process.env.CONFIG_NOT_FOUND_FALLBACK || 'deny';
>       return fallback === 'allow';
>     }
>     
>     case 'error':
>       // ★ Redis 障害時は REDIS_DOWN_FALLBACK に従う
>       console.error(`[ChannelConfig] Redis error: ${result.reason}`);
>       const fallback = process.env.REDIS_DOWN_FALLBACK || 'deny';
>       return fallback === 'allow';
>   }
> }
> ```
> 
> **従来の問題点**:
> - `fetchFromRedis()` が例外を握りつぶして `null` を返していた
> - `isChannelAllowed()` は `config === null` を「未設定」として `allow` していた
> - 結果として Redis 障害時も全許可になり、`REDIS_DOWN_FALLBACK=deny` が効かなかった
> 
> **修正後**:
> - `fetchFromRedis()` はエラー時に `{ kind: 'error', reason }` を返す
> - `isChannelAllowed()` は `error` の場合のみ `REDIS_DOWN_FALLBACK` を適用
> - `not_found`（未設定）と `error`（障害）が明確に分離される
| **Redis データ消失** | `joined` フラグ消失 → Dashboard で「Bot 未参加」表示。config キャッシュ消失 → Bot は全チャンネル許可で動作 | Bot 再起動で `joined` 復旧。Dashboard でギルド設定を開くと config キャッシュ再作成 |

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

### 15.2 設計上の制約

| 制約 | 理由 | 回避策 |
|------|------|--------|
| **pub/sub はベストエフォート** | 配信保証なし、Bot 再起動中のメッセージは取り逃す | 5分間隔の revalidate で補完 |
| **whitelist 500 件上限** | DB・Redis パフォーマンス考慮 | 通常のユースケースでは十分 |
| **Dashboard は Bot トークンを持たない** | 配布時のセキュリティリスク軽減 | Redis 経由で情報連携 |
| **refresh_token 未使用** | 実装複雑化を避ける | 期限切れ時は再ログインで対応 |
| **guilds キャッシュ TTL 1時間** | 権限変更への追従を早めるため 7日から短縮 | 設定保存時は forceRefresh で再検証 |

### 15.3 復旧のシナリオ

**Redis が消えた場合**:

1. Bot 再起動で `joined` フラグが復旧（`ready` イベント）
2. Bot 再起動で `channels` キャッシュが復旧（`ready` イベント）
3. Dashboard でギルド設定を開くと `config` キャッシュが再作成

**pub/sub を取り逃した場合**:

1. Bot は通常通り動作（古い設定のまま）
2. 次回そのギルドでメッセージを受信した際、キャッシュが 5分以上経過していれば Redis を確認
3. version 比較で新しい設定があれば更新

### 15.4 大規模環境での考慮事項

| 項目 | 閾値 | 対策 |
|------|------|------|
| ギルド数 | 1,000+ | LRU キャッシュ上限で制御済み |
| Redis キー数 | 10,000+ | `cleanupOrphanedConfigs` を無効化可能（環境変数） |
| チャンネル変更頻度 | 高頻度 | debounce（30秒）で API 連打を防止 |

---

## 16. 運用トラブルシュート

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

### バックアップ・復旧手順（クイックリファレンス）

> **★ 必須-1対応: README に落とす前提でここにも最低限の抜粋を残す**

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

## 17. 参考資料

- [Astro 公式ドキュメント](https://docs.astro.build/)
- [lucia-auth](https://lucia-auth.com/)
- [Drizzle ORM](https://orm.drizzle.team/)
- [Discord OAuth2](https://discord.com/developers/docs/topics/oauth2)
- [Discord Permissions](https://discord.com/developers/docs/topics/permissions)
- [ioredis](https://github.com/redis/ioredis)
- [OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
