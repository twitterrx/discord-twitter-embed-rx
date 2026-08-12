import type { Client } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Announcement } from "@rx-twitter/shared";

import { DiscordAnnouncementSender } from "#/adapters/discord/DiscordAnnouncementSender.js";

const makeAnnouncement = (overrides: Partial<Announcement> = {}): Announcement => ({
  id: "ann-1",
  title: "メンテナンスのお知らせ",
  body: "本文です",
  createdAt: "2026-07-29T00:00:00.000Z",
  ...overrides,
});

describe("DiscordAnnouncementSender", () => {
  let usersFetch: ReturnType<typeof vi.fn>;
  let channelsFetch: ReturnType<typeof vi.fn>;
  let client: Client;
  let sender: DiscordAnnouncementSender;

  beforeEach(() => {
    usersFetch = vi.fn();
    channelsFetch = vi.fn();
    client = {
      users: { fetch: usersFetch },
      channels: { fetch: channelsFetch },
    } as unknown as Client;
    sender = new DiscordAnnouncementSender(client);
  });

  describe("sendDirectMessage", () => {
    it("ユーザーを fetch して DM に Embed を送信する", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      usersFetch.mockResolvedValue({ send });

      await sender.sendDirectMessage("owner-1", makeAnnouncement());

      expect(usersFetch).toHaveBeenCalledWith("owner-1");
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0].embeds).toHaveLength(1);
    });

    it("DM 送信に失敗した場合は例外を伝播する", async () => {
      const send = vi.fn().mockRejectedValue(new Error("Cannot send messages to this user"));
      usersFetch.mockResolvedValue({ send });

      await expect(sender.sendDirectMessage("owner-1", makeAnnouncement())).rejects.toThrow();
    });
  });

  describe("sendToChannel", () => {
    it("期待ギルドに属するテキストチャンネルへ Embed を投稿する", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      channelsFetch.mockResolvedValue({ isTextBased: () => true, guildId: "guild-1", send });

      await sender.sendToChannel("ch-1", makeAnnouncement(), "guild-1");

      expect(channelsFetch).toHaveBeenCalledWith("ch-1");
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][0].embeds).toHaveLength(1);
    });

    it("チャンネルが見つからない場合は例外を投げる", async () => {
      channelsFetch.mockResolvedValue(null);

      await expect(sender.sendToChannel("ch-1", makeAnnouncement(), "guild-1")).rejects.toThrow();
    });

    it("テキストベースでないチャンネルの場合は例外を投げる", async () => {
      channelsFetch.mockResolvedValue({ isTextBased: () => false });

      await expect(sender.sendToChannel("ch-1", makeAnnouncement(), "guild-1")).rejects.toThrow();
    });

    it("別ギルドのチャンネルへは送信せず例外を投げる（誤送信防止）", async () => {
      const send = vi.fn().mockResolvedValue(undefined);
      channelsFetch.mockResolvedValue({ isTextBased: () => true, guildId: "other-guild", send });

      await expect(sender.sendToChannel("ch-1", makeAnnouncement(), "guild-1")).rejects.toThrow();
      expect(send).not.toHaveBeenCalled();
    });
  });
});
