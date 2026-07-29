import { beforeEach, describe, expect, it, vi } from "vitest";

import { ANNOUNCEMENT_MAX_DELIVERY_ATTEMPTS, ANNOUNCEMENT_STREAM_FIELD, type Announcement } from "@rx-twitter/shared";

vi.mock("@/db/init", () => ({
  redis: {
    duplicate: vi.fn(() => ({ on: vi.fn(), connect: vi.fn(), isOpen: true })),
  },
}));

vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

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

  it("getStatus は初期状態で running=false を返す", () => {
    expect(consumer.getStatus().running).toBe(false);
  });
});
