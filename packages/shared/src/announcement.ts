/**
 * お知らせ機能の型定義・検証（Bot ↔ Dashboard 共有）
 */

import { ANNOUNCEMENT_BODY_MAX_LENGTH, ANNOUNCEMENT_TITLE_MAX_LENGTH } from "./constants.js";

/**
 * オーナーが作成し、全サーバーへ配信するお知らせ
 */
export interface Announcement {
  /** お知らせの一意なID（冪等性・重複配信防止に使用） */
  id: string;
  /** タイトル */
  title: string;
  /** 本文 */
  body: string;
  /** 作成日時（ISO 8601形式） */
  createdAt: string;
  /** 作成者のユーザーID（任意） */
  createdBy?: string;
}

/**
 * お知らせの配信先モード
 * - dm: サーバーオーナーへ DM
 * - channel: 特定チャンネルへ投稿
 *
 * Phase 2 でメンション（ロール/ユーザー）を追加予定。
 */
export type AnnounceTargetMode = "dm" | "channel";

/**
 * サーバーごとのお知らせ配信先設定
 */
export interface AnnounceTarget {
  /** 配信先モード */
  mode: AnnounceTargetMode;
  /**
   * 投稿先チャンネルID。
   * mode が "channel" のときは必須。
   * mode が "dm" のときは DM 失敗時のフォールバック先として任意で使用する。
   */
  channelId?: string;
}

/**
 * お知らせの検証結果
 */
export type AnnouncementValidationResult =
  | { ok: true; value: Announcement }
  | { ok: false; error: string };

/**
 * 未知の入力（Redis Streams から受け取った JSON など）を Announcement として検証する。
 *
 * 形式・長さ・日時を検証し、Bot・Dashboard 双方で利用できる。
 * @param input 検証対象（パース済みの任意の値）
 */
export function validateAnnouncement(input: unknown): AnnouncementValidationResult {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "announcement must be an object" };
  }

  const a = input as Record<string, unknown>;

  if (typeof a.id !== "string" || a.id.trim() === "") {
    return { ok: false, error: "id must be a non-empty string" };
  }

  if (typeof a.title !== "string" || a.title.trim() === "") {
    return { ok: false, error: "title must be a non-empty string" };
  }
  if (a.title.length > ANNOUNCEMENT_TITLE_MAX_LENGTH) {
    return { ok: false, error: `title must be at most ${ANNOUNCEMENT_TITLE_MAX_LENGTH} characters` };
  }

  if (typeof a.body !== "string" || a.body.trim() === "") {
    return { ok: false, error: "body must be a non-empty string" };
  }
  if (a.body.length > ANNOUNCEMENT_BODY_MAX_LENGTH) {
    return { ok: false, error: `body must be at most ${ANNOUNCEMENT_BODY_MAX_LENGTH} characters` };
  }

  if (typeof a.createdAt !== "string" || Number.isNaN(Date.parse(a.createdAt))) {
    return { ok: false, error: "createdAt must be a valid ISO 8601 date string" };
  }

  if (a.createdBy !== undefined && typeof a.createdBy !== "string") {
    return { ok: false, error: "createdBy must be a string when present" };
  }

  const value: Announcement = {
    id: a.id,
    title: a.title,
    body: a.body,
    createdAt: a.createdAt,
    ...(a.createdBy !== undefined ? { createdBy: a.createdBy as string } : {}),
  };

  return { ok: true, value };
}
