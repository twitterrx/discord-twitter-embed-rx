/**
 * 記事IDと共有元ポストURLの対応関係を保存するリポジトリ
 */
export interface IArticlePostRepository {
  findPostUrl(articleId: string): Promise<string | undefined>;
  savePostUrl(articleId: string, postUrl: string): Promise<void>;
}

/**
 * 記事本体URLと共有元ポストの対応関係を扱う
 */
export class ArticlePostService {
  constructor(private readonly repository: IArticlePostRepository) {}

  async resolve(articleId: string): Promise<string | undefined> {
    return this.repository.findPostUrl(articleId);
  }

  async remember(articleId: string, postUrl: string): Promise<void> {
    await this.repository.savePostUrl(articleId, postUrl);
  }
}
