import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType } from "discord.js";

import type { ITwitterAdapter } from "@/adapters/twitter/BaseTwitterAdapter";
import type {
  IFileManager,
  IVideoDownloader,
} from "@/adapters/discord/MessageHandler";
import { MessageHandler } from "@/adapters/discord/MessageHandler";
import type { IReplyLogger } from "@/db/replyLogger";
import type { ChannelConfigService } from "@/core/services/ChannelConfigService";
import type { ArticlePostService } from "@/core/services/ArticlePostService";
import type { MediaHandler } from "@/core/services/MediaHandler";
import type { TweetProcessor } from "@/core/services/TweetProcessor";
import type { DiscordEmbedBuilder } from "@/adapters/discord/EmbedBuilder";
import { createMockTweet } from "../../../fixtures/mock-tweets";

vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const createMockClient = () =>
  ({
    user: { id: "bot-user-id" },
    on: vi.fn(),
  }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * createMessageComponentCollector を備えた返信メッセージのモック。
 * collect / end のハンドラを控えておき、テストから任意に発火できるようにする。
 */
const createMockReplyMessage = () => {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  const collector = {
    on: vi.fn((event: string, fn: (...args: unknown[]) => unknown) => {
      handlers[event] = fn;
      return collector;
    }),
    stop: vi.fn(),
  };

  return {
    id: "reply-msg-id",
    edit: vi.fn().mockResolvedValue(undefined),
    createMessageComponentCollector: vi.fn().mockReturnValue(collector),
    collector,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    emit: (event: string, ...args: unknown[]) => handlers[event]?.(...args) as any,
    hasHandler: (event: string) => Boolean(handlers[event]),
  };
};

const createMockButtonInteraction = () => ({
  isButton: vi.fn().mockReturnValue(true),
  customId: "reveal_spoiler_msg-id",
  deferReply: vi.fn().mockResolvedValue(undefined),
  editReply: vi.fn().mockResolvedValue(undefined),
});

const createMockMessage = (overrides: Record<string, unknown> = {}) =>
  ({
    author: { bot: false, id: "user-id" },
    channel: {
      type: ChannelType.GuildText,
      sendTyping: vi.fn().mockResolvedValue(undefined),
    },
    content: "Check this https://x.com/user/status/123456789",
    id: "msg-id",
    guildId: "guild-id",
    channelId: "channel-id",
    guild: null,
    suppressEmbeds: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue({ id: "reply-msg-id" }),
    ...overrides,
  }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("MessageHandler", () => {
  let processor: TweetProcessor;
  let twitterAdapter: ITwitterAdapter;
  let embedBuilder: DiscordEmbedBuilder;
  let mediaHandler: MediaHandler;
  let fileManager: IFileManager;
  let videoDownloader: IVideoDownloader;
  let replyLogger: IReplyLogger;
  let articlePostService: ArticlePostService;
  let handler: MessageHandler;

  beforeEach(() => {
    processor = {
      extractUrls: vi
        .fn()
        .mockReturnValue(["https://x.com/user/status/123456789"]),
      categorizeBySpoiler: vi.fn().mockReturnValue({
        normal: ["https://x.com/user/status/123456789"],
        spoiler: [],
      }),
      extractArticleId: vi.fn().mockReturnValue(undefined),
    } as unknown as TweetProcessor;

    twitterAdapter = {
      fetchTweet: vi.fn().mockResolvedValue(createMockTweet()),
    };

    embedBuilder = {
      build: vi.fn().mockReturnValue([]),
    } as unknown as DiscordEmbedBuilder;

    mediaHandler = {
      filterBySize: vi
        .fn()
        .mockResolvedValue({ downloadable: [], tooLarge: [] }),
    } as unknown as MediaHandler;

    fileManager = {
      createTempDirectory: vi.fn().mockResolvedValue("/tmp/test"),
      createDirectory: vi.fn().mockResolvedValue("/tmp/test/sub"),
      removeTempDirectory: vi.fn().mockResolvedValue(undefined),
      listFiles: vi.fn().mockResolvedValue([]),
    };

    videoDownloader = {
      download: vi.fn().mockResolvedValue(undefined),
    };

    replyLogger = {
      logReply: vi.fn().mockResolvedValue(undefined),
      addReply: vi.fn().mockResolvedValue(undefined),
      popReply: vi.fn().mockResolvedValue(null),
      deleteReply: vi.fn().mockResolvedValue(undefined),
    };

    articlePostService = {
      resolve: vi.fn(),
      remember: vi.fn().mockResolvedValue(undefined),
    } as unknown as ArticlePostService;

    handler = new MessageHandler(
      processor,
      twitterAdapter,
      embedBuilder,
      mediaHandler,
      fileManager,
      videoDownloader,
      replyLogger,
      "/tmp",
      undefined,
      undefined,
      articlePostService,
    );
  });

  describe("handleMessage - 無視すべきメッセージ", () => {
    it("ボットのメッセージは無視する", async () => {
      const client = createMockClient();
      const message = createMockMessage({
        author: { bot: true, id: "other-bot" },
      });

      await handler.handleMessage(client, message);

      expect(processor.extractUrls).not.toHaveBeenCalled();
    });

    it("自分自身（Bot）のメッセージは無視する", async () => {
      const client = createMockClient();
      const message = createMockMessage({
        author: { bot: false, id: "bot-user-id" },
      });

      await handler.handleMessage(client, message);

      expect(processor.extractUrls).not.toHaveBeenCalled();
    });

    it("Twitter URL が含まれないメッセージは処理しない", async () => {
      vi.mocked(processor.extractUrls).mockReturnValue([]);
      const client = createMockClient();
      const message = createMockMessage({ content: "just a normal message" });

      await handler.handleMessage(client, message);

      expect(twitterAdapter.fetchTweet).not.toHaveBeenCalled();
    });
  });

  describe("handleMessage - チャンネル設定チェック", () => {
    it("channelConfigService が不許可を返す場合 URL を処理しない", async () => {
      const channelConfigService = {
        isChannelAllowed: vi.fn().mockResolvedValue(false),
        performHealthCheck: vi.fn(),
      } as unknown as ChannelConfigService;

      const handlerWithConfig = new MessageHandler(
        processor,
        twitterAdapter,
        embedBuilder,
        mediaHandler,
        fileManager,
        videoDownloader,
        replyLogger,
        "/tmp",
        channelConfigService,
      );

      const client = createMockClient();
      const message = createMockMessage();

      await handlerWithConfig.handleMessage(client, message);

      expect(channelConfigService.isChannelAllowed).toHaveBeenCalledWith(
        "guild-id",
        "channel-id",
      );
      expect(twitterAdapter.fetchTweet).not.toHaveBeenCalled();
    });

    it("channelConfigService が許可を返す場合 URL を処理する", async () => {
      const channelConfigService = {
        isChannelAllowed: vi.fn().mockResolvedValue(true),
        getMaxUrlsPerMessage: vi.fn().mockResolvedValue(3),
        performHealthCheck: vi.fn(),
      } as unknown as ChannelConfigService;

      const handlerWithConfig = new MessageHandler(
        processor,
        twitterAdapter,
        embedBuilder,
        mediaHandler,
        fileManager,
        videoDownloader,
        replyLogger,
        "/tmp",
        channelConfigService,
      );

      const client = createMockClient();
      const message = createMockMessage();

      await handlerWithConfig.handleMessage(client, message);

      expect(twitterAdapter.fetchTweet).toHaveBeenCalledWith(
        "https://x.com/user/status/123456789",
      );
    });

    it("guildId がない場合（DM等）はチャンネル設定チェックをスキップして処理する", async () => {
      const channelConfigService = {
        isChannelAllowed: vi.fn().mockResolvedValue(false),
        getMaxUrlsPerMessage: vi.fn().mockResolvedValue(3),
        performHealthCheck: vi.fn(),
      } as unknown as ChannelConfigService;

      const handlerWithConfig = new MessageHandler(
        processor,
        twitterAdapter,
        embedBuilder,
        mediaHandler,
        fileManager,
        videoDownloader,
        replyLogger,
        "/tmp",
        channelConfigService,
      );

      const client = createMockClient();
      const message = createMockMessage({ guildId: null });

      await handlerWithConfig.handleMessage(client, message);

      expect(channelConfigService.isChannelAllowed).not.toHaveBeenCalled();
      expect(twitterAdapter.fetchTweet).toHaveBeenCalled();
    });
  });

  describe("handleMessage - ツイート処理", () => {
    it("ツイート取得に成功した場合 Embed を返信する", async () => {
      const client = createMockClient();
      const message = createMockMessage();

      await handler.handleMessage(client, message);

      expect(twitterAdapter.fetchTweet).toHaveBeenCalledWith(
        "https://x.com/user/status/123456789",
      );
      expect(message.reply).toHaveBeenCalledWith(
        expect.objectContaining({ allowedMentions: { repliedUser: false } }),
      );
      expect(replyLogger.logReply).toHaveBeenCalledWith(
        "msg-id",
        expect.objectContaining({ channelId: "channel-id" }),
      );
    });

    it("ツイート取得に失敗した場合（undefined）エラーメッセージを返信する", async () => {
      vi.mocked(twitterAdapter.fetchTweet).mockResolvedValue(undefined);
      const client = createMockClient();
      const message = createMockMessage();

      await handler.handleMessage(client, message);

      expect(message.reply).toHaveBeenCalledWith(
        expect.objectContaining({ content: "ツイートの取得に失敗しました。" }),
      );
      expect(message.suppressEmbeds).not.toHaveBeenCalled();
    });

    it("記事付きポストの取得時に記事IDと共有元ポストURLを保存する", async () => {
      vi.mocked(twitterAdapter.fetchTweet).mockResolvedValue(
        createMockTweet({
          article: {
            id: "2079240895006904322",
            title: "記事タイトル",
            previewText: "記事のプレビュー",
          },
        }),
      );
      const message = createMockMessage();

      await handler.handleMessage(createMockClient(), message);

      expect(articlePostService.remember).toHaveBeenCalledWith(
        "2079240895006904322",
        "https://x.com/test_user/status/123456789",
      );
      expect(message.suppressEmbeds).toHaveBeenCalledWith(true);
    });

    it("保存済みの記事本体URLを共有元ポストURLへ解決して取得する", async () => {
      const articleUrl = "https://x.com/i/article/2079240895006904322";
      vi.mocked(processor.extractUrls).mockReturnValue([articleUrl]);
      vi.mocked(processor.categorizeBySpoiler).mockReturnValue({
        normal: [articleUrl],
        spoiler: [],
      });
      vi.mocked(processor.extractArticleId).mockReturnValue("2079240895006904322");
      vi.mocked(articlePostService.resolve).mockResolvedValue("https://x.com/user/status/123");
      const message = createMockMessage({ content: articleUrl });

      await handler.handleMessage(createMockClient(), message);

      expect(articlePostService.resolve).toHaveBeenCalledWith("2079240895006904322");
      expect(twitterAdapter.fetchTweet).toHaveBeenCalledWith("https://x.com/user/status/123");
      expect(message.suppressEmbeds).toHaveBeenCalledWith(true);
    });

    it("未観測の記事本体URLでは共有元ポストURLを案内して元Embedを抑制しない", async () => {
      const articleUrl = "https://x.com/i/article/2079240895006904322";
      vi.mocked(processor.extractUrls).mockReturnValue([articleUrl]);
      vi.mocked(processor.categorizeBySpoiler).mockReturnValue({
        normal: [articleUrl],
        spoiler: [],
      });
      vi.mocked(processor.extractArticleId).mockReturnValue("2079240895006904322");
      vi.mocked(articlePostService.resolve).mockResolvedValue(undefined);
      const message = createMockMessage({ content: articleUrl });

      await handler.handleMessage(createMockClient(), message);

      expect(twitterAdapter.fetchTweet).not.toHaveBeenCalled();
      expect(message.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "記事情報を取得できませんでした。記事の共有元ポストURLを送信してください。",
        }),
      );
      expect(message.suppressEmbeds).not.toHaveBeenCalled();
    });
  });
  describe("handleMessage - スポイラー投稿のボタン待ち受け", () => {
    const setupSpoiler = () => {
      const url = "https://x.com/user/status/123456789";
      vi.mocked(processor.extractUrls).mockReturnValue([url]);
      vi.mocked(processor.categorizeBySpoiler).mockReturnValue({
        normal: [],
        spoiler: [url],
      });

      const replyMessage = createMockReplyMessage();
      const message = createMockMessage({
        reply: vi.fn().mockResolvedValue(replyMessage),
      });

      return { message, replyMessage };
    };

    it("グローバルな interactionCreate リスナーを登録しない", async () => {
      const { message } = setupSpoiler();
      const client = createMockClient();

      await handler.handleMessage(client, message);

      expect(client.on).not.toHaveBeenCalled();
    });

    it("返信メッセージ単位の collector で待ち受ける", async () => {
      const { message, replyMessage } = setupSpoiler();

      await handler.handleMessage(createMockClient(), message);

      expect(replyMessage.createMessageComponentCollector).toHaveBeenCalledTimes(1);
      expect(replyMessage.createMessageComponentCollector).toHaveBeenCalledWith(
        expect.objectContaining({ time: 24 * 60 * 60 * 1000 }),
      );
    });

    it("spoiler を複数投稿しても collector はメッセージごとに閉じる", async () => {
      const { message: first } = setupSpoiler();
      const { message: second } = setupSpoiler();
      const client = createMockClient();

      await handler.handleMessage(client, first);
      await handler.handleMessage(client, second);

      // リスナーが client へ積まれていないこと（リークしないこと）
      expect(client.on).not.toHaveBeenCalled();
    });

    it("ボタン押下でエフェメラル応答を返す", async () => {
      const { message, replyMessage } = setupSpoiler();
      await handler.handleMessage(createMockClient(), message);

      const interaction = createMockButtonInteraction();
      await replyMessage.emit("collect", interaction);

      expect(interaction.deferReply).toHaveBeenCalledWith(
        expect.objectContaining({ ephemeral: true }),
      );
      expect(interaction.editReply).toHaveBeenCalled();
    });

    it("メディア取得に失敗した場合はエラーメッセージを返す", async () => {
      const { message, replyMessage } = setupSpoiler();
      vi.mocked(fileManager.createTempDirectory).mockRejectedValue(
        new Error("disk full"),
      );
      await handler.handleMessage(createMockClient(), message);

      const interaction = createMockButtonInteraction();
      await replyMessage.emit("collect", interaction);

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: "コンテンツの取得に失敗しました。" }),
      );
    });

    it("期限切れでボタンを無効化する", async () => {
      const { message, replyMessage } = setupSpoiler();
      await handler.handleMessage(createMockClient(), message);

      expect(replyMessage.hasHandler("end")).toBe(true);
      await replyMessage.emit("end");

      expect(replyMessage.edit).toHaveBeenCalledTimes(1);
      const editArg = vi.mocked(replyMessage.edit).mock.calls[0][0] as {
        components: { components: { data: { disabled?: boolean; label?: string } }[] }[];
      };
      const expiredButton = editArg.components[0].components[0].data;
      expect(expiredButton.disabled).toBe(true);
      // 押せないボタンになるため、ラベル自体で期限切れと分かるようにする
      expect(expiredButton.label).toBe("表示期限が切れました");
    });

    it("期限切れ時にメッセージが削除済みでも例外を投げない", async () => {
      const { message, replyMessage } = setupSpoiler();
      await handler.handleMessage(createMockClient(), message);

      vi.mocked(replyMessage.edit).mockRejectedValue(new Error("Unknown Message"));

      await expect(replyMessage.emit("end")).resolves.not.toThrow();
    });
  });
});
