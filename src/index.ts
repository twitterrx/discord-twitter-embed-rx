import fs from "node:fs";
import path from "node:path";

import type { Announcement } from "@rx-twitter/shared";
import { DASHBOARD_VERSION_FALLBACK, DASHBOARD_VERSION_KEY } from "@rx-twitter/shared";
import { Client, GatewayIntentBits, Message, Partials, ChannelType } from "discord.js";

import { DiscordAnnouncementSender } from "@/adapters/discord/DiscordAnnouncementSender";
import { DiscordEmbedBuilder } from "@/adapters/discord/EmbedBuilder";
import { MessageHandler } from "@/adapters/discord/MessageHandler";
import { OwnerCommandHandler } from "@/adapters/discord/OwnerCommandHandler";
import { TwitterAdapter } from "@/adapters/twitter/TwitterAdapter";
import type { GuildDeliveryTarget } from "@/core/models/Announcement";
import { AnnouncementService } from "@/core/services/AnnouncementService";
import { ArticlePostService } from "@/core/services/ArticlePostService";
import { BanService } from "@/core/services/BanService";
import { ChannelConfigService } from "@/core/services/ChannelConfigService";
import { MediaHandler } from "@/core/services/MediaHandler";
import { TweetProcessor } from "@/core/services/TweetProcessor";
import { RedisAnnouncementRepository } from "@/infrastructure/db/RedisAnnouncementRepository";
import { RedisArticlePostRepository } from "@/infrastructure/db/RedisArticlePostRepository";
import { RedisBanRepository } from "@/infrastructure/db/RedisBanRepository";
import { RedisChannelConfigRepository } from "@/infrastructure/db/RedisChannelConfigRepository";
import { RedisReplyLogger } from "@/infrastructure/db/RedisReplyLogger";
import { FileManager } from "@/infrastructure/filesystem/FileManager";
import { HealthServer } from "@/infrastructure/http/HealthServer";
import type { HealthCheckDependencies } from "@/infrastructure/http/HealthServer";
import { HttpClient } from "@/infrastructure/http/HttpClient";
import { VideoDownloader } from "@/infrastructure/http/VideoDownloader";
import { AnnouncementStreamConsumer } from "@/infrastructure/stream/AnnouncementStreamConsumer";
import { cleanupOrphanedConfigs } from "@/utils/cleanupOrphanedConfigs";
import logger from "@/utils/logger";

import config, { ROOT_DIR } from "./config/config";
import { connectRedis } from "./db/connect";
import { redis } from "./db/init";
import { deleteReply, popReply } from "./db/replyLogger";

enum ApplicationMode {
  Production = "production",
  Development = "development",
}

const ENV = process.env.NODE_ENV;

const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"));
const version = packageJson.version;

// === Application Mode === // Todo export to other file
let appMode: ApplicationMode = ApplicationMode.Production;
switch (ENV) {
  case "production":
    appMode = ApplicationMode.Production;
    break;
  case "develop":
    appMode = ApplicationMode.Development;
    break;
}
logger.info(`Application started in ${appMode} mode`);
logger.info(`Version: ${version}`);

// === Health Server ===
let healthServer: HealthServer | undefined;

// === Load bot token from environ variable ===
let token: string | undefined;
switch (appMode) {
  case ApplicationMode.Production:
    token = process.env.PRODUCTION_TOKEN;
    break;
  case ApplicationMode.Development:
    token = process.env.DEVELOP_TOKEN;
    break;
}

// === Check token was successfully to load ===
if (token === undefined) {
  throw new Error(`Failed load discord token. Mode: ${appMode}`);
} else {
  logger.info("Successfully loaded discord bot token");
}

// === Check owner user id ===
const ownerUserId = process.env.OWNER_USER_ID;
if (!ownerUserId) {
  throw new Error("OWNER_USER_ID environment variable is not set");
}
logger.info(`Owner user ID: ${ownerUserId}`);

// === Dependency Injection Setup ===
const tmpDir = path.join(path.dirname(ROOT_DIR), "tmp");

// Infrastructure層
const httpClient = new HttpClient();
const fileManager = new FileManager(tmpDir);
const videoDownloader = new VideoDownloader();
const replyLogger = new RedisReplyLogger();
const articlePostRepository = new RedisArticlePostRepository();

// P0: Channel Config Repository & Service
const channelConfigRepository = new RedisChannelConfigRepository();
const channelConfigService = new ChannelConfigService(channelConfigRepository);

// Core層
const tweetProcessor = new TweetProcessor();
const articlePostService = new ArticlePostService(articlePostRepository);
const mediaHandler = new MediaHandler(httpClient, config.MEDIA_MAX_FILE_SIZE);

// Adapter層
const twitterAdapter = TwitterAdapter.createDefault();
const embedBuilder = new DiscordEmbedBuilder();
// Owner Command / Ban System
const banRepository = new RedisBanRepository();
const banService = new BanService(banRepository);

const messageHandler = new MessageHandler(
  tweetProcessor,
  twitterAdapter,
  embedBuilder,
  mediaHandler,
  fileManager,
  videoDownloader,
  replyLogger,
  tmpDir,
  channelConfigService,
  banService,
  articlePostService
);

// === Create discord bot client ===
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageTyping,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// Owner Command Handler
const ownerCommandHandler = new OwnerCommandHandler(ownerUserId, banService, client);

// お知らせ配信（#425 Phase1）
// ownerUserId は起動時ガードで存在保証済みだが、クロージャ内で型が広がるため const で固定する
const resolvedOwnerUserId: string = ownerUserId;
const announcementRepository = new RedisAnnouncementRepository();
const announcementSender = new DiscordAnnouncementSender(client);
const announcementService = new AnnouncementService(announcementSender, announcementRepository);

/**
 * お知らせを全参加サーバーへ配信する（BAN 済みサーバーは除外）
 */
async function handleAnnouncement(announcement: Announcement): Promise<void> {
  const targets: GuildDeliveryTarget[] = [];
  for (const [guildId, guild] of client.guilds.cache) {
    if (await banService.isGuildBanned(guildId)) {
      continue;
    }
    const target = await channelConfigService.getAnnounceTarget(guildId);
    targets.push({ guildId, ownerId: guild.ownerId, target });
  }

  const summary = await announcementService.deliver(announcement, targets);
  logger.info("[Bot] Announcement delivery finished", { announcementId: announcement.id, ...summary });

  // 失敗ギルドがある場合は throw し、ストリーム側で再配信させる（未配信ギルドのみ再試行される）
  if (summary.failed > 0) {
    throw new Error(
      `Announcement ${announcement.id} had ${summary.failed} failed deliveries (delivered: ${summary.delivered}, skipped: ${summary.skipped})`
    );
  }

  // 全ギルドへ配信完了。オーナーへ結果を通知（通知失敗は本処理に影響させない）
  try {
    const owner = await client.users.fetch(resolvedOwnerUserId);
    await owner.send(
      `お知らせ「${announcement.title}」を配信しました。\n` +
        `成功: ${summary.delivered} / スキップ: ${summary.skipped}`
    );
  } catch (err) {
    logger.warn("[Bot] Failed to notify owner of announcement result", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const announcementConsumer = new AnnouncementStreamConsumer(handleAnnouncement, announcementRepository, {
  onDeadLetter: async (info) => {
    // 配信不能・不正なお知らせをオーナーへ通知（通知失敗は本処理に影響させない）
    try {
      const owner = await client.users.fetch(resolvedOwnerUserId);
      const title = info.announcement?.title ? `「${info.announcement.title}」` : `entry ${info.streamEntryId}`;
      await owner.send(
        `お知らせ${title}の配信を打ち切りました（dead-letter）。\n理由: ${info.reason}` +
          (info.attempts ? `\n試行回数: ${info.attempts}` : "")
      );
    } catch (err) {
      logger.warn("[Bot] Failed to notify owner of dead-letter", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});

// === Event handlers ===
// On ready
client.on("clientReady", async () => {
  if (client.user === null) {
    throw new Error("Failed load client");
  }
  logger.info(`Logged in as ${client.user.tag}`);

  // P0: 起動時ヘルスチェック
  const isHealthy = await channelConfigService.performHealthCheck();
  if (!isHealthy) {
    logger.error("[Bot] Channel config health check failed!");
    // 劣化モードで続行（完全停止はしない）
  }

  // お知らせ配信の購読開始（ギルドキャッシュが揃う ready 後に開始する）
  // 起動失敗が Bot 全体を落とさないよう保護する（お知らせ機能のみ劣化）
  try {
    await announcementConsumer.start();
  } catch (err) {
    logger.error("[Bot] Failed to start announcement consumer (announcements disabled):", err);
  }

  // P0: guildCreate - joined フラグとチャンネルキャッシュを設定
  for (const [guildId, guild] of client.guilds.cache) {
    // P0: BAN チェック — BAN されていたら即座に脱退
    if (await banService.isGuildBanned(guildId)) {
      logger.warn(`[Bot] Found banned guild ${guildId} (${guild.name}) during startup, leaving immediately`);
      try {
        await guild.leave();
      } catch (leaveErr) {
        logger.error(`[Bot] Failed to leave banned guild ${guildId} during startup:`, leaveErr);
      }
      continue;
    }

    try {
      const redis = (await import("@/db/init")).redis;

      // joined フラグを設定
      await redis.set(`app:guild:${guildId}:joined`, "1");

      // チャンネル情報を取得してキャッシュ
      const channels = await guild.channels.fetch();
      const textChannels = channels
        .filter((ch) => ch?.type === ChannelType.GuildText)
        .map((ch) => ({
          id: ch!.id,
          name: ch!.name,
        }));

      await redis.setEx(
        `app:guild:${guildId}:channels`,
        60 * 60, // 1時間TTL
        JSON.stringify(textChannels)
      );

      logger.info(`[Bot] Initialized guild ${guildId} (${guild.name}), ${textChannels.length} text channels cached`);
    } catch (err) {
      logger.error(`[Bot] Failed to initialize guild ${guildId}:`, err);
    }
  }

  // P2: 孤立した config のクリーンアップ（オプション）
  try {
    const redis = (await import("@/db/init")).redis;
    await cleanupOrphanedConfigs(client, redis);
  } catch (err) {
    logger.error("[Bot] Failed to cleanup orphaned configs:", err);
  }

  await updateStatus();

  // update per 5 min.
  setInterval(() => void updateStatus(), 5 * 60 * 1000);

  // P0: channels定期リフレッシュ（10分ごと）
  setInterval(
    async () => {
      for (const [guildId, guild] of client.guilds.cache) {
        try {
          const redis = (await import("@/db/init")).redis;
          const channels = await guild.channels.fetch();
          const textChannels = channels
            .filter((ch) => ch?.type === ChannelType.GuildText)
            .map((ch) => ({
              id: ch!.id,
              name: ch!.name,
            }));

          await redis.setEx(
            `app:guild:${guildId}:channels`,
            60 * 60, // 1時間TTL
            JSON.stringify(textChannels)
          );

          logger.debug(`[Bot] Refreshed channels for guild ${guildId}`);
        } catch (err) {
          logger.error(`[Bot] Failed to refresh channels for guild ${guildId}:`, err);
        }
      }
    },
    10 * 60 * 1000
  ); // 10分ごと
});

// On Message Create
client.on("messageCreate", async (m: Message) => {
  // Owner DM コマンドのルーティング
  const isOwnerCommand = await ownerCommandHandler.handleMessage(m);
  if (isOwnerCommand) return; // Owner コマンドはここで完了

  messageHandler.handleMessage(client, m).catch((error) => {
    logger.error("Error handling message:", { error: error.message, stack: error.stack });
  });
});

// On Message Delete
client.on("messageDelete", async (m) => {
  const message = m as Message;
  const replyData = await popReply(message.id);
  if (!replyData) return;
  const { replyIds, channelId } = replyData;

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;

    // 全ての関連メッセージを削除
    for (const replyId of replyIds) {
      try {
        const botMsg = await channel.messages.fetch(replyId);
        if (botMsg) await botMsg.delete();
      } catch (err) {
        logger.error(`Failed to delete message ${replyId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await deleteReply(message.id);
  } catch (err) {
    logger.error("Failed to delete message", { error: err instanceof Error ? err.message : String(err) });
  }
});

// P0: guildCreate - Bot が新しいサーバーに参加した時
client.on("guildCreate", async (guild) => {
  // P0: BAN チェック — BAN されていたら即座に脱退
  if (await banService.isGuildBanned(guild.id)) {
    logger.warn(`[Bot] Attempted to join banned guild ${guild.id} (${guild.name}), leaving immediately`);
    try {
      await guild.leave();
    } catch (leaveErr) {
      logger.error(`[Bot] Failed to leave banned guild ${guild.id}:`, leaveErr);
    }
    return;
  }

  try {
    const redis = (await import("@/db/init")).redis;

    // joined フラグを設定
    await redis.set(`app:guild:${guild.id}:joined`, "1");

    // チャンネル情報を取得してキャッシュ
    const channels = await guild.channels.fetch();
    const textChannels = channels
      .filter((ch) => ch?.type === ChannelType.GuildText)
      .map((ch) => ({
        id: ch!.id,
        name: ch!.name,
      }));

    await redis.setEx(
      `app:guild:${guild.id}:channels`,
      60 * 60, // 1時間TTL
      JSON.stringify(textChannels)
    );

    logger.info(`[Bot] Joined guild ${guild.id} (${guild.name}), ${textChannels.length} text channels cached`);
  } catch (err) {
    logger.error(`[Bot] Failed to handle guildCreate for ${guild.id}:`, err);
  }
});

// P0: guildDelete - Bot がサーバーから退出した時
client.on("guildDelete", async (guild) => {
  try {
    const redis = (await import("@/db/init")).redis;

    // P0: config は削除しない（再参加時の全許可防止）
    // joined フラグのみ削除
    await redis.del(`app:guild:${guild.id}:joined`);

    // channels キャッシュは削除
    await redis.del(`app:guild:${guild.id}:channels`);

    // Repository側のキャッシュクリア
    await channelConfigRepository.handleGuildDelete(guild.id);

    logger.info(`[Bot] Left guild ${guild.id}, joined flag and channels cache cleared (config preserved)`);
  } catch (err) {
    logger.error(`[Bot] Failed to handle guildDelete for ${guild.id}:`, err);
  }
});

// === Login ===
(async () => {
  await connectRedis();

  // ヘルスチェックサーバー起動（Redis 接続後に起動）
  const healthDeps: HealthCheckDependencies = {
    isRedisReady: () => redis.isReady,
    isDiscordReady: () => client.isReady(),
    isAnnouncementConsumerHealthy: () => announcementConsumer.getStatus().healthy,
  };
  healthServer = new HealthServer(healthDeps, undefined, version);
  await healthServer.start();

  await client.login(token);
})();

const updateStatus = async () => {
  const serverCount = client.guilds.cache.size;

  let dashboardVersion: string;
  try {
    const redis = (await import("@/db/init")).redis;
    const value = await redis.get(DASHBOARD_VERSION_KEY);
    dashboardVersion = value ? `v${value}` : DASHBOARD_VERSION_FALLBACK;
  } catch {
    dashboardVersion = DASHBOARD_VERSION_FALLBACK;
  }

  client.user?.setActivity(`v${version}(Dashboard ${dashboardVersion}), 導入サーバー数: ${serverCount}`);
};

// P0: Graceful shutdown
process.on("SIGINT", async () => {
  logger.info("[Bot] Received SIGINT, shutting down gracefully...");
  await shutdown();
});

process.on("SIGTERM", async () => {
  logger.info("[Bot] Received SIGTERM, shutting down gracefully...");
  await shutdown();
});

async function shutdown(): Promise<void> {
  try {
    // ヘルスチェックサーバー停止
    if (healthServer) {
      await healthServer.stop();
    }

    // お知らせ購読のシャットダウン
    await announcementConsumer.shutdown();

    // Channel Config Service のシャットダウン
    await channelConfigService.shutdown();

    // Redis 接続のクローズ
    const redis = (await import("@/db/init")).redis;
    await redis.quit();

    // Discord Client のログアウト
    client.destroy();

    logger.info("[Bot] Graceful shutdown completed");
    process.exit(0);
  } catch (err) {
    logger.error("[Bot] Error during shutdown:", err);
    process.exit(1);
  }
}
