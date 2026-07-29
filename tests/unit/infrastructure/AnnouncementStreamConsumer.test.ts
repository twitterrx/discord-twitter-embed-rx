import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ANNOUNCEMENT_CONSUMER_GROUP,
  ANNOUNCEMENT_MAX_DELIVERY_ATTEMPTS,
  ANNOUNCEMENT_STREAM_FIELD,
  ANNOUNCEMENT_STREAM_KEY,
  type Announcement,
} from "@rx-twitter/shared";

vi.mock("@/db/init", () => ({
  redis: {
    duplicate: vi.fn(() => ({ on: vi.fn(), connect: vi.fn(), isOpen: true })),
  },
}));

vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { redis } from "@/db/init";
import type { IAnnouncementRepository } from "@/core/models/Announcement";
import { AnnouncementStreamConsumer } from "@/infrastructure/stream/AnnouncementStreamConsumer";

const validAnnouncement: Announcement = {
  id: "ann-1",
  title: "お知らせ",
  body: "本文",
  createdAt: "2026-07-30T00:00:00.000Z",
};

const entryFields = (announcement: unknown): Record<string, string> => ({
  [ANNOUNCEMENT_STREAM_FIELD]: JSON.stringify(announcement),
});

const waitFor = async (cond: () => boolean, timeoutMs = 2000, intervalMs = 10): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timed out");
};

describe("AnnouncementStreamConsumer.processEntry", () => {
  let handler: ReturnType<typeof vi.fn>;
  let onDeadLetter: ReturnType<typeof vi.fn>;
  let repository: {
    isDelivered: ReturnType<typeof vi.fn>;
    markDelivered: ReturnType<typeof vi.fn>;
    incrementAttempts: ReturnType<typeof vi.fn>;
    clearAttempts: ReturnType<typeof vi.fn>;
    recordDeadLetter: ReturnType<typeof vi.fn>;
  };
  let consumer: AnnouncementStreamConsumer;

  beforeEach(() => {
    handler = vi.fn().mockResolvedValue(undefined);
    onDeadLetter = vi.fn().mockResolvedValue(undefined);
    repository = {
      isDelivered: vi.fn(),
      markDelivered: vi.fn(),
      incrementAttempts: vi.fn().mockResolvedValue(1),
      clearAttempts: vi.fn().mockResolvedValue(undefined),
      recordDeadLetter: vi.fn().mockResolvedValue(undefined),
    };
    consumer = new AnnouncementStreamConsumer(handler, repository as unknown as IAnnouncementRepository, {
      consumerName: "test-consumer",
      onDeadLetter,
    });
  });

  it("正常なエントリはハンドラを呼び、成功したら ack を返し試行回数を消去する", async () => {
    const decision = await consumer.processEntry("1-0", entryFields(validAnnouncement));

    expect(handler).toHaveBeenCalledWith(validAnnouncement);
    expect(repository.clearAttempts).toHaveBeenCalledWith("1-0");
    expect(decision).toBe("ack");
  });

  it("ハンドラが失敗したら retry を返す（ack しない）", async () => {
    handler.mockRejectedValue(new Error("delivery failed"));

    const decision = await consumer.processEntry("1-0", entryFields(validAnnouncement));

    expect(decision).toBe("retry");
    expect(repository.clearAttempts).not.toHaveBeenCalled();
  });

  it("announcement フィールドが無いエントリは DLQ 保存後に ack", async () => {
    const decision = await consumer.processEntry("1-0", { other: "x" });

    expect(handler).not.toHaveBeenCalled();
    expect(repository.recordDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ streamEntryId: "1-0", reason: expect.stringContaining("missing") })
    );
    expect(onDeadLetter).toHaveBeenCalled();
    expect(decision).toBe("ack");
  });

  it("不正な JSON は DLQ 保存後に ack", async () => {
    const decision = await consumer.processEntry("1-0", { [ANNOUNCEMENT_STREAM_FIELD]: "{ broken" });

    expect(handler).not.toHaveBeenCalled();
    expect(repository.recordDeadLetter).toHaveBeenCalled();
    expect(decision).toBe("ack");
  });

  it("検証に失敗するお知らせは DLQ 保存後に ack", async () => {
    const decision = await consumer.processEntry(
      "1-0",
      entryFields({ id: "x", title: "", body: "b", createdAt: "2026-07-30T00:00:00.000Z" })
    );

    expect(handler).not.toHaveBeenCalled();
    expect(repository.recordDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining("validation") })
    );
    expect(decision).toBe("ack");
  });

  it("試行回数が上限を超えたら配信せず DLQ 保存後に ack（お知らせ本体も通知）", async () => {
    repository.incrementAttempts.mockResolvedValue(ANNOUNCEMENT_MAX_DELIVERY_ATTEMPTS + 1);

    const decision = await consumer.processEntry("1-0", entryFields(validAnnouncement));

    expect(handler).not.toHaveBeenCalled();
    expect(repository.recordDeadLetter).toHaveBeenCalledWith(
      expect.objectContaining({ reason: expect.stringContaining("max delivery attempts") })
    );
    expect(onDeadLetter).toHaveBeenCalledWith(expect.objectContaining({ announcement: validAnnouncement }));
    expect(decision).toBe("ack");
  });

  it("DLQ 保存に失敗した場合は retry を返し、元エントリを消さない", async () => {
    repository.recordDeadLetter.mockRejectedValue(new Error("redis OOM"));

    const decision = await consumer.processEntry("1-0", { [ANNOUNCEMENT_STREAM_FIELD]: "{ broken" });

    expect(decision).toBe("retry");
  });

  it("試行上限超過で DLQ 保存に失敗した場合は clearAttempts せず retry", async () => {
    repository.incrementAttempts.mockResolvedValue(ANNOUNCEMENT_MAX_DELIVERY_ATTEMPTS + 1);
    repository.recordDeadLetter.mockRejectedValue(new Error("redis OOM"));

    const decision = await consumer.processEntry("1-0", entryFields(validAnnouncement));

    expect(decision).toBe("retry");
    expect(repository.clearAttempts).not.toHaveBeenCalled();
  });

  it("getStatus は初期状態で running=false / healthy=false を返す", () => {
    const status = consumer.getStatus();
    expect(status.running).toBe(false);
    expect(status.healthy).toBe(false);
  });
});

/**
 * consumer group 生成・pending 再取得・新規読み取り・ACK など、
 * Redis クライアントを介する内部メソッドをモッククライアント注入で検証する。
 */
describe("AnnouncementStreamConsumer internals", () => {
  let handler: ReturnType<typeof vi.fn>;
  let repository: {
    isDelivered: ReturnType<typeof vi.fn>;
    markDelivered: ReturnType<typeof vi.fn>;
    incrementAttempts: ReturnType<typeof vi.fn>;
    clearAttempts: ReturnType<typeof vi.fn>;
    recordDeadLetter: ReturnType<typeof vi.fn>;
  };
  let client: {
    xGroupCreate: ReturnType<typeof vi.fn>;
    xAutoClaim: ReturnType<typeof vi.fn>;
    xReadGroup: ReturnType<typeof vi.fn>;
    xAck: ReturnType<typeof vi.fn>;
    xDel: ReturnType<typeof vi.fn>;
    isOpen: boolean;
  };
  let consumer: AnnouncementStreamConsumer;

  beforeEach(() => {
    handler = vi.fn().mockResolvedValue(undefined);
    repository = {
      isDelivered: vi.fn(),
      markDelivered: vi.fn(),
      incrementAttempts: vi.fn().mockResolvedValue(1),
      clearAttempts: vi.fn().mockResolvedValue(undefined),
      recordDeadLetter: vi.fn().mockResolvedValue(undefined),
    };
    client = {
      xGroupCreate: vi.fn().mockResolvedValue("OK"),
      xAutoClaim: vi.fn().mockResolvedValue({ messages: [] }),
      xReadGroup: vi.fn().mockResolvedValue(null),
      xAck: vi.fn().mockResolvedValue(1),
      xDel: vi.fn().mockResolvedValue(1),
      isOpen: true,
    };
    consumer = new AnnouncementStreamConsumer(handler, repository as unknown as IAnnouncementRepository, {
      consumerName: "internal-consumer",
    });
    // モッククライアントを注入（start() を経由せず内部メソッドを直接検証する）
    (consumer as unknown as { client: typeof client }).client = client;
  });

  const call = (method: string, ...args: unknown[]): Promise<unknown> =>
    (consumer as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method](...args);

  describe("ensureGroup", () => {
    it("グループを作成する", async () => {
      await call("ensureGroup");
      expect(client.xGroupCreate).toHaveBeenCalledWith(ANNOUNCEMENT_STREAM_KEY, ANNOUNCEMENT_CONSUMER_GROUP, "0", {
        MKSTREAM: true,
      });
    });

    it("BUSYGROUP エラーは無視する", async () => {
      client.xGroupCreate.mockRejectedValue(new Error("BUSYGROUP Consumer Group name already exists"));
      await expect(call("ensureGroup")).resolves.toBeUndefined();
    });

    it("その他のエラーは伝播する", async () => {
      client.xGroupCreate.mockRejectedValue(new Error("boom"));
      await expect(call("ensureGroup")).rejects.toThrow("boom");
    });
  });

  describe("reclaimPending", () => {
    it("XAUTOCLAIM で取得したエントリを処理し、ACK + XDEL する", async () => {
      client.xAutoClaim.mockResolvedValue({
        messages: [{ id: "5-0", message: entryFields(validAnnouncement) }, null],
      });

      await call("reclaimPending");

      expect(handler).toHaveBeenCalledWith(validAnnouncement);
      expect(client.xAck).toHaveBeenCalledWith(ANNOUNCEMENT_STREAM_KEY, ANNOUNCEMENT_CONSUMER_GROUP, "5-0");
      expect(client.xDel).toHaveBeenCalledWith(ANNOUNCEMENT_STREAM_KEY, "5-0");
    });
  });

  describe("readNew", () => {
    it("XREADGROUP のエントリを処理して ACK する", async () => {
      client.xReadGroup.mockResolvedValue([
        { name: ANNOUNCEMENT_STREAM_KEY, messages: [{ id: "6-0", message: entryFields(validAnnouncement) }] },
      ]);

      await call("readNew");

      expect(handler).toHaveBeenCalledWith(validAnnouncement);
      expect(client.xAck).toHaveBeenCalledWith(ANNOUNCEMENT_STREAM_KEY, ANNOUNCEMENT_CONSUMER_GROUP, "6-0");
    });

    it("応答が null なら何もしない", async () => {
      client.xReadGroup.mockResolvedValue(null);
      await call("readNew");
      expect(handler).not.toHaveBeenCalled();
      expect(client.xAck).not.toHaveBeenCalled();
    });

    it("ハンドラ失敗時は ACK しない（pending に残す）", async () => {
      handler.mockRejectedValue(new Error("delivery failed"));
      client.xReadGroup.mockResolvedValue([
        { name: ANNOUNCEMENT_STREAM_KEY, messages: [{ id: "7-0", message: entryFields(validAnnouncement) }] },
      ]);

      await call("readNew");

      expect(client.xAck).not.toHaveBeenCalled();
    });
  });

  describe("getStatus", () => {
    it("client 接続状態を connected に反映する", () => {
      expect(consumer.getStatus().connected).toBe(true);
      client.isOpen = false;
      expect(consumer.getStatus().connected).toBe(false);
    });
  });

  describe("shutdown", () => {
    it("running を false にする", async () => {
      const quitClient = { ...client, quit: vi.fn().mockResolvedValue(undefined) };
      (consumer as unknown as { client: typeof quitClient }).client = quitClient;
      await consumer.shutdown();
      expect(consumer.getStatus().running).toBe(false);
      expect(quitClient.quit).toHaveBeenCalled();
    });
  });

  describe("start/shutdown lifecycle", () => {
    it("start() で group 用意・ループ起動し、shutdown で停止する", async () => {
      const rich = {
        on: vi.fn(),
        isOpen: false,
        connect: vi.fn().mockImplementation(async () => {
          rich.isOpen = true; // 実 node-redis は connect 後に isOpen=true になる
        }),
        xGroupCreate: vi.fn().mockResolvedValue("OK"),
        xAutoClaim: vi.fn().mockResolvedValue({ messages: [] }),
        // BLOCK を模擬してループをペースさせる（ビジーループ防止）
        xReadGroup: vi.fn().mockImplementation(() => new Promise((r) => setTimeout(() => r(null), 20))),
        xAck: vi.fn(),
        xDel: vi.fn(),
        quit: vi.fn().mockResolvedValue(undefined),
      };
      (redis.duplicate as ReturnType<typeof vi.fn>).mockReturnValue(rich);

      const c = new AnnouncementStreamConsumer(handler, repository as unknown as IAnnouncementRepository, {
        consumerName: "lifecycle",
        blockMs: 5,
        reclaimMinIdleMs: 5,
      });

      await c.start();
      expect(rich.connect).toHaveBeenCalled();
      expect(rich.xGroupCreate).toHaveBeenCalled();
      expect(c.getStatus().running).toBe(true);
      expect(c.getStatus().healthy).toBe(true);

      await c.shutdown();
      expect(c.getStatus().running).toBe(false);
      expect(rich.quit).toHaveBeenCalled();
    });

    it("ループ内 NOGROUP エラーで consumer group を再作成する", async () => {
      let autoClaimCalls = 0;
      const rich = {
        on: vi.fn(),
        connect: vi.fn().mockResolvedValue(undefined),
        isOpen: true,
        xGroupCreate: vi.fn().mockResolvedValue("OK"),
        xAutoClaim: vi.fn().mockImplementation(async () => {
          autoClaimCalls++;
          if (autoClaimCalls === 1) throw new Error("NOGROUP No such consumer group 'bot-workers'");
          return { messages: [] };
        }),
        // BLOCK を模擬してループをペースさせる（ビジーループ防止）
        xReadGroup: vi.fn().mockImplementation(() => new Promise((r) => setTimeout(() => r(null), 20))),
        xAck: vi.fn(),
        xDel: vi.fn(),
        quit: vi.fn().mockResolvedValue(undefined),
      };
      (redis.duplicate as ReturnType<typeof vi.fn>).mockReturnValue(rich);

      const c = new AnnouncementStreamConsumer(handler, repository as unknown as IAnnouncementRepository, {
        consumerName: "nogroup",
        blockMs: 5,
        reclaimMinIdleMs: 5,
      });

      await c.start();
      // start() で 1 回、ループの NOGROUP 回復で 2 回目の作成が呼ばれる
      await waitFor(() => rich.xGroupCreate.mock.calls.length >= 2);
      await c.shutdown();

      expect(rich.xGroupCreate.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
