import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  FileBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
} from "discord.js";

import type { Tweet } from "@/core/models/Tweet";

import { buildTweetBody, formatPollOptions, truncate } from "./tweetText";

/** Embed と同じアクセントカラーを引き継ぐ */
const ACCENT_COLOR = 9016025;

/** Container 全体のテキスト上限。Discord の制約に合わせる */
const MAX_BODY_LENGTH = 3000;

/** 投票表示の上限 */
const MAX_POLL_LENGTH = 1024;

/** MediaGallery に載せる画像の上限 */
const MAX_GALLERY_ITEMS = 10;

export interface ComponentsV2Input {
  tweet: Tweet;
  /** 添付済み動画のファイル名（Container 内で attachment:// として参照する） */
  attachedFileNames?: string[];
  /** 上限を超えたためリンクで案内する動画URL */
  oversizedVideoUrls?: string[];
  /** ネタバレとして伏せるか */
  spoiler?: boolean;
}

/**
 * Discord Components v2 でのツイート表現を組み立てる
 *
 * 従来の Embed と異なり、動画を同じ Container 内に収められるため
 * 別メッセージへの分離が不要になる。
 */
export class ComponentsV2Builder {
  /**
   * ツイートから Container を作成する
   */
  build(input: ComponentsV2Input): ContainerBuilder {
    const { tweet, attachedFileNames = [], oversizedVideoUrls = [], spoiler = false } = input;

    // スポイラーは Container 全体へ適用する。MediaGallery / File だけに
    // 立てると、テキストのみのツイートで指定が消える
    const container = new ContainerBuilder().setAccentColor(ACCENT_COLOR).setSpoiler(spoiler);

    this.addHeader(container, tweet);

    const body = truncate(buildTweetBody(tweet), MAX_BODY_LENGTH);
    if (body !== "") {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(body));
    }

    if (tweet.poll && tweet.poll.options.length > 0) {
      const poll = truncate(formatPollOptions(tweet.poll.options), MAX_POLL_LENGTH);
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`### :bar_chart: poll\n${poll}`));
    }

    const gallery = this.createGallery(tweet, spoiler);
    if (gallery) {
      container.addMediaGalleryComponents(gallery);
    }

    for (const fileName of attachedFileNames) {
      container.addFileComponents(new FileBuilder().setURL(`attachment://${fileName}`).setSpoiler(spoiler));
    }

    const linkRow = this.createOversizedVideoRow(oversizedVideoUrls);
    if (linkRow) {
      container.addActionRowComponents(linkRow);
    }

    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(this.createMetrics(tweet)));

    return container;
  }

  /**
   * 著者情報とツイートへのリンクを追加する
   *
   * アイコンがあれば Section のサムネイルとして添える。Section の accessory は
   * 必須で、持たない Section は toJSON() が CombinedError を投げるため、
   * アイコンが無い場合は通常の TextDisplay として追加する。
   * FxTwitter の avatar_url は nullable で、Adapter が空文字へ変換するため到達しうる。
   */
  private addHeader(container: ContainerBuilder, tweet: Tweet): void {
    const title = tweet.article?.title ?? tweet.author.name;
    const heading = truncate(
      `### [${title}](${tweet.url})\n[${tweet.author.name}](${tweet.author.url})`,
      MAX_POLL_LENGTH
    );

    if (!tweet.author.iconUrl) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(heading));
      return;
    }

    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(heading))
        .setThumbnailAccessory((thumbnail) => thumbnail.setURL(tweet.author.iconUrl))
    );
  }

  /**
   * 画像をギャラリーとしてまとめる
   *
   * 従来は同一URLの Embed を並べて Discord のギャラリー結合に頼っていたが、
   * v2 では MediaGallery で明示的に表現できる。
   */
  private createGallery(tweet: Tweet, spoiler: boolean): MediaGalleryBuilder | undefined {
    const urls = tweet.media.filter((m) => m.type === "photo").map((m) => m.thumbnailUrl);

    if (tweet.article?.imageUrl) {
      urls.unshift(tweet.article.imageUrl);
    }

    if (urls.length === 0) {
      return undefined;
    }

    const items = urls
      .slice(0, MAX_GALLERY_ITEMS)
      .map((url) => new MediaGalleryItemBuilder().setURL(url).setSpoiler(spoiler));

    return new MediaGalleryBuilder().addItems(...items);
  }

  /**
   * 上限を超えた動画をリンクボタンとして並べる
   */
  private createOversizedVideoRow(urls: string[]): ActionRowBuilder<ButtonBuilder> | undefined {
    if (urls.length === 0) {
      return undefined;
    }

    const buttons = urls.slice(0, 5).map((url, index) =>
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setURL(url)
        .setLabel(urls.length === 1 ? "動画を開く" : `動画を開く (${index + 1})`)
    );

    return new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
  }

  /**
   * メトリクスと投稿日時
   */
  private createMetrics(tweet: Tweet): string {
    const unixSeconds = Math.floor(tweet.timestamp.getTime() / 1000);
    return [
      `:arrow_right_hook: ${tweet.metrics.replies}`,
      `:hearts: ${tweet.metrics.likes}`,
      `:arrows_counterclockwise: ${tweet.metrics.retweets}`,
      `<t:${unixSeconds}:f>`,
    ].join("　");
  }
}
