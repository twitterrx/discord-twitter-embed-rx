/**
 * ダッシュボードバージョン共有用の定数（Bot ↔ Dashboard 共有）
 */

/** Redis キー: ダッシュボードのバージョン情報 */
export const DASHBOARD_VERSION_KEY = "app:dashboard:version";

/** TTL（秒）: バージョン情報の有効期間 */
export const DASHBOARD_VERSION_TTL_SECONDS = 300;

/** フォールバック表示: ダッシュボード未接続時 */
export const DASHBOARD_VERSION_FALLBACK = "未接続";

/** ハートビート間隔（ミリ秒）: TTL延長の実行間隔 */
export const DASHBOARD_VERSION_HEARTBEAT_INTERVAL_MS = 120_000;

/**
 * 1メッセージあたりのURL処理数上限
 */

/** デフォルト値: 1メッセージあたりの最大処理URL数 */
export const DEFAULT_MAX_URLS_PER_MESSAGE = 3;

/** ダッシュボード設定で指定できる最大値 */
export const MAX_URLS_PER_MESSAGE_LIMIT = 5;

/**
 * お知らせ配信用の定数（Bot ↔ Dashboard 共有）
 *
 * 配信は Redis Streams を用いる（永続化・at-least-once・単一消費）。
 * Dashboard(owner) は XADD で ANNOUNCEMENT_STREAM_KEY に投入し、
 * Bot は consumer group で読み取って配信する。
 */

/** Redis Streams キー: お知らせ配信ストリーム（Dashboard → Bot） */
export const ANNOUNCEMENT_STREAM_KEY = "app:announcement:stream";

/** consumer group 名: Bot ワーカー群 */
export const ANNOUNCEMENT_CONSUMER_GROUP = "bot-workers";

/** Redis Streams キー: dead-letter（配信不能・不正エントリの保管先） */
export const ANNOUNCEMENT_DLQ_STREAM_KEY = "app:announcement:dlq";

/** XADD 時のフィールド名（値は Announcement の JSON 文字列） */
export const ANNOUNCEMENT_STREAM_FIELD = "announcement";

/** 1ストリームエントリあたりの最大再配信試行回数（超過で dead-letter） */
export const ANNOUNCEMENT_MAX_DELIVERY_ATTEMPTS = 5;

/** お知らせタイトルの最大長（Discord Embed のタイトル上限に準拠） */
export const ANNOUNCEMENT_TITLE_MAX_LENGTH = 256;

/** お知らせ本文の最大長（Discord Embed の説明文上限に準拠） */
export const ANNOUNCEMENT_BODY_MAX_LENGTH = 4096;
