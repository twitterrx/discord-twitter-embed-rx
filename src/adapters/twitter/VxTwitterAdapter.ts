import { BaseTwitterAdapter, ITwitterAdapter } from "#/adapters/twitter/BaseTwitterAdapter.js";
import type { Tweet, TweetArticle, TweetMedia } from "#/core/models/Tweet.js";
import { extractArticleId } from "#/core/services/TweetProcessor.js";
import logger from "#/utils/logger.js";
import { VxTwitterApi, VxTwitterServerError } from "#/vxtwitter/api.js";
import type { VxTwitter } from "#/vxtwitter/vxtwitter.js";

/**
 * VxTwitter API アダプター
 */
export class VxTwitterAdapter extends BaseTwitterAdapter implements ITwitterAdapter {
  private readonly api: VxTwitterApi;
  private readonly URL_REGEX = /\/(x|twitter)/;

  constructor(api?: VxTwitterApi) {
    super();
    this.api = api || new VxTwitterApi();
  }

  protected transformUrl(url: string): string {
    return url.replace(this.URL_REGEX, "/api.vxtwitter");
  }

  async fetchTweet(url: string): Promise<Tweet | undefined> {
    try {
      const apiUrl = this.transformUrl(url);
      const data = await this.api.getPostInformation(apiUrl);

      if (!data) {
        return undefined;
      }

      return this.convertToTweet(data);
    } catch (error) {
      // 5xxエラーの場合は上位でフォールバック処理させるため再スロー
      if (error instanceof VxTwitterServerError) {
        logger.warn("VxTwitterAdapter: Server error, will try fallback", { status: error.status });
        throw error;
      }
      logger.error("VxTwitterAdapter: Failed to fetch tweet", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  protected convertToTweet(data: VxTwitter, depth: number = 0): Tweet | undefined {
    const vxData = data;

    // 引用ツイートの変換（1階層まで）
    let quote: Tweet | undefined;
    if (vxData.qrt && depth < 1) {
      quote = this.convertToTweet(vxData.qrt, depth + 1);
    }

    // メディアの変換: media_extended を優先、なければ mediaURLs でフォールバック
    const media: TweetMedia[] =
      vxData.media_extended && vxData.media_extended.length > 0
        ? vxData.media_extended.map((extended) => ({
            url: extended.url,
            thumbnailUrl: extended.thumbnail_url || extended.url,
            type:
              extended.type === "video" || extended.type === "gif" || extended.type === "animated_gif"
                ? "video"
                : "photo",
          }))
        : vxData.mediaURLs && vxData.mediaURLs.length > 0
          ? vxData.mediaURLs.map((url) => ({
              url,
              thumbnailUrl: url,
              type: this.getMediaType(url),
            }))
          : [];

    const pollOptions = vxData.pollData?.options?.flatMap((option) => {
      if (option.name === undefined || option.votes === undefined || option.percent === undefined) {
        return [];
      }

      return [
        {
          label: option.name,
          votes: option.votes,
          percentage: option.percent,
        },
      ];
    });
    const poll = pollOptions && pollOptions.length > 0 ? { options: pollOptions } : undefined;
    const article = this.convertArticle(vxData.article, vxData.text);

    return {
      url: vxData.tweetURL,
      author: this.createAuthor(
        vxData.user_screen_name,
        vxData.user_name,
        vxData.user_screen_name,
        vxData.user_profile_image_url
      ),
      text: vxData.text,
      metrics: this.createMetrics(vxData.replies, vxData.likes, vxData.retweets),
      media,
      article,
      poll,
      quote,
      timestamp: new Date(vxData.date),
    };
  }

  private convertArticle(data: VxTwitter["article"], text: string): TweetArticle | undefined {
    if (!data?.title || !data.preview_text) {
      return undefined;
    }

    return {
      id: extractArticleId(text),
      title: data.title,
      previewText: data.preview_text,
      imageUrl: data.image ?? undefined,
    };
  }
}
