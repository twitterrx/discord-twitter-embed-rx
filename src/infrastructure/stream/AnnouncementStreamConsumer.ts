import { randomUUID } from "node:crypto";

import type { Announcement } from "@rx-twitter/shared";
import {
  ANNOUNCEMENT_CONSUMER_GROUP,
  ANNOUNCEMENT_MAX_DELIVERY_ATTEMPTS,
  ANNOUNCEMENT_STREAM_FIELD,
  ANNOUNCEMENT_STREAM_KEY,
  validateAnnouncement,
} from "@rx-twitter/shared";

import type { IAnnouncementRepository } from "#/core/models/Announcement.js";
import { redis } from "#/db/init.js";
import logger from "#/utils/logger.js";

/** お知らせ受信時に呼ばれるハンドラ。throw した場合は再配信対象となる */
export type AnnouncementHandler = (announcement: Announcement) => Promise<void>;

/** dead-letter 発生時に呼ばれる通知コールバック（オーナー通知など） */
export type DeadLetterNotifier = (info: DeadLetterInfo) => Promise<void>;

/** dead-letter 情報 */
export interface DeadLetterInfo {
  streamEntryId: string;
  reason: string;
  payload: string;
  attempts?: number;
  announcement?: Announcement;
}

/** エントリ処理の判定結果 */
export type EntryDecision = "ack" | "retry";

/** コンシューマの稼働状態 */
export interface ConsumerStatus {
  running: boolean;
  connected: boolean;
  /** 稼働中かつ接続済みかつ連続エラーが閾値未満なら true */
  healthy: boolean;
}

/** コンシューマのオプション */
export interface AnnouncementStreamConsumerOptions {
  /** consumer 名（省略時はランダム） */
  consumerName?: string;
  /** 1回の XREADGROUP でブロックする時間（ミリ秒） */
  blockMs?: number;
  /** XAUTOCLAIM で再取得する最小アイドル時間（ミリ秒） */
  reclaimMinIdleMs?: number;
  /** dead-letter 発生時の通知 */
  onDeadLetter?: DeadLetterNotifier;
}

/** 1回に読み取る最大エントリ数 */
const READ_COUNT = 10;
const DEFAULT_BLOCK_MS = 5000;
const DEFAULT_RECLAIM_MIN_IDLE_MS = 60_000;
/** 連続エラーがこの回数以上続くと unhealthy とみなす */
const MAX_CONSECUTIVE_ERRORS = 5;

/**
 * お知らせ配信の Redis Streams コンシューマ
 *
 * consumer group により「永続化・at-least-once・単一消費」を担保する。
 *   - 新規エントリは XREADGROUP(">") で読む
 *   - 失敗/クラッシュで未 ACK の pending は XAUTOCLAIM で再取得し再配信する
 *   - ハンドラ成功で XACK + XDEL、失敗は ACK せず pending に残す
 *   - 不正エントリ・試行上限超過は DLQ へ保存してから ACK（無限再試行を防ぐ）
 *
 * 前提: Bot は単一インスタンスで動作する（ADR 0003）。
 */
export class AnnouncementStreamConsumer {
  private client: typeof redis | null = null;
  private running = false;
  private consecutiveErrors = 0;
  private readonly consumerName: string;
  private readonly blockMs: number;
  private readonly reclaimMinIdleMs: number;
  private readonly onDeadLetter?: DeadLetterNotifier;

  constructor(
    private readonly handler: AnnouncementHandler,
    private readonly repository: IAnnouncementRepository,
    options: AnnouncementStreamConsumerOptions = {}
  ) {
    this.consumerName = options.consumerName ?? `bot-${randomUUID()}`;
    this.blockMs = options.blockMs ?? DEFAULT_BLOCK_MS;
    this.reclaimMinIdleMs = options.reclaimMinIdleMs ?? DEFAULT_RECLAIM_MIN_IDLE_MS;
    this.onDeadLetter = options.onDeadLetter;
  }

  /**
   * 現在の稼働状態を返す（ヘルスチェック用）
   */
  getStatus(): ConsumerStatus {
    const connected = this.client?.isOpen ?? false;
    return {
      running: this.running,
      connected,
      healthy: this.running && connected && this.consecutiveErrors < MAX_CONSECUTIVE_ERRORS,
    };
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
        this.consecutiveErrors = 0;
      } catch (err) {
        if (!this.running) break; // shutdown 中の read 中断はエラー扱いしない

        this.consecutiveErrors++;
        const message = err instanceof Error ? err.message : String(err);

        // consumer group が消失した場合は再作成する（Redis データ消失などで発生）
        if (message.includes("NOGROUP")) {
          logger.warn("[AnnouncementStream] Consumer group missing, recreating");
          try {
            await this.ensureGroup();
          } catch (recreateErr) {
            logger.error("[AnnouncementStream] Failed to recreate consumer group:", recreateErr);
          }
        } else {
          logger.error("[AnnouncementStream] Loop iteration failed:", err);
        }

        await this.delay(1000);
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
      this.reclaimMinIdleMs,
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
      { COUNT: READ_COUNT, BLOCK: this.blockMs }
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
   * - 不正な内容（パース不能・検証失敗）: DLQ 保存後に "ack"
   * - 試行上限超過: DLQ 保存後に "ack"
   * - ハンドラ成功: "ack"
   * - ハンドラ失敗: "retry"
   */
  async processEntry(entryId: string, message: Record<string, string>): Promise<EntryDecision> {
    const raw = message[ANNOUNCEMENT_STREAM_FIELD];
    if (typeof raw !== "string") {
      return this.deadLetter(entryId, "missing announcement field", "");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return this.deadLetter(entryId, "invalid JSON", raw);
    }

    const validation = validateAnnouncement(parsed);
    if (!validation.ok) {
      return this.deadLetter(entryId, `validation failed: ${validation.error}`, raw);
    }

    const attempts = await this.repository.incrementAttempts(entryId);
    if (attempts > ANNOUNCEMENT_MAX_DELIVERY_ATTEMPTS) {
      const decision = await this.deadLetter(
        entryId,
        "max delivery attempts exceeded",
        raw,
        attempts,
        validation.value
      );
      // DLQ 保存に成功して ack する場合のみ試行回数を消去する
      if (decision === "ack") {
        await this.repository.clearAttempts(entryId);
      }
      return decision;
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
   * dead-letter を永続化し、通知コールバックを呼ぶ。
   *
   * DLQ への保存に失敗した場合は "retry" を返し、元エントリを pending に残して
   * 情報の消失を防ぐ（Redis ACL・OOM 等で DLQ だけ書けない状況に備える）。
   * 保存成功後の通知失敗のみ best-effort で握り潰す。
   */
  private async deadLetter(
    entryId: string,
    reason: string,
    payload: string,
    attempts?: number,
    announcement?: Announcement
  ): Promise<EntryDecision> {
    logger.warn(`[AnnouncementStream] Dead-lettering entry ${entryId}: ${reason}`);
    try {
      await this.repository.recordDeadLetter({ streamEntryId: entryId, reason, payload, attempts });
    } catch (err) {
      logger.error(`[AnnouncementStream] Failed to record dead-letter for ${entryId}, keeping entry for retry:`, err);
      return "retry";
    }

    if (this.onDeadLetter) {
      try {
        await this.onDeadLetter({ streamEntryId: entryId, reason, payload, attempts, announcement });
      } catch (err) {
        logger.error(`[AnnouncementStream] Dead-letter notifier failed for ${entryId}:`, err);
      }
    }
    return "ack";
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
