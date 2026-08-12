import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#/db/init.js", () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

vi.mock("#/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { redis } from "#/db/init.js";
import { RedisArticlePostRepository } from "#/infrastructure/db/RedisArticlePostRepository.js";
import logger from "#/utils/logger.js";

describe("RedisArticlePostRepository", () => {
  const articleId = "2079240895006904322";
  const postUrl = "https://x.com/user/status/123";
  let repository: RedisArticlePostRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repository = new RedisArticlePostRepository();
  });

  it("記事IDに対応する共有元ポストURLを90日間保存する", async () => {
    await repository.savePostUrl(articleId, postUrl);

    expect(redis.set).toHaveBeenCalledWith(`app:article:${articleId}:post`, postUrl, {
      EX: 60 * 60 * 24 * 90,
    });
  });

  it("記事IDに対応する共有元ポストURLを取得する", async () => {
    vi.mocked(redis.get).mockResolvedValue(postUrl);

    await expect(repository.findPostUrl(articleId)).resolves.toBe(postUrl);
    expect(redis.get).toHaveBeenCalledWith(`app:article:${articleId}:post`);
  });

  it("対応関係が存在しない場合undefinedを返す", async () => {
    vi.mocked(redis.get).mockResolvedValue(null);

    await expect(repository.findPostUrl(articleId)).resolves.toBeUndefined();
  });

  it("Redisの読取に失敗しても例外を伝播しない", async () => {
    vi.mocked(redis.get).mockRejectedValue(new Error("Redis unavailable"));

    await expect(repository.findPostUrl(articleId)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      "記事の共有元ポストURL取得に失敗しました",
      expect.objectContaining({ articleId, error: "Redis unavailable" }),
    );
  });

  it("Redisの保存に失敗しても例外を伝播しない", async () => {
    vi.mocked(redis.set).mockRejectedValue(new Error("Redis unavailable"));

    await expect(repository.savePostUrl(articleId, postUrl)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      "記事の共有元ポストURL保存に失敗しました",
      expect.objectContaining({ articleId, postUrl, error: "Redis unavailable" }),
    );
  });
});
