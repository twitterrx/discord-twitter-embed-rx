# Dashboard Bot 側実装ガイド

> このドキュメントは [DASHBOARD_SPEC.md](DASHBOARD_SPEC.md) のセクション9（Bot 側の変更）から抽出した実装例を記載しています。

---

## 目次

- [新規コンポーネント](#新規コンポーネント)
  - [IChannelConfigRepository インターフェース](#ichannelconfigrepository-インターフェース)
  - [RedisChannelConfigRepository 実装](#redischannelconfigrepository-実装)
  - [ChannelConfigService](#channelconfigservice)
- [MessageHandler への統合](#messagehandler-への統合)
- [ギルド参加/離脱イベント](#ギルド参加離脱イベント)
- [チャンネル一覧のキャッシュ](#チャンネル一覧のキャッシュ)
- [DI 更新](#di-更新)

---

## 新規コンポーネント

### IChannelConfigRepository インターフェース

```typescript
// src/core/services/IChannelConfigRepository.ts

export interface GuildConfigData {
  guildId: string;
  allowAllChannels: boolean;
  whitelist: string[];
  version: number;
  updatedAt: string; // ISO 8601
}

// ★ P0対応: 三値で返すことで「未設定」と「エラー」を明確に分離
export type ConfigResult =
  | { kind: 'found'; data: GuildConfigData }  // 設定が存在する
  | { kind: 'not_found' }                      // 設定が存在しない（CONFIG_NOT_FOUND_FALLBACK に従う）
  | { kind: 'error'; reason: string };         // Redis障害など（REDIS_DOWN_FALLBACK を適用）

export interface IChannelConfigRepository {
  getConfig(guildId: string): Promise<ConfigResult>;
  subscribe(callback: (guildId: string, version: number) => void): void;
  setJoined(guildId: string): Promise<void>;
  removeJoined(guildId: string): Promise<void>;
  cacheChannels(guildId: string, channels: ChannelInfo[]): Promise<void>;
}

interface ChannelInfo {
  id: string;
  name: string;
  type: number;
}
```

### RedisChannelConfigRepository 実装

このクラスは Redis からの設定取得、キャッシュ管理、pub/sub 接続を担当します。

#### キャッシュ設定

```typescript
// config は TTL なしで永続保存（Redis が Bot の SoT のため）
// 以下は channels キャッシュのみに使用
const CHANNELS_CACHE_TTL = 60 * 60; // 1時間
const REVALIDATE_INTERVAL = 5 * 60 * 1000; // 5分

// LRU キャッシュ上限
// 想定最大ギルド数（1,000）を超えた場合は、低頻度ギルドを Redis 参照にフォールバックさせる設計。
const MAX_CACHE_SIZE = 1000;
```

#### メモリ見積もり（P2対応）

1 guild config のサイズ想定:
- guildId: 18文字（Snowflake）
- allowAllChannels: boolean
- whitelist: 最大 500 件 × 18文字 = 約 9KB（最大ケース）
- version: number
- updatedAt: ISO 8601 文字列 = 約 24文字
- fetchedAt: number（キャッシュ用メタデータ）

平均的なギルド（whitelist 50件）: 約 1KB
最大ケース（whitelist 500件）: 約 10KB

LRU 1000 件でのメモリ使用量想定:
- 平均: 1KB × 1,000 = 約 1MB
- 最大: 10KB × 1,000 = 約 10MB

Node.js のデフォルトヒープサイズ（512MB〜2GB）に対して十分小さく、配布版でも問題にならないレベルです。

#### 実装コード

実装の全体は以下の通りです。各メソッドの詳細はコメントを参照してください。

```typescript
// src/infrastructure/db/RedisChannelConfigRepository.ts

import Redis from 'ioredis';
import { IChannelConfigRepository, ConfigResult, GuildConfigData } from '../../core/services/IChannelConfigRepository';

const CHANNELS_CACHE_TTL = 60 * 60; // 1時間
const REVALIDATE_INTERVAL = 5 * 60 * 1000; // 5分
const MAX_CACHE_SIZE = 1000;

export class RedisChannelConfigRepository implements IChannelConfigRepository {
  private redis: Redis;
  private subscriber: Redis;
  private cache: Map<string, { data: GuildConfigData; fetchedAt: number }> = new Map();
  private isSubscribed: boolean = false;
  private messageHandlers: Set<(guildId: string, version: number) => void> = new Set();
  private subscribeRetryCount: number = 0;
  private readonly MAX_SUBSCRIBE_RETRIES = 5;
  private readonly SUBSCRIBE_RETRY_BASE_MS = 1000;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
    this.subscriber = new Redis(redisUrl);
    this.setupReconnection();
    this.setupMessageHandler();
  }

  private setupReconnection(): void {
    this.subscriber.on('error', (err) => {
      console.error('[Redis Subscriber] Error:', err.message);
      this.isSubscribed = false;
    });

    this.subscriber.on('reconnecting', () => {
      console.log('[Redis Subscriber] Reconnecting...');
      this.isSubscribed = false;
    });

    this.subscriber.on('connect', () => {
      console.log('[Redis Subscriber] Connected');
    });

    this.subscriber.on('ready', async () => {
      console.log('[Redis Subscriber] Ready');
      await this.subscribeWithRetry();
    });
  }

  private async subscribeWithRetry(): Promise<void> {
    if (this.isSubscribed) {
      console.log('[Redis Subscriber] Already subscribed, skipping');
      return;
    }

    try {
      await this.subscriber.subscribe('app:config:update');
      this.isSubscribed = true;
      this.subscribeRetryCount = 0;
      console.log('[Redis Subscriber] Subscribed to app:config:update');
    } catch (err) {
      this.isSubscribed = false;
      this.subscribeRetryCount++;
      console.error(`[Redis Subscriber] Failed to subscribe (attempt ${this.subscribeRetryCount}):`, err);

      if (this.subscribeRetryCount < this.MAX_SUBSCRIBE_RETRIES) {
        const delay = this.SUBSCRIBE_RETRY_BASE_MS * Math.pow(2, this.subscribeRetryCount - 1);
        console.log(`[Redis Subscriber] Retrying in ${delay}ms...`);
        setTimeout(() => this.subscribeWithRetry(), delay);
      } else {
        console.error('[Redis Subscriber] Max retries exceeded. Subscribe failed permanently.');
      }
    }
  }

  private setupMessageHandler(): void {
    this.subscriber.on('message', (channel, message) => {
      if (channel !== 'app:config:update') return;

      try {
        const { guildId, version } = JSON.parse(message);
        
        // キャッシュを無効化
        const cached = this.cache.get(guildId);
        if (cached && cached.data.version < version) {
          this.cache.delete(guildId);
        }
        
        // 登録された全コールバックを呼び出し
        for (const handler of this.messageHandlers) {
          try {
            handler(guildId, version);
          } catch (handlerErr) {
            console.error('[Redis] Handler error:', handlerErr);
          }
        }
      } catch (err) {
        console.error('[Redis] Failed to parse app:config:update message:', err);
      }
    });
  }

  get subscriptionStatus(): { isSubscribed: boolean; retryCount: number } {
    return {
      isSubscribed: this.isSubscribed,
      retryCount: this.subscribeRetryCount,
    };
  }

  private async isRedisHealthy(): Promise<boolean> {
    try {
      const pong = await this.redis.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }

  async getConfig(guildId: string): Promise<ConfigResult> {
    // 劣化モード: subscribe が切れている場合は30秒間隔で Redis を確認
    const DEGRADED_REVALIDATE_INTERVAL = 30 * 1000;
    const effectiveRevalidateInterval = this.isSubscribed 
      ? REVALIDATE_INTERVAL 
      : DEGRADED_REVALIDATE_INTERVAL;
    
    if (!this.isSubscribed) {
      console.warn(`[ChannelConfig] Degraded mode: will check Redis for ${guildId} (subscribe is down)`);
    }
    
    // 1. キャッシュから取得
    const cached = this.cache.get(guildId);
    if (cached) {
      // LRU: アクセス順を維持するため再挿入
      this.cache.delete(guildId);
      this.cache.set(guildId, cached);
      
      const age = Date.now() - cached.fetchedAt;
      if (age < effectiveRevalidateInterval) {
        return { kind: 'found', data: cached.data };
      }
      
      // 期限切れ: version を確認
      const remoteResult = await this.fetchFromRedis(guildId);
      
      if (remoteResult.kind === 'error') {
        console.warn(`[Redis] Using stale cache for ${guildId} due to error: ${remoteResult.reason}`);
        return { kind: 'found', data: cached.data };
      }
      
      if (remoteResult.kind === 'found' && remoteResult.data.version > cached.data.version) {
        this.updateCache(guildId, remoteResult.data);
        return remoteResult;
      }
      
      cached.fetchedAt = Date.now();
      return { kind: 'found', data: cached.data };
    }

    // 2. Redis から取得（キャッシュがない場合）
    const result = await this.fetchFromRedis(guildId);
    if (result.kind === 'found') {
      this.updateCache(guildId, result.data);
    }
    return result;
  }

  private async fetchFromRedis(guildId: string): Promise<ConfigResult> {
    try {
      const raw = await this.redis.get(`app:guild:${guildId}:config`);
      if (!raw) {
        return { kind: 'not_found' };
      }
      const data = JSON.parse(raw) as GuildConfigData;
      return { kind: 'found', data };
    } catch (err) {
      const reason = this.classifyError(err);
      console.error(`[Redis] Failed to fetch config for ${guildId}:`, reason);
      return { kind: 'error', reason };
    }
  }

  private classifyError(err: unknown): string {
    if (err instanceof SyntaxError) {
      return 'JSON_PARSE_ERROR';
    }
    
    if (err instanceof Error) {
      const message = err.message.toLowerCase();
      
      if (message.includes('econnrefused') || message.includes('connection')) {
        return 'REDIS_CONNECTION_ERROR';
      }
      
      if (message.includes('etimedout') || message.includes('timeout')) {
        return 'REDIS_TIMEOUT';
      }
      
      if (message.includes('enotfound') || message.includes('getaddrinfo')) {
        return 'REDIS_DNS_ERROR';
      }
      
      return `UNKNOWN_ERROR: ${err.message}`;
    }
    
    return 'UNKNOWN_ERROR';
  }

  private updateCache(guildId: string, data: GuildConfigData): void {
    this.cache.delete(guildId);
    
    if (this.cache.size >= MAX_CACHE_SIZE) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    
    this.cache.set(guildId, { data, fetchedAt: Date.now() });
  }

  subscribe(callback: (guildId: string, version: number) => void): void {
    this.messageHandlers.add(callback);
    console.log(`[Redis] Message handler registered (total: ${this.messageHandlers.size})`);
  }

  unsubscribe(callback: (guildId: string, version: number) => void): void {
    this.messageHandlers.delete(callback);
    console.log(`[Redis] Message handler unregistered (total: ${this.messageHandlers.size})`);
  }

  async setJoined(guildId: string): Promise<void> {
    await this.redis.set(`app:guild:${guildId}:joined`, '1');
  }

  async removeJoined(guildId: string): Promise<void> {
    await this.redis.del(`app:guild:${guildId}:joined`);
    await this.redis.del(`app:guild:${guildId}:channels`);
    this.cache.delete(guildId);
  }

  async cacheChannels(guildId: string, channels: ChannelInfo[]): Promise<void> {
    await this.redis.setex(
      `app:guild:${guildId}:channels`,
      CHANNELS_CACHE_TTL,
      JSON.stringify(channels)
    );
  }

  removeFromCache(guildId: string): void {
    this.cache.delete(guildId);
  }

  async close(): Promise<void> {
    await this.subscriber.quit();
    await this.redis.quit();
  }

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
```

#### 起動時ヘルスチェック（P0対応）

```typescript
// Bot 起動時のヘルスチェックと可視化
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

### ChannelConfigService

```typescript
// src/core/services/ChannelConfigService.ts

import { IChannelConfigRepository, ConfigResult } from './IChannelConfigRepository';

export class ChannelConfigService {
  constructor(private repository: IChannelConfigRepository) {
    this.repository.subscribe((guildId, version) => {
      console.log(`[ChannelConfig] 設定更新通知: ${guildId} (v${version})`);
    });
  }

  async isChannelAllowed(guildId: string, channelId: string): Promise<boolean> {
    const result = await this.repository.getConfig(guildId);
    
    switch (result.kind) {
      case 'found': {
        const config = result.data;
        if (config.allowAllChannels) return true;
        return config.whitelist.includes(channelId);
      }
      
      case 'not_found': {
        // CONFIG_NOT_FOUND_FALLBACK に従う
        // 注記(#549): 以下の既定値は設計当時のもの。現行の既定は両変数とも allow
        const fallback = process.env.CONFIG_NOT_FOUND_FALLBACK || 'deny';
        console.log(`[ChannelConfig] Config not found for ${guildId}, fallback: ${fallback}`);
        return fallback === 'allow';
      }
      
      case 'error':
        // REDIS_DOWN_FALLBACK に従う
        console.error(`[ChannelConfig] Redis error for ${guildId}: ${result.reason}`);
        const fallback = process.env.REDIS_DOWN_FALLBACK || 'deny';
        console.warn(`[ChannelConfig] Applying fallback: ${fallback}`);
        return fallback === 'allow';
    }
  }

  async onGuildJoin(guildId: string): Promise<void> {
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

---

## MessageHandler への統合

### パフォーマンス考慮

`isChannelAllowed()` は以下の条件で Redis への I/O が発生します：

| 条件 | I/O 発生 |
|------|---------|
| LRU キャッシュヒット + 5分以内 | **なし**（インメモリで完結） |
| キャッシュミス or 5分超過 | **あり**（Redis GET） |
| 劣化モード（subscribe 切断時） | **毎回あり** |

P0 時点では問題ありません。理由：
- Discord.js の message イベント頻度は、個人〜中規模 Bot では十分低い
- Redis GET は通常 1ms 以下で完了
- キャッシュヒット率が高ければ実質ほぼ I/O なし

### 実装コード

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
    if (this.shouldIgnore(client, message)) {
      return;
    }

    // チャンネル許可チェック
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

---

## ギルド参加/離脱イベント

```typescript
// src/index.ts（追加部分）

import { ChannelType, Guild } from 'discord.js';

// ギルド参加時：joined フラグ + チャンネルキャッシュ
client.on('guildCreate', async (guild) => {
  try {
    await channelConfigService.onGuildJoin(guild.id);
    await cacheGuildChannelsImmediate(guild);
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

// Bot 起動時：joined フラグとチャンネルのみキャッシュ
client.on('ready', async () => {
  console.log(`[Bot] Logged in as ${client.user?.tag}`);
  
  // 全参加ギルドの joined フラグとチャンネルをキャッシュ
  for (const [guildId, guild] of client.guilds.cache) {
    try {
      await channelConfigRepository.setJoined(guildId);
      await cacheGuildChannelsImmediate(guild);
    } catch (err) {
      console.error(`[Guild] Failed to cache guild ${guildId}:`, err);
    }
  }
  
  // ヘルスチェック
  await checkHealthOnStartup(channelConfigRepository);
});
```

---

## チャンネル一覧のキャッシュ

Dashboard は Bot トークンを持たないため、Bot がチャンネル一覧を Redis にキャッシュします。

### レート制限対策

チャンネル変更イベントが連続すると Discord API を連打してしまうため、**ギルド単位で debounce（30秒）** を適用します。

```typescript
// Bot 側: チャンネル一覧のキャッシュ（debounce 付き）
const CHANNELS_CACHE_TTL = 60 * 60; // 1時間
const CHANNEL_UPDATE_DEBOUNCE_MS = 30 * 1000; // 30秒

const channelUpdateTimers: Map<string, NodeJS.Timeout> = new Map();

function scheduleCacheGuildChannels(guild: Guild): void {
  const guildId = guild.id;
  
  const existingTimer = channelUpdateTimers.get(guildId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  
  const timer = setTimeout(async () => {
    channelUpdateTimers.delete(guildId);
    await cacheGuildChannelsImmediate(guild);
  }, CHANNEL_UPDATE_DEBOUNCE_MS);
  
  channelUpdateTimers.set(guildId, timer);
}

async function cacheGuildChannelsImmediate(guild: Guild): Promise<void> {
  try {
    const channels = await guild.channels.fetch();
    
    // P0対応: 100件制限を撤廃し全件キャッシュ
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
  }
}

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

### チャンネル再取得リクエスト対応

Dashboard から「再取得してほしい」という要求に応えます。

```typescript
// Bot 側: channels:refresh チェック
async function checkAndRefreshChannels(guild: Guild): Promise<void> {
  const shouldRefresh = await redis.get(`app:guild:${guild.id}:channels:refresh`);
  if (shouldRefresh) {
    await cacheGuildChannelsImmediate(guild);
    await redis.del(`app:guild:${guild.id}:channels:refresh`);
    console.log(`[Guild] Refreshed channels for ${guild.id} by request`);
  }
}

// 定期チェック（10分ごと）
const REFRESH_CHECK_INTERVAL = 10 * 60 * 1000;

setInterval(async () => {
  for (const [guildId, guild] of client.guilds.cache) {
    try {
      await checkAndRefreshChannels(guild);
    } catch (err) {
      console.error(`[Channels] Failed to check refresh for ${guildId}:`, err);
    }
  }
}, REFRESH_CHECK_INTERVAL);
```

---

## DI 更新

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

## 関連ドキュメント

- [DASHBOARD_SPEC.md](DASHBOARD_SPEC.md) - メイン仕様書
- [DASHBOARD_API_IMPLEMENTATION.md](DASHBOARD_API_IMPLEMENTATION.md) - API 実装ガイド
- [DASHBOARD_AUTH_IMPLEMENTATION.md](DASHBOARD_AUTH_IMPLEMENTATION.md) - 認証・認可実装
- [DASHBOARD_DEPLOYMENT.md](DASHBOARD_DEPLOYMENT.md) - デプロイ・運用ガイド
