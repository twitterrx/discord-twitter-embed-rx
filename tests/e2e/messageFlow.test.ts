import path from "node:path";

import type { GuildConfig } from "@rx-twitter/shared";
import { ContainerBuilder } from "discord.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ComponentsV2Builder } from "#/adapters/discord/ComponentsV2Builder.js";
import { DiscordEmbedBuilder } from "#/adapters/discord/EmbedBuilder.js";
import { MessageHandler } from "#/adapters/discord/MessageHandler.js";
import { TwitterAdapter } from "#/adapters/twitter/TwitterAdapter.js";
import { ArticlePostService } from "#/core/services/ArticlePostService.js";
import { BanService } from "#/core/services/BanService.js";
import { ChannelConfigService, type FallbackPolicies } from "#/core/services/ChannelConfigService.js";
import { MediaHandler } from "#/core/services/MediaHandler.js";
import { TweetProcessor } from "#/core/services/TweetProcessor.js";
import { redis } from "#/db/init.js";
import { RedisArticlePostRepository } from "#/infrastructure/db/RedisArticlePostRepository.js";
import { RedisBanRepository } from "#/infrastructure/db/RedisBanRepository.js";
import { RedisChannelConfigRepository } from "#/infrastructure/db/RedisChannelConfigRepository.js";
import { RedisReplyLogger } from "#/infrastructure/db/RedisReplyLogger.js";
import { FileManager } from "#/infrastructure/filesystem/FileManager.js";
import { HttpClient } from "#/infrastructure/http/HttpClient.js";
import { VideoDownloader } from "#/infrastructure/http/VideoDownloader.js";

import { createFakeClient, createFakeMessage } from "./discordFake.js";
import { stubTwitterApi, vxStatus } from "./twitterApiStub.js";

/**
 * Bot の主要フローを通す E2E テスト。
 *
 *   メッセージ受信 → URL 判定 → 投稿情報の取得 → 表示の組み立て → 送信
 *
 * tests/unit/adapters/discord/MessageHandler.test.ts は協力者を全て vi.fn() に
 * 差し替えるため、MessageHandler の手順は検証できても「実際の協調」は見ていない。
 * ここでは Core / Adapter を本物のまま組み、外側の 2 箇所だけを差し替える。
 *
 *   本物: TweetProcessor / TwitterAdapter(Vx→Fx) / ComponentsV2Builder /
 *         DiscordEmbedBuilder / ChannelConfigService / Redis
 *   偽物: Discord（Message・Client）と fetch（外部 Twitter API）
 *
 * 依存グラフは src/index.ts と同じ順で組む。index.ts は読み込み時点で Discord へ
 * ログインするため import できず、配線はテスト側で再現している。したがって
 * index.ts 側の配線ミスはこのテストでは捕まらない（ADR 0007 参照）。
 *
 * 実行には Redis が必要なため、RUN_REDIS_INTEGRATION=1 のときだけ実行する。
 *   RUN_REDIS_INTEGRATION=1 REDIS_URL=redis://127.0.0.1:6390 npm run test:e2e
 */
const RUN = process.env.RUN_REDIS_INTEGRATION === "1";

/** fixture・vx スタブと揃えた、テストで送信するツイート URL */
const TWEET_URL = "https://x.com/test_user/status/1870044090072739960";

const configKey = (guildId: string): string => `app:guild:${guildId}:config`;

const generateTestGuildId = (): string => `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const policies: FallbackPolicies = { redisDown: "deny", configNotFound: "deny" };

/** ギルド設定を実 Redis へ書く。Repository と同じ接続を使う */
const seedGuildConfig = async (guildId: string, overrides: Partial<GuildConfig> = {}): Promise<void> => {
  const config: GuildConfig = {
    guildId,
    allowAllChannels: true,
    whitelistedChannelIds: [],
    version: 1,
    updatedAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
  await redis.set(configKey(guildId), JSON.stringify(config));
};

describe.skipIf(!RUN)("Bot メッセージフロー (e2e, real Redis)", () => {
  let handler: MessageHandler;
  let channelConfigRepository: RedisChannelConfigRepository;
  let testGuildId: string;

  const client = createFakeClient();

  beforeAll(async () => {
    if (!redis.isOpen) await redis.connect();
  });

  afterAll(async () => {
    if (redis.isOpen) await redis.quit();
  });

  beforeEach(async () => {
    testGuildId = generateTestGuildId();

    // --- src/index.ts と同じ順で組む ---
    // Infrastructure 層
    const httpClient = new HttpClient();
    const fileManager = new FileManager(path.join("/tmp", "twitterrx-e2e"));
    const videoDownloader = new VideoDownloader();
    const replyLogger = new RedisReplyLogger();

    // Core 層
    const tweetProcessor = new TweetProcessor();
    const articlePostService = new ArticlePostService(new RedisArticlePostRepository());
    const mediaHandler = new MediaHandler(httpClient);
    channelConfigRepository = new RedisChannelConfigRepository();
    const channelConfigService = new ChannelConfigService(channelConfigRepository, policies);
    const banService = new BanService(new RedisBanRepository());

    // Adapter 層
    const twitterAdapter = TwitterAdapter.createDefault();
    const embedBuilder = new DiscordEmbedBuilder();
    const componentsV2Builder = new ComponentsV2Builder();

    handler = new MessageHandler(
      tweetProcessor,
      twitterAdapter,
      embedBuilder,
      componentsV2Builder,
      mediaHandler,
      fileManager,
      videoDownloader,
      replyLogger,
      path.join("/tmp", "twitterrx-e2e"),
      channelConfigService,
      banService,
      articlePostService
    );

    // Repository の Pub/Sub 購読が張られるまで待つ（未完了で shutdown するとタイマーが残る）
    await vi.waitFor(async () => {
      const subscribers = await redis.pubSubNumSub("config:update");
      expect(subscribers["config:update"]).toBeGreaterThanOrEqual(1);
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await channelConfigRepository.shutdown();
    await redis.del(configKey(testGuildId)).catch(() => undefined);
  });

  describe("対応 URL を受信すると展開して返す", () => {
    it("vx から取得した内容で Components v2 のメッセージを返す", async () => {
      await seedGuildConfig(testGuildId);
      stubTwitterApi({
        vx: { kind: "json", body: vxStatus({ text: "これはテスト投稿です" }) },
        // vx が成功するのでフォールバックは起きない。呼ばれたら落ちるようにしておく
        fx: { kind: "status", status: 500 },
      });

      const fake = createFakeMessage({ content: `見て ${TWEET_URL}`, guildId: testGuildId });
      await handler.handleMessage(client, fake.message);

      expect(fake.replies).toHaveLength(1);

      const payload = fake.replies[0] as Record<string, unknown>;
      const components = payload.components as ContainerBuilder[];
      expect(components).toHaveLength(1);
      expect(components[0]).toBeInstanceOf(ContainerBuilder);

      // Container に本文と著者が載っていること。JSON まで落として中身を確かめる
      const rendered = JSON.stringify(components[0].toJSON());
      expect(rendered).toContain("これはテスト投稿です");
      expect(rendered).toContain("test_user");

      // 展開できたので元メッセージの埋め込みは抑制される
      expect(fake.wasSuppressed()).toBe(true);
    });

    it("ツイート URL が無いメッセージには何も返さない", async () => {
      await seedGuildConfig(testGuildId);
      stubTwitterApi({
        // URL が無ければ API は一切呼ばれないはず
        vx: { kind: "status", status: 500 },
        fx: { kind: "status", status: 500 },
      });

      const fake = createFakeMessage({ content: "ただの雑談", guildId: testGuildId });
      await handler.handleMessage(client, fake.message);

      expect(fake.replies).toHaveLength(0);
      expect(fake.wasSuppressed()).toBe(false);
    });
  });

  describe("チャンネル許可", () => {
    it("ホワイトリスト外のチャンネルでは処理しない", async () => {
      await seedGuildConfig(testGuildId, {
        allowAllChannels: false,
        whitelistedChannelIds: ["allowed-channel"],
      });
      const stub = stubTwitterApi({
        vx: { kind: "json", body: vxStatus() },
        fx: { kind: "fixture", name: "status-text-only" },
      });

      const fake = createFakeMessage({
        content: `見て ${TWEET_URL}`,
        guildId: testGuildId,
        channelId: "not-in-list",
      });
      await handler.handleMessage(client, fake.message);

      expect(fake.replies).toHaveLength(0);
      // 許可判定で弾くので、外部 API は呼ばれない
      expect(stub.calls).toHaveLength(0);
    });

    it("ホワイトリスト内のチャンネルでは処理する", async () => {
      await seedGuildConfig(testGuildId, {
        allowAllChannels: false,
        whitelistedChannelIds: ["allowed-channel"],
      });
      stubTwitterApi({
        vx: { kind: "json", body: vxStatus() },
        fx: { kind: "status", status: 500 },
      });

      const fake = createFakeMessage({
        content: `見て ${TWEET_URL}`,
        guildId: testGuildId,
        channelId: "allowed-channel",
      });
      await handler.handleMessage(client, fake.message);

      expect(fake.replies).toHaveLength(1);
    });

    it("設定が存在しない場合、configNotFound=deny に従って処理しない", async () => {
      // 設定を書かない
      const stub = stubTwitterApi({
        vx: { kind: "json", body: vxStatus() },
        fx: { kind: "status", status: 500 },
      });

      const fake = createFakeMessage({ content: `見て ${TWEET_URL}`, guildId: testGuildId });
      await handler.handleMessage(client, fake.message);

      expect(fake.replies).toHaveLength(0);
      expect(stub.calls).toHaveLength(0);
    });
  });

  describe("外部 API の失敗", () => {
    it("vx が 5xx を返すと fx へフォールバックして展開する", async () => {
      await seedGuildConfig(testGuildId);
      const stub = stubTwitterApi({
        vx: { kind: "status", status: 500, body: "<html>Internal Server Error</html>" },
        // 実 API の保存済み payload をそのまま返す
        fx: { kind: "fixture", name: "status-text-only" },
      });

      const fake = createFakeMessage({ content: `見て ${TWEET_URL}`, guildId: testGuildId });
      await handler.handleMessage(client, fake.message);

      // 両方のホストへ到達している = フォールバックが働いた
      expect(stub.calls.some((url) => url.includes("api.vxtwitter.com"))).toBe(true);
      expect(stub.calls.some((url) => url.includes("api.fxtwitter.com"))).toBe(true);

      expect(fake.replies).toHaveLength(1);
      const payload = fake.replies[0] as Record<string, unknown>;
      const components = payload.components as ContainerBuilder[];
      expect(components[0]).toBeInstanceOf(ContainerBuilder);
      expect(fake.wasSuppressed()).toBe(true);
    });

    it("vx と fx の両方が失敗するとエラーを返信する", async () => {
      await seedGuildConfig(testGuildId);
      stubTwitterApi({
        vx: { kind: "status", status: 500, body: "<html>Internal Server Error</html>" },
        fx: { kind: "status", status: 500, body: "<html>Internal Server Error</html>" },
      });

      const fake = createFakeMessage({ content: `見て ${TWEET_URL}`, guildId: testGuildId });
      await handler.handleMessage(client, fake.message);

      expect(fake.replies).toHaveLength(1);
      const payload = fake.replies[0] as Record<string, unknown>;
      expect(payload.content).toBe("ツイートの取得に失敗しました。");

      // 展開できていないので元メッセージの埋め込みは抑制しない
      expect(fake.wasSuppressed()).toBe(false);
    });
  });
});
