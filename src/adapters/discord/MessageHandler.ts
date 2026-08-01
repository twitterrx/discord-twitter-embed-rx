import { randomUUID } from "node:crypto";
import path from "node:path";

import { DEFAULT_EMBED_VERSION, DEFAULT_MAX_URLS_PER_MESSAGE } from "@rx-twitter/shared";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  ComponentType,
  DiscordAPIError,
  Message,
  EmbedBuilder,
  MessageFlags,
} from "discord.js";

import { ITwitterAdapter } from "@/adapters/twitter/BaseTwitterAdapter";
import { Tweet } from "@/core/models/Tweet";
import { ArticlePostService } from "@/core/services/ArticlePostService";
import { BanService } from "@/core/services/BanService";
import { ChannelConfigService } from "@/core/services/ChannelConfigService";
import { MediaHandler } from "@/core/services/MediaHandler";
import { TweetProcessor } from "@/core/services/TweetProcessor";
import { IReplyLogger } from "@/db/replyLogger";
import logger from "@/utils/logger";

import { resolveAttachmentLimit } from "./attachmentLimit";
import { ComponentsV2Builder } from "./ComponentsV2Builder";
import { DiscordEmbedBuilder } from "./EmbedBuilder";

/**
 * スポイラー展開ボタンの待ち受け時間
 * RedisReplyLogger の既定 TTL（24時間）と尺度を揃える
 */
const SPOILER_BUTTON_TTL_MS = 24 * 60 * 60 * 1000;

/** スポイラー展開ボタンのラベル */
const SPOILER_BUTTON_LABEL = "ネタバレを見る";

/** 待ち受け終了後に表示するラベル */
const SPOILER_BUTTON_EXPIRED_LABEL = "表示期限が切れました";

export interface IFileManager {
  createTempDirectory(): Promise<string>;
  createDirectory(dirPath: string): Promise<string>;
  removeTempDirectory(dir: string): Promise<void>;
  listFiles(dir: string): Promise<string[]>;
}

export interface IVideoDownloader {
  download(url: string, outputPath: string): Promise<void>;
}

/**
 * Discordメッセージハンドラー
 * ツイートURLを含むメッセージを処理してEmbedを返信
 */
export class MessageHandler {
  // P1: メッセージ受信時の低頻度 channels リフレッシュ用
  private readonly lastChannelCheck: Map<string, number> = new Map();
  private readonly CHANNEL_CHECK_INTERVAL = 5 * 60 * 1000; // 5分

  constructor(
    private readonly processor: TweetProcessor,
    private readonly twitterAdapter: ITwitterAdapter,
    private readonly embedBuilder: DiscordEmbedBuilder,
    private readonly componentsV2Builder: ComponentsV2Builder,
    private readonly mediaHandler: MediaHandler,
    private readonly fileManager: IFileManager,
    private readonly videoDownloader: IVideoDownloader,
    private readonly replyLogger: IReplyLogger,
    private readonly tmpDirBase: string,
    private readonly channelConfigService?: ChannelConfigService,
    private readonly banService?: BanService,
    private readonly articlePostService?: ArticlePostService,
    /** 運用側が設定した添付上限のキャップ。未指定なら guild のブーストレベルのみで決まる */
    private readonly mediaSizeCap?: number
  ) {}

  /**
   * メッセージを処理してツイートEmbedを返信
   * @param client Discordクライアント
   * @param message 受信メッセージ
   */
  async handleMessage(client: Client, message: Message): Promise<void> {
    const startTime = Date.now();

    // ボットメッセージや自身のメッセージは無視
    if (this.shouldIgnore(client, message)) {
      return;
    }

    // P0: ユーザー BAN チェック
    if (this.banService) {
      const isBanned = await this.banService.isUserBanned(message.author.id);
      if (isBanned) {
        logger.debug(`[MessageHandler] User ${message.author.id} is banned, ignoring message`);
        return;
      }
    }

    // P0: チャンネル許可チェック
    if (this.channelConfigService && message.guildId) {
      const isAllowed = await this.channelConfigService.isChannelAllowed(message.guildId, message.channelId);

      if (!isAllowed) {
        logger.debug(
          `[MessageHandler] Channel ${message.channelId} in guild ${message.guildId} is not whitelisted, ignoring`
        );
        return;
      }

      // P1: メッセージ受信時の低頻度 channels リフレッシュ
      if (message.guild) {
        this.maybeRefreshChannels(message.guild).catch((err) => {
          logger.error(`[MessageHandler] Failed to refresh channels for guild ${message.guildId}:`, err);
        });
      }
    }

    // URLを抽出
    const urls = this.processor.extractUrls(message.content);
    if (urls.length === 0) {
      return;
    }

    logger.info("Message received with Twitter URLs", {
      urlCount: urls.length,
    });

    // タイピングインジケーターを表示
    if (message.channel.type === ChannelType.GuildText) {
      await message.channel.sendTyping();
    }

    // スポイラータグの有無で分類
    const { spoiler, normal } = this.processor.categorizeBySpoiler(urls, message.content);

    logger.debug("URLs categorized", {
      normalUrls: normal.length,
      spoilerUrls: spoiler.length,
      messageId: message.id,
    });

    // 通常URLの処理
    const normalSuccessCount = await this.processUrls(client, message, normal, false);

    // スポイラーURLの処理
    const spoilerSuccessCount = await this.processUrls(client, message, spoiler, true);

    const duration = Date.now() - startTime;
    logger.info("Message processing completed", {
      messageId: message.id,
      totalUrls: urls.length,
      duration: `${duration}ms`,
    });

    // 1件以上展開できた場合のみ元メッセージの埋め込みを抑制
    if (normalSuccessCount + spoilerSuccessCount > 0) {
      await message.suppressEmbeds(true);
    }
  }

  /**
   * メッセージを無視すべきか判定
   * @param client Discordクライアント
   * @param message メッセージ
   * @returns 無視すべき場合true
   */
  private shouldIgnore(client: Client, message: Message): boolean {
    return message.author.bot || message.author.id === client.user?.id;
  }

  /**
   * URLリストを処理
   * @param client Discordクライアント
   * @param message 元メッセージ
   * @param urls URL配列
   * @param isSpoiler スポイラーかどうか
   */
  private async processUrls(client: Client, message: Message, urls: string[], isSpoiler: boolean): Promise<number> {
    if (urls.length === 0) return 0;

    const limit = await this.getUrlLimit(message.guildId);
    const accepted = urls.slice(0, limit);
    const ignoredCount = urls.length - accepted.length;

    logger.debug(
      `Processing ${accepted.length} ${isSpoiler ? "spoiler" : "normal"} URLs (limit: ${limit}, ignored: ${ignoredCount})`,
      {
        messageId: message.id,
        urlCount: accepted.length,
        limit,
        ignoredCount,
        isSpoiler,
      }
    );

    let successCount = 0;
    for (const url of accepted) {
      try {
        logger.debug("Processing single URL", { url, messageId: message.id, isSpoiler });
        if (await this.processSingleUrl(message, url, isSpoiler)) {
          successCount++;
        }
        logger.debug("URL processing completed", { url, messageId: message.id });
      } catch (error) {
        const errorDetails: Record<string, unknown> = {
          error: error instanceof Error ? error.message : String(error),
          messageId: message.id,
          url,
        };
        if (error instanceof DiscordAPIError) {
          errorDetails.httpStatus = error.status;
          errorDetails.code = error.code;
        }
        logger.error(`Failed to process URL ${url}`, errorDetails);
        const replyMessage = await message.reply({
          content: "ツイートの処理中にエラーが発生しました。",
          allowedMentions: { repliedUser: false },
        });
        await this.replyLogger.logReply(message.id, {
          replyIds: [replyMessage.id],
          channelId: message.channelId,
        });
      }
    }

    if (ignoredCount > 0) {
      await this.sendIgnoredNotice(message, ignoredCount, urls.length);
    }

    return successCount;
  }

  /**
   * URL処理上限を取得する
   * guildId が null またはサービス未注入の場合はデフォルト値を返す
   */
  private async getUrlLimit(guildId: string | null): Promise<number> {
    if (!guildId || !this.channelConfigService) return DEFAULT_MAX_URLS_PER_MESSAGE;
    return this.channelConfigService.getMaxUrlsPerMessage(guildId);
  }

  /**
   * 上限超過の通知を reply で送信し、約10秒後に自動削除する
   * 削除失敗時は warn ログのみ（FR-010）
   */
  private async sendIgnoredNotice(message: Message, ignoredCount: number, totalCount: number): Promise<void> {
    try {
      const notif = await message.reply({
        content: `${totalCount}件のうち${ignoredCount}件は上限超過のため無視しました。`,
        allowedMentions: { repliedUser: false },
      });
      setTimeout(() => {
        notif.delete().catch((err: Error) => {
          logger.warn("[MessageHandler] 上限超過通知の削除に失敗しました", { error: err.message });
        });
      }, 10_000);
    } catch (err) {
      logger.error("[MessageHandler] 上限超過通知の送信に失敗しました", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * 単一URLを処理
   * @param client Discordクライアント
   * @param message 元メッセージ
   * @param url ツイートURL
   * @param isSpoiler スポイラーかどうか
   */
  private async processSingleUrl(message: Message, url: string, isSpoiler: boolean): Promise<boolean> {
    let fetchUrl = url;
    const articleId = this.processor.extractArticleId(url);
    if (articleId) {
      const resolvedUrl = await this.articlePostService?.resolve(articleId);
      if (!resolvedUrl) {
        const replyMessage = await message.reply({
          content: "記事情報を取得できませんでした。記事の共有元ポストURLを送信してください。",
          allowedMentions: { repliedUser: false },
        });
        await this.replyLogger.logReply(message.id, {
          replyIds: [replyMessage.id],
          channelId: message.channelId,
        });
        return false;
      }
      fetchUrl = resolvedUrl;
    }

    // ツイートデータを取得
    const tweet = await this.twitterAdapter.fetchTweet(fetchUrl);

    if (!tweet) {
      const replyMessage = await message.reply({
        content: "ツイートの取得に失敗しました。",
        allowedMentions: { repliedUser: false },
      });
      await this.replyLogger.logReply(message.id, {
        replyIds: [replyMessage.id],
        channelId: message.channelId,
      });
      return false;
    }

    if (tweet.article?.id && this.articlePostService) {
      try {
        await this.articlePostService.remember(tweet.article.id, tweet.url);
      } catch (error) {
        logger.error("記事の共有元ポストURL記録に失敗しました", {
          articleId: tweet.article.id,
          postUrl: tweet.url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // guild 設定に応じて表示方式を出し分ける。guild 外（DM 等）は既定に従う
    const embedVersion = message.guildId
      ? ((await this.channelConfigService?.getEmbedVersion(message.guildId)) ?? DEFAULT_EMBED_VERSION)
      : DEFAULT_EMBED_VERSION;

    if (embedVersion === "v2") {
      await this.sendComponentsV2Message(message, tweet, isSpoiler);
      return true;
    }

    // Embedを作成
    const embeds = this.embedBuilder.build(tweet);

    // スポイラーの場合はボタン付きで送信（メディアは直接投稿しない）
    if (isSpoiler) {
      await this.sendSpoilerMessage(message, embeds, tweet);
    } else {
      // 通常の場合のみメディアを処理
      let mediaMessageIds: string[] = [];
      if (tweet.media.length > 0) {
        mediaMessageIds = await this.handleMedia(message, tweet, false);
      }
      const replyMessage = await message.reply({
        embeds,
        allowedMentions: { repliedUser: false },
      });
      await this.replyLogger.logReply(message.id, {
        replyIds: [replyMessage.id, ...mediaMessageIds],
        channelId: message.channelId,
      });
    }

    return true;
  }

  /**
   * Components v2 でツイートを送信する
   *
   * 動画を同じ Container 内へ収めるため、v1 のような別メッセージ投稿を行わない。
   * スポイラーは Container のぼかしで表現するため、ボタンと collector も使わない。
   */
  private async sendComponentsV2Message(message: Message, tweet: Tweet, isSpoiler: boolean): Promise<void> {
    // 動画は元の URL をそのままギャラリーへ埋め込む。
    // ダウンロードも添付も行わないため、アップロード上限の影響を受けず、
    // 一時ディレクトリの作成と後始末も不要になる。
    const videoUrls = this.mediaHandler.filterVideos(tweet.media).map((v) => v.url);

    const container = this.componentsV2Builder.build({ tweet, videoUrls, spoiler: isSpoiler });

    // IsComponentsV2 を立てたメッセージでは content も embeds も使えない
    const replyMessage = await message.reply({
      flags: MessageFlags.IsComponentsV2,
      components: [container],
      allowedMentions: { repliedUser: false },
    });

    await this.replyLogger.logReply(message.id, {
      replyIds: [replyMessage.id],
      channelId: message.channelId,
    });
  }

  /**
   * スポイラーメッセージを送信
   * @param client Discordクライアント
   * @param message 元メッセージ
   * @param embeds Embed配列
   * @param tweet ツイートデータ
   */
  private async sendSpoilerMessage(message: Message, embeds: EmbedBuilder[], tweet: Tweet): Promise<void> {
    const button = new ButtonBuilder()
      .setCustomId(`reveal_spoiler_${message.id}`)
      .setLabel(SPOILER_BUTTON_LABEL)
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

    const replyMessage = await message.reply({
      content: "これはネタバレです",
      allowedMentions: { repliedUser: false },
      components: [row],
    });

    await this.replyLogger.logReply(message.id, {
      replyIds: [replyMessage.id],
      channelId: message.channelId,
    });

    // ボタンの待ち受けは返信メッセージ単位の collector で行う。
    // グローバルな interactionCreate リスナーは解除経路がなく、
    // spoiler 投稿のたびに積み上がるため使わない（#550）。
    const collector = replyMessage.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: SPOILER_BUTTON_TTL_MS,
    });

    collector.on("collect", async (interaction) => {
      // エフェメラルで応答を遅延（動画ダウンロード中の待機用）
      await interaction.deferReply({ ephemeral: true });

      try {
        // 動画をダウンロードしてエフェメラルで送信
        const { attachments, largeVideoUrls } = await this.downloadVideoAttachments(tweet, message.guild);

        // 大きすぎるファイルのURLをcontentに含める
        const content =
          largeVideoUrls.length > 0 ? `ファイルサイズが大きいためURLで表示:\n${largeVideoUrls.join("\n")}` : undefined;

        await interaction.editReply({
          content,
          embeds,
          files: attachments,
          allowedMentions: { repliedUser: false },
        });
      } catch (error) {
        logger.error("Error revealing spoiler", { error: error instanceof Error ? error.message : String(error) });
        await interaction.editReply({
          content: "コンテンツの取得に失敗しました。",
          embeds,
          allowedMentions: { repliedUser: false },
        });
      }
    });

    // 待ち受け終了後はボタンを押せないため、期限切れと分かる表示に置き換える
    collector.on("end", async () => {
      const expiredButton = new ButtonBuilder()
        .setCustomId(`reveal_spoiler_${message.id}`)
        .setLabel(SPOILER_BUTTON_EXPIRED_LABEL)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true);

      try {
        await replyMessage.edit({
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(expiredButton)],
        });
      } catch (error) {
        // メッセージが既に削除されている場合など。表示の後始末なので握りつぶす
        logger.debug("Failed to disable expired spoiler button", {
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  /**
   * 動画をダウンロードして AttachmentBuilder を作成する
   *
   * v1 のスポイラー展開からのみ呼ばれる。v2 は元の URL を MediaGallery へ
   * 直接埋め込むため、ダウンロードも添付も行わない。
   *
   * @param tweet ツイートデータ
   * @param guild 添付上限の算出に用いるギルド（DM など guild 外では null）
   * @returns AttachmentBuilder配列と、添付できなかった動画のURL配列
   *          （上限超過とダウンロード失敗の両方を含む）
   */
  private async downloadVideoAttachments(
    tweet: Tweet,
    guild: Message["guild"]
  ): Promise<{ attachments: AttachmentBuilder[]; largeVideoUrls: string[] }> {
    const uniqueTmpDir = path.join(this.tmpDirBase, randomUUID());
    const maxFileSize = resolveAttachmentLimit(guild, this.mediaSizeCap);
    const attachments: AttachmentBuilder[] = [];

    try {
      await this.fileManager.createDirectory(uniqueTmpDir);

      // 動画のみファイルサイズでフィルタリング（画像はEmbedのサムネイルでのみ使用するためチェック不要）
      const allVideos = this.mediaHandler.filterVideos(tweet.media);
      const { downloadable, tooLarge } = await this.mediaHandler.filterBySize(allVideos, maxFileSize);

      // ダウンロード可能な動画を処理
      const failed = await this.downloadVideos(downloadable, uniqueTmpDir);

      // ダウンロードしたファイルからAttachmentBuilderを作成
      const files = await this.fileManager.listFiles(uniqueTmpDir);
      for (const file of files) {
        const filePath = path.join(uniqueTmpDir, file);
        attachments.push(new AttachmentBuilder(filePath, { name: file }));
      }

      // 添付できなかった動画の URL を収集する。
      // 上限超過だけでなく、ダウンロードに失敗したものも含める。
      // 含めないと、その動画は添付にもリンクにも現れず消える。
      const largeVideoUrls = [...tooLarge, ...failed].map((v) => v.url);

      return { attachments, largeVideoUrls };
    } finally {
      // 一時ディレクトリを削除（AttachmentBuilderがファイルを読み込んだ後）
      // 注意: discord.jsはファイルパスから直接読み込むので、送信前に削除するとエラーになる
      // そのため、ここでは削除せず、少し待ってから削除する
      setTimeout(async () => {
        try {
          await this.fileManager.removeTempDirectory(uniqueTmpDir);
        } catch (error) {
          logger.error("Error removing temp directory", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }, 30000); // 30秒後に削除
    }
  }

  /**
   * メディアを処理（動画のダウンロードと送信）
   * @param message 元メッセージ
   * @param tweet ツイートデータ
   * @param isSpoiler スポイラーかどうか
   * @returns 送信したメディアメッセージのID配列
   */
  private async handleMedia(message: Message, tweet: Tweet, isSpoiler: boolean): Promise<string[]> {
    const uniqueTmpDir = path.join(this.tmpDirBase, randomUUID());
    const maxFileSize = resolveAttachmentLimit(message.guild, this.mediaSizeCap);
    const messageIds: string[] = [];

    try {
      // 一時ディレクトリを作成（ユニークなパスで）
      await this.fileManager.createDirectory(uniqueTmpDir);

      // 動画のみファイルサイズでフィルタリング（画像はEmbedのサムネイルでのみ使用するためチェック不要）
      const allVideos = this.mediaHandler.filterVideos(tweet.media);
      const { downloadable, tooLarge } = await this.mediaHandler.filterBySize(allVideos, maxFileSize);

      // ダウンロード可能な動画を処理
      await this.downloadVideos(downloadable, uniqueTmpDir);

      // ダウンロードしたファイルを送信
      const files = await this.fileManager.listFiles(uniqueTmpDir);
      if (files.length > 0) {
        const mediaMessageId = await this.sendMediaAttachments(message, uniqueTmpDir, files, isSpoiler);
        if (mediaMessageId) {
          messageIds.push(mediaMessageId);
        }
      }

      // 大きすぎるファイルはURLを送信
      for (const video of tooLarge) {
        if (message.channel.type === ChannelType.GuildText) {
          const urlMessage = await message.channel.send(video.url);
          messageIds.push(urlMessage.id);
        }
      }

      return messageIds;
    } catch (error) {
      logger.error("Error handling media", { error: error instanceof Error ? error.message : String(error) });
      if (message.channel.type === ChannelType.GuildText) {
        await message.channel.send("ファイルの送信に失敗しました");
      }
      return messageIds;
    } finally {
      // 一時ディレクトリを削除
      await this.fileManager.removeTempDirectory(uniqueTmpDir);
    }
  }

  /**
   * 動画をダウンロード
   * @param videos 動画メディア配列
   * @param tmpDir 一時ディレクトリ
   */
  private async downloadVideos(videos: Tweet["media"], tmpDir: string): Promise<Tweet["media"]> {
    const failed: Tweet["media"] = [];

    await Promise.all(
      videos.map(async (video, index) => {
        const outputPath = path.join(tmpDir, `output${index + 1}.mp4`);
        try {
          logger.debug("Starting video download", { index, outputPath });
          await this.videoDownloader.download(video.url, outputPath);
          logger.debug(`Video download completed: output${index + 1}.mp4`);
        } catch (error) {
          logger.error(`Video download error`, {
            error: error instanceof Error ? error.message : String(error),
            index,
          });
          // 失敗した動画は添付できないため、呼び出し側で URL へ回せるよう返す
          failed.push(video);
        }
      })
    );

    return failed;
  }

  /**
   * メディアファイルをアタッチメントとして送信
   * @param message 元メッセージ
   * @param dir ディレクトリパス
   * @param files ファイル名配列
   * @param isSpoiler スポイラーかどうか
   * @returns 送信したメッセージID
   */
  private async sendMediaAttachments(
    message: Message,
    dir: string,
    files: string[],
    isSpoiler: boolean
  ): Promise<string | null> {
    if (files.length === 0) return null;

    const attachments = files.map((file) => {
      const filePath = path.join(dir, file);
      const name = isSpoiler ? "SPOILER_mediaFile.mp4" : "mediaFile.mp4";
      return new AttachmentBuilder(filePath, { name });
    });

    if (message.channel.type === ChannelType.GuildText) {
      const sentMessage = await message.channel.send({ files: attachments });
      return sentMessage.id;
    }
    return null;
  }

  /**
   * P1: メッセージ受信時の低頻度 channels リフレッシュ
   * 最後のチェックから5分以上経過している場合のみ実行
   */
  private async maybeRefreshChannels(guild: Message["guild"]): Promise<void> {
    if (!guild) return;

    const lastCheck = this.lastChannelCheck.get(guild.id) ?? 0;
    if (Date.now() - lastCheck < this.CHANNEL_CHECK_INTERVAL) {
      return;
    }

    this.lastChannelCheck.set(guild.id, Date.now());
    await this.checkAndRefreshChannels(guild);
  }

  /**
   * P1: channels の再取得チェックと実行
   * Redis の refresh リクエストキーを確認し、必要に応じて更新
   */
  private async checkAndRefreshChannels(guild: Message["guild"]): Promise<void> {
    if (!guild) return;

    try {
      const redis = (await import("@/db/init")).redis;

      // refresh リクエストキーの確認
      const shouldRefresh = await redis.get(`app:guild:${guild.id}:channels:refresh`);

      if (shouldRefresh) {
        // チャンネル情報を再取得
        const channels = await guild.channels.fetch();
        const textChannels = channels
          .filter((ch) => ch?.type === ChannelType.GuildText)
          .map((ch) => ({
            id: ch!.id,
            name: ch!.name,
          }));

        // Redis に保存
        await redis.setEx(`app:guild:${guild.id}:channels`, 60 * 60, JSON.stringify(textChannels));

        // refresh リクエストキーを削除
        await redis.del(`app:guild:${guild.id}:channels:refresh`);

        logger.info(
          `[MessageHandler] Refreshed channels for guild ${guild.id} by request (${textChannels.length} channels)`
        );
      }
    } catch (err) {
      logger.error(`[MessageHandler] Failed to check/refresh channels for guild ${guild.id}:`, err);
    }
  }
}
