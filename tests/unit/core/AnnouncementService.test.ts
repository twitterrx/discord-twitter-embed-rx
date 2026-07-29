import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Announcement } from "@rx-twitter/shared";

import type {
  GuildDeliveryTarget,
  IAnnouncementRepository,
  IAnnouncementSender,
} from "@/core/models/Announcement";
import { AnnouncementService } from "@/core/services/AnnouncementService";

vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const makeAnnouncement = (overrides: Partial<Announcement> = {}): Announcement => ({
  id: "ann-1",
  title: "メンテナンスのお知らせ",
  body: "本文",
  createdAt: "2026-07-30T00:00:00.000Z",
  ...overrides,
});

const makeTarget = (overrides: Partial<GuildDeliveryTarget> = {}): GuildDeliveryTarget => ({
  guildId: "guild-1",
  ownerId: "owner-1",
  target: { mode: "dm" },
  ...overrides,
});

describe("AnnouncementService", () => {
  let sender: {
    sendDirectMessage: ReturnType<typeof vi.fn>;
    sendToChannel: ReturnType<typeof vi.fn>;
  };
  let repository: {
    isDelivered: ReturnType<typeof vi.fn>;
    markDelivered: ReturnType<typeof vi.fn>;
    incrementAttempts: ReturnType<typeof vi.fn>;
    clearAttempts: ReturnType<typeof vi.fn>;
    recordDeadLetter: ReturnType<typeof vi.fn>;
  };
  let service: AnnouncementService;

  beforeEach(() => {
    sender = {
      sendDirectMessage: vi.fn().mockResolvedValue(undefined),
      sendToChannel: vi.fn().mockResolvedValue(undefined),
    };
    repository = {
      isDelivered: vi.fn().mockResolvedValue(false),
      markDelivered: vi.fn().mockResolvedValue(undefined),
      incrementAttempts: vi.fn().mockResolvedValue(1),
      clearAttempts: vi.fn().mockResolvedValue(undefined),
      recordDeadLetter: vi.fn().mockResolvedValue(undefined),
    };
    service = new AnnouncementService(
      sender as unknown as IAnnouncementSender,
      repository as unknown as IAnnouncementRepository
    );
  });

  it("mode=dm のとき DM を送り、成功後にのみ delivered を記録する", async () => {
    const announcement = makeAnnouncement();
    const summary = await service.deliver(announcement, [makeTarget()]);

    expect(sender.sendDirectMessage).toHaveBeenCalledWith("owner-1", announcement);
    expect(repository.markDelivered).toHaveBeenCalledWith("ann-1", "guild-1");
    expect(summary).toEqual({ delivered: 1, failed: 0, skipped: 0 });
  });

  it("mode=channel のとき指定チャンネルへ guildId 付きで投稿する", async () => {
    const announcement = makeAnnouncement();
    const target = makeTarget({ target: { mode: "channel", channelId: "ch-1" } });

    const summary = await service.deliver(announcement, [target]);

    expect(sender.sendToChannel).toHaveBeenCalledWith("ch-1", announcement, "guild-1");
    expect(sender.sendDirectMessage).not.toHaveBeenCalled();
    expect(summary).toEqual({ delivered: 1, failed: 0, skipped: 0 });
  });

  it("mode=channel だが channelId 未設定のときはオーナー DM にフォールバックする", async () => {
    const announcement = makeAnnouncement();
    const target = makeTarget({ target: { mode: "channel" } });

    const summary = await service.deliver(announcement, [target]);

    expect(sender.sendDirectMessage).toHaveBeenCalledWith("owner-1", announcement);
    expect(summary).toEqual({ delivered: 1, failed: 0, skipped: 0 });
  });

  it("配信済みギルドはスキップする（冪等性）", async () => {
    repository.isDelivered.mockResolvedValue(true);
    const announcement = makeAnnouncement();

    const summary = await service.deliver(announcement, [makeTarget()]);

    expect(sender.sendDirectMessage).not.toHaveBeenCalled();
    expect(repository.markDelivered).not.toHaveBeenCalled();
    expect(summary).toEqual({ delivered: 0, failed: 0, skipped: 1 });
  });

  it("DM 失敗時、フォールバックチャンネルがあればそちらへ送る", async () => {
    sender.sendDirectMessage.mockRejectedValue(new Error("Cannot send messages to this user"));
    const announcement = makeAnnouncement();
    const target = makeTarget({ target: { mode: "dm", channelId: "fallback-ch" } });

    const summary = await service.deliver(announcement, [target]);

    expect(sender.sendToChannel).toHaveBeenCalledWith("fallback-ch", announcement, "guild-1");
    expect(repository.markDelivered).toHaveBeenCalledWith("ann-1", "guild-1");
    expect(summary).toEqual({ delivered: 1, failed: 0, skipped: 0 });
  });

  it("DM 失敗かつフォールバック先が無い場合は delivered を記録せず失敗カウント", async () => {
    sender.sendDirectMessage.mockRejectedValue(new Error("Cannot send messages to this user"));
    const announcement = makeAnnouncement();

    const summary = await service.deliver(announcement, [makeTarget()]);

    expect(repository.markDelivered).not.toHaveBeenCalled();
    expect(summary).toEqual({ delivered: 0, failed: 1, skipped: 0 });
  });

  it("isDelivered が例外を投げても他ギルドの処理を止めない（エラー分離）", async () => {
    repository.isDelivered.mockImplementation(async (_id: string, guildId: string) => {
      if (guildId === "guild-throw") throw new Error("redis error");
      return false;
    });
    const announcement = makeAnnouncement();

    const summary = await service.deliver(announcement, [
      makeTarget({ guildId: "guild-throw", ownerId: "owner-throw" }),
      makeTarget({ guildId: "guild-ok", ownerId: "owner-ok" }),
    ]);

    expect(sender.sendDirectMessage).toHaveBeenCalledWith("owner-ok", announcement);
    expect(summary).toEqual({ delivered: 1, failed: 1, skipped: 0 });
  });

  it("複数ギルドの結果を集計する", async () => {
    repository.isDelivered.mockImplementation(async (_id: string, guildId: string) => guildId === "guild-skip");
    sender.sendDirectMessage.mockImplementation(async (userId: string) => {
      if (userId === "owner-fail") throw new Error("blocked");
    });
    const announcement = makeAnnouncement();

    const summary = await service.deliver(announcement, [
      makeTarget({ guildId: "guild-ok", ownerId: "owner-ok" }),
      makeTarget({ guildId: "guild-skip", ownerId: "owner-skip" }),
      makeTarget({ guildId: "guild-fail", ownerId: "owner-fail" }),
    ]);

    expect(summary).toEqual({ delivered: 1, failed: 1, skipped: 1 });
  });

  it("フォールバックのチャンネル送信も失敗した場合は delivered を記録せず失敗カウント", async () => {
    sender.sendDirectMessage.mockRejectedValue(new Error("dm blocked"));
    sender.sendToChannel.mockRejectedValue(new Error("channel error"));
    const announcement = makeAnnouncement();
    const target = makeTarget({ target: { mode: "dm", channelId: "fallback-ch" } });

    const summary = await service.deliver(announcement, [target]);

    expect(repository.markDelivered).not.toHaveBeenCalled();
    expect(summary).toEqual({ delivered: 0, failed: 1, skipped: 0 });
  });
});
