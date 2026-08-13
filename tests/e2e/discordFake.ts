import { ChannelType, type Client, type Message } from "discord.js";
import { vi } from "vitest";

/**
 * Discord 境界のフェイク。
 *
 * discord.js の Client / Message は gateway 接続を前提とするため、E2E ではここを
 * 境界にする。Bot が「何を送ろうとしたか」を記録し、テストから検証できるようにする。
 */

/** message.reply() / channel.send() に渡されたペイロード */
export type SentPayload = Record<string, unknown> | string;

export interface FakeMessage {
  /** MessageHandler へ渡す Message 相当のオブジェクト */
  readonly message: Message;
  /** reply() に渡されたペイロードを送信順に記録したもの */
  readonly replies: SentPayload[];
  /** channel.send() に渡されたペイロードを送信順に記録したもの */
  readonly channelSends: SentPayload[];
  /** suppressEmbeds() が呼ばれたか（1件以上展開できたときだけ呼ばれる） */
  wasSuppressed: () => boolean;
}

export interface FakeMessageOptions {
  content: string;
  guildId?: string | null;
  channelId?: string;
  authorId?: string;
  messageId?: string;
}

export const createFakeClient = (): Client =>
  ({
    user: { id: "bot-user-id" },
    on: vi.fn(),
  }) as unknown as Client;

/**
 * Message のフェイクを作る
 *
 * guild は null にしている。MessageHandler は guild が無いときチャンネル一覧の
 * 再取得をスキップし、添付上限は既定へ倒れる。ここで見たいのは URL 受信から
 * 送信までの経路であり、ギルドのブーストレベル依存の分岐ではない。
 */
export const createFakeMessage = (options: FakeMessageOptions): FakeMessage => {
  const replies: SentPayload[] = [];
  const channelSends: SentPayload[] = [];
  let suppressed = false;

  let replyCounter = 0;

  const message = {
    id: options.messageId ?? "msg-id",
    content: options.content,
    guildId: options.guildId === undefined ? "guild-id" : options.guildId,
    channelId: options.channelId ?? "channel-id",
    guild: null,
    author: { bot: false, id: options.authorId ?? "user-id" },
    channel: {
      type: ChannelType.GuildText,
      sendTyping: vi.fn().mockResolvedValue(undefined),
      send: vi.fn((payload: SentPayload) => {
        channelSends.push(payload);
        return Promise.resolve({ id: `channel-msg-${channelSends.length}` });
      }),
    },
    reply: vi.fn((payload: SentPayload) => {
      replies.push(payload);
      replyCounter += 1;
      return Promise.resolve({
        id: `reply-msg-${replyCounter}`,
        edit: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        createMessageComponentCollector: vi.fn().mockReturnValue({ on: vi.fn() }),
      });
    }),
    suppressEmbeds: vi.fn((value: boolean) => {
      suppressed = value;
      return Promise.resolve(undefined);
    }),
  } as unknown as Message;

  return {
    message,
    replies,
    channelSends,
    wasSuppressed: () => suppressed,
  };
};
