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
  createdAt: "2026-07-29T00:00:00.000Z",
};

const entryFields = (announcement: unknown): Record<string, string> => ({
  [ANNOUNCEMENT_STREAM_FIELD]: JSON.stringify(announcement),
});

describe("AnnouncementStreamConsumer.processEntry", () => {
  let handler: ReturnType<typeof vi.fn>;
  let repository: {
    claimGuild: ReturnType<typeof vi.fn>;
    releaseGuild: ReturnType<typeof vi.fn>;
    incrementAttempts: ReturnType<typeof vi.fn>;
    clearAttempts: ReturnType<typeof vi.fn>;
  };
  let consumer: AnnouncementStreamConsumer;

  beforeEach(() => {
    handler = vi.fn().mockResolvedValue(undefined);
    repository = {
      claimGuild: vi.fn(),
      releaseGuild: vi.fn(),
      incrementAttempts: vi.fn().mockResolvedValue(1),
      clearAttempts: vi.fn().mockResolvedValue(undefined),
    };
    consumer = new AnnouncementStreamConsumer(handler, repository as unknown as IAnnouncementRepository, "test-consumer");
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

  it("announcement フィールドが無いエントリは dead-letter として ack", async () => {
    const decision = await consumer.processEntry("1-0", { other: "x" });

    expect(handler).not.toHaveBeenCalled();
    expect(decision).toBe("ack");
  });

  it("不正な JSON は dead-letter として ack", async () => {
    const decision = await consumer.processEntry("1-0", { [ANNOUNCEMENT_STREAM_FIELD]: "{ broken" });

    expect(handler).not.toHaveBeenCalled();
    expect(decision).toBe("ack");
  });

  it("検証に失敗するお知らせは dead-letter として ack", async () => {
    const decision = await consumer.processEntry("1-0", entryFields({ id: "x", title: "", body: "b", createdAt: "2026-07-29T00:00:00.000Z" }));

    expect(handler).not.toHaveBeenCalled();
    expect(decision).toBe("ack");
  });

  it("試行回数が上限を超えたら配信せず dead-letter として ack", async () => {
    repository.incrementAttempts.mockResolvedValue(ANNOUNCEMENT_MAX_DELIVERY_ATTEMPTS + 1);

    const decision = await consumer.processEntry("1-0", entryFields(validAnnouncement));

    expect(handler).not.toHaveBeenCalled();
    expect(repository.clearAttempts).toHaveBeenCalledWith("1-0");
    expect(decision).toBe("ack");
  });
});
