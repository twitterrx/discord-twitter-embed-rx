import { APIEmbedField, EmbedBuilder } from "discord.js";

import { Tweet, TweetPollOption } from "@/core/models/Tweet";

import { buildTweetBody, formatPollOptions, truncate } from "./tweetText";

/**
 * Discord Embed作成を担当
 */
export class DiscordEmbedBuilder {
  private readonly embedColor = 9016025;
  private readonly br = "\n";
  private readonly maxTitleLength = 256;
  private readonly maxDescriptionLength = 4096;
  private readonly maxPollFieldLength = 1024;

  /**
   * ツイートからDiscord Embedを作成
   * @param tweet ツイートデータ
   * @returns Embed配列
   */
  build(tweet: Tweet): EmbedBuilder[] {
    // メディアがない場合は1つのEmbedのみ
    if (tweet.media.length === 0) {
      return [this.createSingleEmbed(tweet)];
    }

    // メディアがある場合：最初のEmbedにフルコンテンツ、残りは画像+URLのみ（ギャラリー表示用）
    return tweet.media.map((media, index) => {
      if (index === 0) {
        return this.createSingleEmbed(tweet).setImage(media.thumbnailUrl);
      }
      // 2枚目以降は同じURLと画像のみ（Discordが同一URLのEmbedをギャラリーとしてグループ化する）
      return new EmbedBuilder().setURL(tweet.url).setImage(media.thumbnailUrl);
    });
  }

  /**
   * 単一のEmbedを作成
   * @param tweet ツイートデータ
   * @returns EmbedBuilder
   */
  private createSingleEmbed(tweet: Tweet): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setAuthor({
        name: tweet.author.name,
        url: tweet.author.url,
        iconURL: tweet.author.iconUrl,
      })
      .setTitle(this.truncateTitle(tweet.article?.title ?? tweet.author.name))
      .setURL(tweet.url)
      .setColor(this.embedColor)
      .addFields(
        this.createField(":arrow_right_hook: replies", tweet.metrics.replies),
        this.createField(":hearts: likes", tweet.metrics.likes),
        this.createField(":arrows_counterclockwise: retweets", tweet.metrics.retweets)
      )
      .setTimestamp(tweet.timestamp);

    if (tweet.article?.imageUrl) {
      embed.setImage(tweet.article.imageUrl);
    }

    if (tweet.poll && tweet.poll.options.length > 0) {
      embed.addFields(this.createPollField(tweet.poll.options));
    }

    // 説明文の作成（引用ツイート情報を含む）。整形ロジックは v2 と共有する
    const description = buildTweetBody(tweet);

    if (description !== "") {
      embed.setDescription(truncate(description, this.maxDescriptionLength));
    }

    return embed;
  }

  /**
   * Embedタイトルを最大長に収める（超過時は末尾を省略）
   */
  private truncateTitle(text: string): string {
    return truncate(text, this.maxTitleLength);
  }

  /**
   * Embedフィールドを作成
   * @param name フィールド名
   * @param count 数値
   * @returns APIEmbedField
   */
  private createField(name: string, count: number): APIEmbedField {
    return {
      inline: true,
      name,
      value: String(count),
    };
  }

  /**
   * 投票フィールドを作成
   * @param options 投票の選択肢
   * @returns APIEmbedField
   */
  private createPollField(options: TweetPollOption[]): APIEmbedField {
    return {
      inline: false,
      name: ":bar_chart: poll",
      value: truncate(formatPollOptions(options), this.maxPollFieldLength),
    };
  }
}
