import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ArticlePostService,
  type IArticlePostRepository,
} from "#/core/services/ArticlePostService.js";

describe("ArticlePostService", () => {
  let repository: IArticlePostRepository;
  let service: ArticlePostService;

  beforeEach(() => {
    repository = {
      findPostUrl: vi.fn(),
      savePostUrl: vi.fn(),
    };
    service = new ArticlePostService(repository);
  });

  it("記事IDに対応する共有元ポストURLを返す", async () => {
    vi.mocked(repository.findPostUrl).mockResolvedValue("https://x.com/user/status/123");

    await expect(service.resolve("2079240895006904322")).resolves.toBe(
      "https://x.com/user/status/123",
    );
  });

  it("記事IDと共有元ポストURLを保存する", async () => {
    await service.remember("2079240895006904322", "https://x.com/user/status/123");

    expect(repository.savePostUrl).toHaveBeenCalledWith(
      "2079240895006904322",
      "https://x.com/user/status/123",
    );
  });
});
