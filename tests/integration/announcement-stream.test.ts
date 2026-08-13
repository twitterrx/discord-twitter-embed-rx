import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ANNOUNCEMENT_DLQ_STREAM_KEY,
  ANNOUNCEMENT_STREAM_FIELD,
  ANNOUNCEMENT_STREAM_KEY,
  type Announcement,
} from "@rx-twitter/shared";

vi.mock("#/utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { redis } from "#/db/init.js";
import { RedisAnnouncementRepository } from "#/infrastructure/db/RedisAnnouncementRepository.js";
import { AnnouncementStreamConsumer } from "#/infrastructure/stream/AnnouncementStreamConsumer.js";

/**
 * 実 Redis を用いた Streams 配信の統合テスト。
 *
 * 実行には Redis が必要なため、明示フラグ RUN_REDIS_INTEGRATION=1 のときのみ実行する。
 *   RUN_REDIS_INTEGRATION=1 REDIS_URL=redis://127.0.0.1:6390 \
 *     npx vitest run tests/integration/announcement-stream.test.ts
 */
const RUN = process.env.RUN_REDIS_INTEGRATION === "1";

const waitForAsync = async (
  cond: () => Promise<boolean>,
  timeoutMs = 8000,
  intervalMs = 30
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

/** 高速なタイミング設定（テスト用） */
const fastOptions = (consumerName: string, extra = {}) => ({
  consumerName,
  blockMs: 200,
  reclaimMinIdleMs: 100,
  ...extra,
});

describe.skipIf(!RUN)("AnnouncementStreamConsumer (integration, real Redis)", () => {
  beforeAll(async () => {
    if (!redis.isOpen) await redis.connect();
  });

  afterAll(async () => {
    await redis.del(ANNOUNCEMENT_STREAM_KEY).catch(() => undefined);
    await redis.del(ANNOUNCEMENT_DLQ_STREAM_KEY).catch(() => undefined);
    if (redis.isOpen) await redis.quit();
  });

  const resetStreams = async (): Promise<void> => {
    await redis.del(ANNOUNCEMENT_STREAM_KEY).catch(() => undefined);
    await redis.del(ANNOUNCEMENT_DLQ_STREAM_KEY).catch(() => undefined);
  };

  it("XADD したお知らせを consumer が受信し、ACK してストリームから消える", async () => {
    await resetStreams();
    const received: Announcement[] = [];
    const consumer = new AnnouncementStreamConsumer(
      async (a) => {
        received.push(a);
      },
      new RedisAnnouncementRepository(),
      fastOptions("int-ok")
    );
    await consumer.start();

    try {
      const ann = makeAnnouncement();
      await redis.xAdd(ANNOUNCEMENT_STREAM_KEY, "*", { [ANNOUNCEMENT_STREAM_FIELD]: JSON.stringify(ann) });

      await waitForAsync(async () => received.length === 1);
      expect(received[0]).toEqual(ann);
      await waitForAsync(async () => (await streamLen()) === 0);
    } finally {
      await consumer.shutdown();
    }
  });

  it("ハンドラが一度失敗しても XAUTOCLAIM で再配信され、最終的に配信される", async () => {
    await resetStreams();
    let calls = 0;
    const consumer = new AnnouncementStreamConsumer(
      async () => {
        calls++;
        if (calls === 1) throw new Error("transient failure");
      },
      new RedisAnnouncementRepository(),
      fastOptions("int-retry")
    );
    await consumer.start();

    try {
      await redis.xAdd(ANNOUNCEMENT_STREAM_KEY, "*", {
        [ANNOUNCEMENT_STREAM_FIELD]: JSON.stringify(makeAnnouncement({ id: "int-retry-1" })),
      });

      // 1回目失敗 → pending → reclaim で再配信 → 2回目成功 → ACK でストリームが空になる
      await waitForAsync(async () => (await streamLen()) === 0);
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      await consumer.shutdown();
    }
  });

  it("不正な JSON は DLQ ストリームへ保存され、元ストリームからは消える", async () => {
    await resetStreams();
    const received: Announcement[] = [];
    const consumer = new AnnouncementStreamConsumer(
      async (a) => {
        received.push(a);
      },
      new RedisAnnouncementRepository(),
      fastOptions("int-poison")
    );
    await consumer.start();

    try {
      await redis.xAdd(ANNOUNCEMENT_STREAM_KEY, "*", { [ANNOUNCEMENT_STREAM_FIELD]: "{ broken json" });

      await waitForAsync(async () => (await streamLen()) === 0);
      expect(received).toHaveLength(0);
      // DLQ に1件保存されている
      expect(await redis.xLen(ANNOUNCEMENT_DLQ_STREAM_KEY)).toBe(1);
    } finally {
      await consumer.shutdown();
    }
  });

  it("isDelivered / markDelivered が実 Redis で往復する", async () => {
    const repo = new RedisAnnouncementRepository();
    const id = `int-deliver-${Date.now()}`;

    expect(await repo.isDelivered(id, "g1")).toBe(false);
    await repo.markDelivered(id, "g1");
    expect(await repo.isDelivered(id, "g1")).toBe(true);

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
