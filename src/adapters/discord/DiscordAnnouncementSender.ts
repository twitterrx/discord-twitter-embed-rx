import type { Announcement } from "@rx-twitter/shared";
import { type Client, EmbedBuilder } from "discord.js";

import type { IAnnouncementSender } from "#/core/models/Announcement.js";

/** お知らせ Embed の色（Bot のブランドカラー） */
const ANNOUNCEMENT_EMBED_COLOR = 9016025;

/** Embed タイトルの最大長 */
const MAX_TITLE_LENGTH = 256;
/** Embed 説明文の最大長 */
const MAX_DESCRIPTION_LENGTH = 4096;

/** 文字列を最大長に収める（超過時は末尾を省略） */
const truncate = (text: string, max: number): string =>
  text.length <= max ? text : text.substring(0, max - 3) + "...";

/**
 * Discord クライアントを用いたお知らせ送信の実装（Adapter 層）
 */
export class DiscordAnnouncementSender implements IAnnouncementSender {
  constructor(private readonly client: Client) {}

  /**
   * ユーザーへ DM でお知らせを送信する
   */
  async sendDirectMessage(userId: string, announcement: Announcement): Promise<void> {
    const user = await this.client.users.fetch(userId);
    await user.send({ embeds: [this.buildEmbed(announcement)] });
  }

  /**
   * チャンネルへお知らせを投稿する。
   * 誤送信防止のため、チャンネルが expectedGuildId のギルドに属することを検証する。
   */
  async sendToChannel(channelId: string, announcement: Announcement, expectedGuildId: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      throw new Error(`Channel ${channelId} is not a sendable text channel`);
    }
    // 別ギルドのチャンネルへの誤送信を防ぐ
    const channelGuildId = "guildId" in channel ? channel.guildId : null;
    if (channelGuildId !== expectedGuildId) {
      throw new Error(`Channel ${channelId} belongs to guild ${channelGuildId ?? "none"}, expected ${expectedGuildId}`);
    }
    await channel.send({ embeds: [this.buildEmbed(announcement)] });
  }

  /**
   * お知らせから Embed を構築する
   */
  private buildEmbed(announcement: Announcement): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle(truncate(announcement.title, MAX_TITLE_LENGTH))
      .setDescription(truncate(announcement.body, MAX_DESCRIPTION_LENGTH))
      .setColor(ANNOUNCEMENT_EMBED_COLOR)
      .setFooter({ text: "お知らせ" })
      .setTimestamp(new Date(announcement.createdAt));
  }
}
