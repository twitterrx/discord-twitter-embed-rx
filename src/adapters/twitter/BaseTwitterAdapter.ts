import { Tweet, TweetAuthor, TweetMetrics } from "#/core/models/Tweet.js";

/**
 * Twitterデータ取得のための統一インターフェース
 */
export interface ITwitterAdapter {
  fetchTweet(url: string): Promise<Tweet | undefined>;
}

/**
 * 外部APIのレスポンスを共通のTweetモデルに変換するための基底クラス
 */
export abstract class BaseTwitterAdapter {
  /**
   * URLを適切なAPI URLに変換
   */
  protected abstract transformUrl(url: string): string;

  /**
   * 外部APIレスポンスをTweetモデルに変換
   */
  protected abstract convertToTweet(data: unknown, depth?: number): Tweet | undefined;

  /**
   * 共通のヘルパーメソッド: 作者情報の作成
   */
  protected createAuthor(id: string, name: string, screenName: string, iconUrl: string): TweetAuthor {
    return {
      id: screenName,
      name: `${name}(@${screenName})`,
      url: `https://x.com/${screenName}`,
      iconUrl,
    };
  }

  /**
   * 共通のヘルパーメソッド: メトリクス情報の作成
   */
  protected createMetrics(replies: number, likes: number, retweets: number): TweetMetrics {
    return {
      replies,
      likes,
      retweets,
    };
  }

  /**
   * 共通のヘルパーメソッド: 動画かどうかの判定
   */
  protected isVideoUrl(url: string): boolean {
    return url.endsWith(".mp4");
  }

  /**
   * 共通のヘルパーメソッド: メディアタイプの判定
   */
  protected getMediaType(url: string): "photo" | "video" {
    return this.isVideoUrl(url) ? "video" : "photo";
  }
}
