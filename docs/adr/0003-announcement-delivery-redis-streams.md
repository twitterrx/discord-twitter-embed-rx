# ADR 0003: お知らせ配信は Redis Streams で行う（単一インスタンス前提）

- Status: Accepted
- Date: 2026-07-30
- Issue: #425

## Context

オーナーが作成したお知らせを、Bot が参加する全サーバーへ配信する機能を実装する。
配信先はサーバー設定に応じて「オーナーへの DM」または「特定チャンネルへの投稿」となる。

当初は既存の設定変更通知と同じ Redis Pub/Sub（`config:update`）に倣ったが、
レビューで「消失（非永続）」「重複（非アトミックな確認→送信→記録）」が指摘された。
お知らせは one-shot であり、消失・重複がそのままユーザー影響になる。

## Decision

お知らせ配信を **Redis Streams + consumer group** で行う。

- Dashboard(owner) は `XADD app:announcement:stream`（フィールド `announcement` = Announcement の JSON）で投入する。
- Bot は consumer group `bot-workers` の consumer として `XREADGROUP`(`>`) で新規エントリを読み、
  配信後に `XACK` + `XDEL` する。
- 未 ACK の pending は `XAUTOCLAIM`（一定アイドル時間経過）で再取得し再配信する（at-least-once）。
- 重複配信の防止は、**配信成功後にのみギルドを delivered として記録**し、再配信時に
  delivered 済みギルドをスキップする冪等性で担保する（記録は「成功後のみ」なので、
  記録漏れや障害があっても未配信ギルドは再試行で再配信される＝欠落より重複を許容）。
- 不正エントリ・試行上限超過エントリは **dead-letter ストリーム（`app:announcement:dlq`）へ
  保存してから** `XACK` し、無限再試行を防ぐ。オーナーへ通知する。
- 入力は共有パッケージの `validateAnnouncement` で形式・長さ・日時を検証する。
- consumer の起動失敗は Bot 全体を落とさず、お知らせ機能のみ劣化させる。稼働状態は
  ヘルスチェック（`/readyz`・`/health`）に反映する。

### 前提: 単一インスタンス

本設計は **Bot が単一インスタンス（単一プロセス、cross-process sharding なし）で動作する**
ことを前提とする。受信した 1 プロセスが全ギルドを `guilds.cache` で把握しているため、
そのプロセスが全ギルドへ配信できる。

複数インスタンス／Discord sharding で各プロセスが異なるギルドを担当する構成は本 ADR の
スコープ外とする（consumer group は 1 エントリを 1 consumer にしか渡さないため、
選ばれなかった shard のギルドへ届かない）。マルチ shard 対応は将来課題とし、
その際は「ギルド単位ジョブへのファンアウト」等の別設計が必要になる（別 issue）。

## Consequences

### Positive

- **永続化**: Bot 停止中のお知らせもストリームに残り、再起動後に配信される。
- **at-least-once**: 未 ACK エントリは `XAUTOCLAIM` で再配信される。
- **重複防止（冪等性）**: delivered 済みギルドはスキップされ、再配信・多重 XADD でも
  重複送信を防ぐ。
- **dead-letter の可視化**: 配信不能なお知らせは破棄されず DLQ に残り、オーナー通知もされる。
- **単純さ**: 単一インスタンス前提によりアトミック claim 等の分散協調が不要。

### Negative

- **単一インスタンス限定**: 複数インスタンス／sharding には未対応（前提節参照）。
- **クラッシュ時の重複可能性**: 送信成功直後〜delivered 記録前にクラッシュすると、
  再配信で同一ギルドへ二重送信されうる（欠落を避けるための意図的なトレードオフ）。
- Pub/Sub より実装が複雑（consumer group 生成、pending 再取得、DLQ）。
- 恒久的に失敗するギルド（DM 拒否かつフォールバック無し等）は試行上限で打ち切られ、
  dead-letter として記録・通知される（そのギルドには届かない）。

### Mitigation

- 試行上限（`ANNOUNCEMENT_MAX_DELIVERY_ATTEMPTS`）で無限再試行を防ぐ。
- DM 失敗時はフォールバックチャンネルへ配信する。
- delivered 記録・試行回数記録には TTL を設定し、記録の無制限な増加を防ぐ。
- dead-letter は DLQ ストリームへ保存し、オーナーへ通知する。

## Notes

- Dashboard 側（companion issue）は Pub/Sub ではなく `XADD` で
  `app:announcement:stream` に投入する。フィールド名は `ANNOUNCEMENT_STREAM_FIELD`、
  値は Announcement の JSON 文字列。
- 実 Redis を用いた統合テストは `RUN_REDIS_INTEGRATION=1` のときのみ実行し、CI では
  Redis サービスを起動して実行する。
