import { BaseTwitterAdapter, ITwitterAdapter } from "#/adapters/twitter/BaseTwitterAdapter.js";
import type { Tweet, TweetArticle, TweetMedia } from "#/core/models/Tweet.js";
import { FxTwitterApi } from "#/fxtwitter/api.js";
import type { SocialThreadOutput, APITwitterStatus } from "#/fxtwitter/generated/model/index.js";
import logger from "#/utils/logger.js";

/**
 * FxTwitter API アダプター
 */
export class FxTwitterAdapter extends BaseTwitterAdapter implements ITwitterAdapter {
  private readonly api: FxTwitterApi;
  private readonly URL_REGEX = /\/(x|twitter)/;

  constructor(api?: FxTwitterApi) {
    super();
    this.api = api || new FxTwitterApi();
  }

  protected transformUrl(url: string): string {
    return url.replace(this.URL_REGEX, "/api.fxtwitter");
  }

  async fetchTweet(url: string): Promise<Tweet | undefined> {
    try {
      const apiUrl = this.transformUrl(url);
      const response = await this.api.getPostInformation(apiUrl);

      if (!response || !response.status) {
        return undefined;
      }

      if (isTombstone(response.status)) {
        logger.debug("FxTwitterAdapter: Post unavailable (tombstone)", { url });
        return undefined;
      }

      if (!isTwitterStatus(response.status)) {
        // 現行エンドポイントは Twitter 専用のため、ここに来るのは想定外
        const candidate = response.status as { type?: unknown; provider?: unknown };
        logger.warn("FxTwitterAdapter: Non-Twitter status received", {
          url,
          type: candidate.type,
          provider: candidate.provider,
        });
        return undefined;
      }

      return this.convertToTweet(response.status);
    } catch (error) {
      logger.error("FxTwitterAdapter: Failed to fetch tweet", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  protected convertToTweet(data: APITwitterStatus, depth: number = 0): Tweet | undefined {
    const fxData = data;

    // 引用ツイートの変換（1階層まで）
    let quote: Tweet | undefined;
    if (fxData.quote && isTwitterStatus(fxData.quote) && depth < 1) {
      quote = this.convertToTweet(fxData.quote, depth + 1);
    }

    // メディアの変換: media.all を優先、なければ photos + videos でフォールバック
    const media: TweetMedia[] = [];
    if (fxData.media?.all) {
      for (const item of fxData.media.all) {
        const thumbnail = "thumbnail_url" in item ? item.thumbnail_url : undefined;
        media.push({
          url: item.url,
          thumbnailUrl: thumbnail || item.url,
          type: item.type === "video" || item.type === "gif" ? "video" : "photo",
        });
      }
    } else if (fxData.media) {
      // Fallback: photos + videos
      const photos = fxData.media.photos || [];
      const videos = fxData.media.videos || [];
      for (const photo of photos) {
        media.push({
          url: photo.url,
          thumbnailUrl: photo.url,
          type: "photo",
        });
      }
      for (const video of videos) {
        media.push({
          url: video.url,
          thumbnailUrl: video.thumbnail_url || video.url,
          type: "video",
        });
      }
    }

    const poll =
      fxData.poll && fxData.poll.choices.length > 0
        ? {
            options: fxData.poll.choices.map((choice) => ({
              label: choice.label,
              votes: choice.count,
              percentage: choice.percentage,
            })),
          }
        : undefined;
    const article = this.convertArticle(fxData.article);

    const author = fxData.author;
    return {
      url: fxData.url,
      author: this.createAuthor(author.screen_name, author.name, author.screen_name, author.avatar_url ?? ""),
      text: fxData.text,
      metrics: this.createMetrics(fxData.replies, fxData.likes, fxData.reposts),
      media,
      article,
      poll,
      quote,
      timestamp: new Date(fxData.created_at),
    };
  }

  private convertArticle(data: APITwitterStatus["article"]): TweetArticle | undefined {
    if (!data) {
      return undefined;
    }

    const cover = data.cover_media.media_info;
    const imageUrl = cover.__typename === "ApiImage" ? cover.original_img_url : cover.media_url_https;

    return {
      id: data.id,
      title: data.title,
      previewText: data.preview_text,
      imageUrl,
    };
  }
}

type TwitterStatusData = APITwitterStatus;

/** status 系のレスポンスに共通して存在する判別用フィールド */
type StatusDiscriminator = { type?: unknown; provider?: unknown };

const asDiscriminator = (status: SocialThreadOutput["status"]): StatusDiscriminator | undefined =>
  status && typeof status === "object" ? (status as StatusDiscriminator) : undefined;

/**
 * 投稿が取得できないことを示す tombstone かどうか
 * 削除・非公開・凍結などで発生する。日常的な事象として扱う。
 */
function isTombstone(status: SocialThreadOutput["status"]): boolean {
  return asDiscriminator(status)?.type === "tombstone";
}

/**
 * Twitter の status かどうか
 *
 * 判別子 type は Bluesky / Mastodon / Instagram / Threads の status でも "status" を取るため、
 * type だけでは Twitter を特定できない。provider まで確認する。
 *
 * なお他プラットフォームの provider はスキーマ上 string 型のため、TypeScript は
 * この比較で union を絞り込めない。実行時の正しさと、型述語が事実と一致することを担保する。
 */
function isTwitterStatus(status: SocialThreadOutput["status"]): status is TwitterStatusData {
  const candidate = asDiscriminator(status);
  return candidate?.type === "status" && candidate.provider === "twitter";
}
