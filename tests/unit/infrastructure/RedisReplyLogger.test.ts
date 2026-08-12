import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReplyInfo } from "#/db/replyLogger.js";

vi.mock("#/db/init.js", () => ({
  redis: {
    set: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
  },
}));

vi.mock("#/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// モック後にインポート
import { redis } from "#/db/init.js";
import { RedisReplyLogger } from "#/infrastructure/db/RedisReplyLogger.js";

describe("RedisReplyLogger", () => {
  let logger: RedisReplyLogger;
  const TTL = 86400; // 1日（デフォルト）

  beforeEach(() => {
    logger = new RedisReplyLogger();
    vi.clearAllMocks();
  });

  describe("logReply", () => {
    it("返信情報を Redis に保存する", async () => {
      const info: ReplyInfo = { replyIds: ["reply-1"], channelId: "channel-1" };

      await logger.logReply("msg-1", info);

      expect(redis.set).toHaveBeenCalledWith(
        "replymap:msg-1",
        JSON.stringify(info),
        { EX: TTL },
      );
    });

    it("カスタム TTL を使用する", async () => {
      const customLogger = new RedisReplyLogger(3600);
      const info: ReplyInfo = { replyIds: ["reply-1"], channelId: "channel-1" };

      await customLogger.logReply("msg-1", info);

      expect(redis.set).toHaveBeenCalledWith(
        "replymap:msg-1",
        JSON.stringify(info),
        { EX: 3600 },
      );
    });
  });

  describe("addReply", () => {
    it("既存エントリがある場合 replyIds に追加する", async () => {
      const existing: ReplyInfo = {
        replyIds: ["reply-1"],
        channelId: "channel-1",
      };
      vi.mocked(redis.get).mockResolvedValue(JSON.stringify(existing));

      await logger.addReply("msg-1", "reply-2");

      expect(redis.set).toHaveBeenCalledWith(
        "replymap:msg-1",
        JSON.stringify({
          replyIds: ["reply-1", "reply-2"],
          channelId: "channel-1",
        }),
        { EX: TTL },
      );
    });

    it("既存エントリがない場合は何もしない", async () => {
      vi.mocked(redis.get).mockResolvedValue(null);

      await logger.addReply("msg-1", "reply-2");

      expect(redis.set).not.toHaveBeenCalled();
    });
  });

  describe("popReply", () => {
    it("存在するエントリを取得して返す", async () => {
      const info: ReplyInfo = { replyIds: ["reply-1"], channelId: "channel-1" };
      vi.mocked(redis.get).mockResolvedValue(JSON.stringify(info));

      const result = await logger.popReply("msg-1");

      expect(redis.get).toHaveBeenCalledWith("replymap:msg-1");
      expect(result).toEqual(info);
    });

    it("エントリが存在しない場合 null を返す", async () => {
      vi.mocked(redis.get).mockResolvedValue(null);

      const result = await logger.popReply("msg-1");

      expect(result).toBeNull();
    });

    it("JSON パースに失敗した場合 null を返す", async () => {
      vi.mocked(redis.get).mockResolvedValue("invalid-json{{{");

      const result = await logger.popReply("msg-1");

      expect(result).toBeNull();
    });
  });

  describe("deleteReply", () => {
    it("指定したエントリを Redis から削除する", async () => {
      await logger.deleteReply("msg-1");

      expect(redis.del).toHaveBeenCalledWith("replymap:msg-1");
    });
  });
});
