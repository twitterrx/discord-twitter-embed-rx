import type { IArticlePostRepository } from "@/core/services/ArticlePostService";
import { redis } from "@/db/init";
import logger from "@/utils/logger";

/**
 * 記事IDと共有元ポストURLの対応関係をRedisへ保存する
 */
export class RedisArticlePostRepository implements IArticlePostRepository {
  private readonly ttl: number;

  constructor(ttl: number = 60 * 60 * 24 * 90) {
    this.ttl = ttl;
  }

  async findPostUrl(articleId: string): Promise<string | undefined> {
    try {
      return (await redis.get(this.createKey(articleId))) ?? undefined;
    } catch (error) {
      logger.error("記事の共有元ポストURL取得に失敗しました", {
        articleId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  async savePostUrl(articleId: string, postUrl: string): Promise<void> {
    try {
      await redis.set(this.createKey(articleId), postUrl, { EX: this.ttl });
    } catch (error) {
      logger.error("記事の共有元ポストURL保存に失敗しました", {
        articleId,
        postUrl,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private createKey(articleId: string): string {
    return `app:article:${articleId}:post`;
  }
}
