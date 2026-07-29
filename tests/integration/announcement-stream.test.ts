import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ANNOUNCEMENT_STREAM_FIELD,
  ANNOUNCEMENT_STREAM_KEY,
  type Announcement,
} from "@rx-twitter/shared";

vi.mock("@/utils/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { redis } from "@/db/init";
import { RedisAnnouncementRepository } from "@/infrastructure/db/RedisAnnouncementRepository";
import { AnnouncementStreamConsumer } from "@/infrastructure/stream/AnnouncementStreamConsumer";

/**
 * 実 Redis を用いた Streams 配信の統合テスト。
 *
 * 実行には Redis が必要なため、明示フラグ RUN_REDIS_INTEGRATION=1 のときのみ実行する。
 *   RUN_REDIS_INTEGRATION=1 REDIS_URL=redis://127.0.0.1:6390 \
 *     npx vitest run tests/integration/announcement-stream.test.ts
 */
const RUN = process.env.RUN_REDIS_INTEGRATION === "1";

/** 非同期条件が満たされるまで待機する */
const waitForAsync = async (
  cond: () => Promise<boolean>,
  timeoutMs = 8000,
  intervalMs = 50
): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitForAsync timed out");
};

const makeAnnouncement = (overrides: Partial<Announcement> = {}): Announcement => ({
  id: "int-ann-1",
  title: "統合テストのお知らせ",
  body: "本文",
  createdAt: "2026-07-30T00:00:00.000Z",
  ...overrides,
});

const streamLen = async (): Promise<number> => redis.xLen(ANNOUNCEMENT_STREAM_KEY);

describe.skipIf(!RUN)("AnnouncementStreamConsumer (integration, real Redis)", () => {
  beforeAll(async () => {
    if (!redis.isOpen) await redis.connect();
  });

  afterAll(async () => {
    await redis.del(ANNOUNCEMENT_STREAM_KEY).catch(() => undefined);
    if (redis.isOpen) await redis.quit();
  });

  /** ストリーム（および所属する consumer group）を初期化する */
  const resetStream = async (): Promise<void> => {
    await redis.del(ANNOUNCEMENT_STREAM_KEY).catch(() => undefined);
  };

  it("XADD したお知らせを consumer が受信し、ACK してストリームから消える", async () => {
    await resetStream();
    const received: Announcement[] = [];
    const consumer = new AnnouncementStreamConsumer(
      async (a) => {
        received.push(a);
      },
      new RedisAnnouncementRepository(),
      "int-consumer-ok"
    );
    await consumer.start();

    try {
      const ann = makeAnnouncement();
      await redis.xAdd(ANNOUNCEMENT_STREAM_KEY, "*", {
        [ANNOUNCEMENT_STREAM_FIELD]: JSON.stringify(ann),
      });

      await waitForAsync(async () => received.length === 1);
      expect(received[0]).toEqual(ann);

      // ACK + XDEL でストリームが空になる
      await waitForAsync(async () => (await streamLen()) === 0);
    } finally {
      await consumer.shutdown();
    }
  });

  it("不正な JSON エントリはハンドラを呼ばず dead-letter として ACK される", async () => {
    await resetStream();
    const received: Announcement[] = [];
    const consumer = new AnnouncementStreamConsumer(
      async (a) => {
        received.push(a);
      },
      new RedisAnnouncementRepository(),
      "int-consumer-poison"
    );
    await consumer.start();

    try {
      await redis.xAdd(ANNOUNCEMENT_STREAM_KEY, "*", {
        [ANNOUNCEMENT_STREAM_FIELD]: "{ broken json",
      });

      await waitForAsync(async () => (await streamLen()) === 0);
      expect(received).toHaveLength(0);
    } finally {
      await consumer.shutdown();
    }
  });

  it("claimGuild は同一ギルドで一度だけ true、release 後は再 claim 可能", async () => {
    const repo = new RedisAnnouncementRepository();
    const id = `int-claim-${Date.now()}`;

    expect(await repo.claimGuild(id, "g1")).toBe(true);
    expect(await repo.claimGuild(id, "g1")).toBe(false);
    await repo.releaseGuild(id, "g1");
    expect(await repo.claimGuild(id, "g1")).toBe(true);

    await redis.del(`app:announcement:${id}:delivered`).catch(() => undefined);
  });

  it("incrementAttempts はインクリメントし、clearAttempts でリセットされる", async () => {
    const repo = new RedisAnnouncementRepository();
    const sid = `int-attempts-${Date.now()}`;

    expect(await repo.incrementAttempts(sid)).toBe(1);
    expect(await repo.incrementAttempts(sid)).toBe(2);
    await repo.clearAttempts(sid);
    expect(await repo.incrementAttempts(sid)).toBe(1);

    await redis.del(`app:announcement:attempts:${sid}`).catch(() => undefined);
  });
});
