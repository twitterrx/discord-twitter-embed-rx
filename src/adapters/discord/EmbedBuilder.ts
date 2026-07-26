import { APIEmbedField, EmbedBuilder } from "discord.js";

import { Tweet, TweetPollOption } from "@/core/models/Tweet";

/**
 * Discord Embed作成を担当
 */
export class DiscordEmbedBuilder {
  private readonly embedColor = 9016025;
  private readonly quotePrefix = "QT: ";
  private readonly br = "\n";
  private readonly maxTitleLength = 256;
  private readonly maxDescriptionLength = 4096;
  private readonly maxPollFieldLength = 1024;
  private readonly articleOnlyPattern = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/i\/article\/[0-9]+(?:[?#]\S*)?$/;

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

    // 説明文の作成（引用ツイート情報を含む）
    const tweetText = tweet.article && this.articleOnlyPattern.test(tweet.text.trim()) ? "" : tweet.text;
    let description = this.convertMentionsToLinks(tweetText);
    if (tweet.article) {
      description +=
        (description === "" ? "" : this.br + this.br) + this.convertMentionsToLinks(tweet.article.previewText);
    }
    if (tweet.quote) {
      const quoteAuthorLink = this.createMentionLink(tweet.quote.author.id);
      const quoteTextWithLinks = this.convertMentionsToLinks(tweet.quote.text);
      const quoteText = this.quotePrefix + quoteAuthorLink + " " + quoteTextWithLinks;
      const quoteUrl = "(" + tweet.quote.url + ")";
      description += this.br + this.br + quoteText + this.br + quoteUrl;
    }

    if (description !== "") {
      embed.setDescription(this.truncateDescription(description));
    }

    return embed;
  }

  /**
   * Embedタイトルを最大長に収める（超過時は末尾を省略）
   */
  private truncateTitle(text: string): string {
    if (text.length <= this.maxTitleLength) {
      return text;
    }
    return text.substring(0, this.maxTitleLength - 3) + "...";
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
    const value = options
      .map((option, index) => {
        return `${index + 1}. ${option.label} — ${option.votes} votes (${option.percentage}%)`;
      })
      .join(this.br);

    return {
      inline: false,
      name: ":bar_chart: poll",
      value: this.truncatePollField(value),
    };
  }

  /**
   * ＠メンションをクリック可能なリンクに変換
   * @param text 変換対象のテキスト
   * @returns ＠メンションがリンク化されたテキスト
   */
  private convertMentionsToLinks(text: string): string {
    // URL部分を一時的に抽出してプレースホルダーに置換
    const urlPattern = /https?:\/\/[^\s]+/g;
    const urls: string[] = [];
    const textWithPlaceholders = text.replace(urlPattern, (url) => {
      urls.push(url);
      return `__URL_PLACEHOLDER_${urls.length - 1}__`;
    });

    // @メンションをマークダウンリンクに変換（連続する@の最後のみ変換、全角@にも対応）
    const transformed = textWithPlaceholders.replace(/([@＠]*)[@＠]([A-Za-z0-9_]{1,15})\b/g, (_, prefix, username) => {
      return prefix + this.createMentionLink(username);
    });

    // プレースホルダーを元のURLに戻す
    return transformed.replace(/__URL_PLACEHOLDER_(\d+)__/g, (_, index) => urls[parseInt(index)]);
  }

  /**
   * ユーザー名のMarkdown装飾を無効化したリンクを作成
   * @param username Xのユーザー名
   * @returns ユーザーページへのMarkdownリンク
   */
  private createMentionLink(username: string): string {
    return `[\`@${username}\`](https://x.com/${username})`;
  }

  /**
   * 説明文を最大長に収める（超過時は末尾を省略）
   * @param text 説明文
   * @returns 切り詰められた説明文
   */
  private truncateDescription(text: string): string {
    if (text.length <= this.maxDescriptionLength) {
      return text;
    }
    return text.substring(0, this.maxDescriptionLength - 3) + "...";
  }

  /**
   * 投票フィールドを最大長に収める（超過時は末尾を省略）
   * @param text 投票フィールドの文字列
   * @returns 切り詰められた投票フィールド
   */
  private truncatePollField(text: string): string {
    if (text.length <= this.maxPollFieldLength) {
      return text;
    }
    return text.substring(0, this.maxPollFieldLength - 3) + "...";
  }
}
