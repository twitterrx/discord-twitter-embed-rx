import { randomUUID } from "node:crypto";

import type { Announcement } from "@rx-twitter/shared";
import {
  ANNOUNCEMENT_CONSUMER_GROUP,
  ANNOUNCEMENT_MAX_DELIVERY_ATTEMPTS,
  ANNOUNCEMENT_STREAM_FIELD,
  ANNOUNCEMENT_STREAM_KEY,
  validateAnnouncement,
} from "@rx-twitter/shared";

import type { IAnnouncementRepository } from "@/core/models/Announcement";
import { redis } from "@/db/init";
import logger from "@/utils/logger";

/** お知らせ受信時に呼ばれるハンドラ。throw した場合は再配信対象となる */
export type AnnouncementHandler = (announcement: Announcement) => Promise<void>;

/** エントリ処理の判定結果 */
export type EntryDecision = "ack" | "retry";

/** 1回の XREADGROUP でブロックする時間（ミリ秒） */
const BLOCK_MS = 5000;
/** 1回に読み取る最大エントリ数 */
const READ_COUNT = 10;
/** XAUTOCLAIM で再取得する最小アイドル時間（ミリ秒）。この時間未処理の pending を再配信する */
const RECLAIM_MIN_IDLE_MS = 60_000;

/**
 * お知らせ配信の Redis Streams コンシューマ
 *
 * consumer group により「永続化・at-least-once・単一消費（複数インスタンスでの重複防止）」を担保する。
 *   - 新規エントリは XREADGROUP(">") で読む
 *   - 失敗/クラッシュで未 ACK の pending は XAUTOCLAIM で再取得し再配信する
 *   - ハンドラ成功で XACK + XDEL、失敗は ACK せず pending に残す
 *   - 不正エントリ・試行上限超過は dead-letter として ACK（無限再試行を防ぐ）
 */
export class AnnouncementStreamConsumer {
  private client: typeof redis | null = null;
  private running = false;
  private readonly consumerName: string;

  constructor(
    private readonly handler: AnnouncementHandler,
    private readonly repository: IAnnouncementRepository,
    consumerName?: string
  ) {
    this.consumerName = consumerName ?? `bot-${randomUUID()}`;
  }

  /**
   * 購読を開始する（consumer group を用意し、消費ループを起動する）
   */
  async start(): Promise<void> {
    this.client = redis.duplicate();
    this.client.on("error", (err) => {
      logger.error("[AnnouncementStream] Client error:", err);
    });

    if (typeof this.client.connect === "function" && !this.client.isOpen) {
      await this.client.connect();
    }

    await this.ensureGroup();
    this.running = true;
    void this.loop();
    logger.info(`[AnnouncementStream] Started consumer ${this.consumerName}`);
  }

  /**
   * consumer group を用意する（既存なら BUSYGROUP を無視）
   */
  private async ensureGroup(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.xGroupCreate(ANNOUNCEMENT_STREAM_KEY, ANNOUNCEMENT_CONSUMER_GROUP, "0", {
        MKSTREAM: true,
      });
      logger.info("[AnnouncementStream] Created consumer group");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("BUSYGROUP")) {
        return; // 既に存在
      }
      throw err;
    }
  }

  /**
   * 消費ループ。停止要求まで、pending 再取得 → 新規読み取りを繰り返す。
   */
  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.reclaimPending();
        await this.readNew();
      } catch (err) {
        if (this.running) {
          logger.error("[AnnouncementStream] Loop iteration failed:", err);
          await this.delay(1000);
        }
      }
    }
  }

  /**
   * 未 ACK の pending エントリを XAUTOCLAIM で再取得して処理する
   */
  private async reclaimPending(): Promise<void> {
    if (!this.client) return;
    const result = await this.client.xAutoClaim(
      ANNOUNCEMENT_STREAM_KEY,
      ANNOUNCEMENT_CONSUMER_GROUP,
      this.consumerName,
      RECLAIM_MIN_IDLE_MS,
      "0-0",
      { COUNT: READ_COUNT }
    );

    for (const entry of result.messages) {
      if (entry === null) continue;
      await this.handleEntry(entry.id, entry.message);
    }
  }

  /**
   * 新規エントリを XREADGROUP(">") で読み取って処理する
   */
  private async readNew(): Promise<void> {
    if (!this.client) return;
    const response = await this.client.xReadGroup(
      ANNOUNCEMENT_CONSUMER_GROUP,
      this.consumerName,
      [{ key: ANNOUNCEMENT_STREAM_KEY, id: ">" }],
      { COUNT: READ_COUNT, BLOCK: BLOCK_MS }
    );

    if (!response) return;

    for (const stream of response) {
      for (const entry of stream.messages) {
        await this.handleEntry(entry.id, entry.message);
      }
    }
  }

  /**
   * 1エントリを処理し、判定に応じて ACK する
   */
  private async handleEntry(entryId: string, message: Record<string, string>): Promise<void> {
    const decision = await this.processEntry(entryId, message);
    if (decision === "ack") {
      await this.ackAndDelete(entryId);
    }
    // retry の場合は ACK せず pending に残し、次回 XAUTOCLAIM で再配信する
  }

  /**
   * エントリ内容を検証・配信する。ACK すべきか（"ack"）再試行か（"retry"）を返す。
   *
   * - 不正な内容（パース不能・検証失敗）: dead-letter として "ack"
   * - 試行上限超過: dead-letter として "ack"
   * - ハンドラ成功: "ack"
   * - ハンドラ失敗: "retry"
   */
  async processEntry(entryId: string, message: Record<string, string>): Promise<EntryDecision> {
    const raw = message[ANNOUNCEMENT_STREAM_FIELD];
    if (typeof raw !== "string") {
      logger.warn(`[AnnouncementStream] Entry ${entryId} has no announcement field, dead-lettering`);
      return "ack";
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn(`[AnnouncementStream] Entry ${entryId} is not valid JSON, dead-lettering`);
      return "ack";
    }

    const validation = validateAnnouncement(parsed);
    if (!validation.ok) {
      logger.warn(`[AnnouncementStream] Entry ${entryId} failed validation: ${validation.error}, dead-lettering`);
      return "ack";
    }

    const attempts = await this.repository.incrementAttempts(entryId);
    if (attempts > ANNOUNCEMENT_MAX_DELIVERY_ATTEMPTS) {
      logger.error(
        `[AnnouncementStream] Entry ${entryId} exceeded max delivery attempts (${ANNOUNCEMENT_MAX_DELIVERY_ATTEMPTS}), dead-lettering`,
        { announcementId: validation.value.id }
      );
      await this.repository.clearAttempts(entryId);
      return "ack";
    }

    try {
      await this.handler(validation.value);
      await this.repository.clearAttempts(entryId);
      return "ack";
    } catch (err) {
      logger.error(`[AnnouncementStream] Handler failed for entry ${entryId}, will retry:`, err);
      return "retry";
    }
  }

  /**
   * エントリを ACK し、ストリームから削除する
   */
  private async ackAndDelete(entryId: string): Promise<void> {
    if (!this.client) return;
    await this.client.xAck(ANNOUNCEMENT_STREAM_KEY, ANNOUNCEMENT_CONSUMER_GROUP, entryId);
    try {
      await this.client.xDel(ANNOUNCEMENT_STREAM_KEY, entryId);
    } catch (err) {
      logger.warn(`[AnnouncementStream] Failed to delete entry ${entryId}:`, err);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    this.running = false;
    if (this.client) {
      try {
        await this.client.quit();
      } catch (err) {
        logger.error("[AnnouncementStream] Error during shutdown:", err);
      }
      this.client = null;
    }
  }
}
