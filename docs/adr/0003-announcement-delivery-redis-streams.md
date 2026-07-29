# ADR 0003: お知らせ配信は Redis Streams で行う

- Status: Accepted
- Date: 2026-07-29
- Issue: #425

## Context

オーナーが作成したお知らせを、Bot が参加する全サーバーへ配信する機能を実装する。
配信先はサーバー設定に応じて「オーナーへの DM」または「特定チャンネルへの投稿」となる。

当初は既存の設定変更通知と同じ Redis Pub/Sub（`config:update`）に倣った実装だったが、
レビューで以下の問題が指摘された。

- **消失**: Pub/Sub は非永続。Bot 停止中・再接続中・購読開始失敗時のお知らせは失われる。
  購読開始が Discord ログイン前だと、ギルドキャッシュが空のまま処理され再配信もされない。
- **重複**: 「配信済み確認 → 送信 → 記録」が非アトミックで、再 Publish や複数 Bot
  インスタンスで重複配信が起こりうる。

お知らせは one-shot であり、設定変更通知（欠損しても再検証で回復する）と違って
消失・重複がそのままユーザー影響になる。

## Decision

お知らせ配信を **Redis Streams + consumer group** で行う。

- Dashboard(owner) は `XADD app:announcement:stream` でお知らせ（JSON）を投入する。
- Bot は consumer group `bot-workers` の consumer として
  `XREADGROUP`(`>`) で新規エントリを読み、配信後に `XACK` + `XDEL` する。
- 未 ACK の pending は `XAUTOCLAIM`（一定アイドル時間経過）で再取得し再配信する。
- ギルド単位の配信は Redis Set への `SADD` の戻り値でアトミックに claim し、
  重複配信を防ぐ。配信失敗時は claim を解放して再試行で再配信できるようにする。
- 不正エントリ（パース不能・検証失敗）と試行上限超過エントリは `XACK` して
  dead-letter とし、無限再試行を防ぐ。
- 入力は共有パッケージ（`@rx-twitter/shared`）の `validateAnnouncement` で
  形式・長さ・日時を検証する。

## Consequences

### Positive

- **永続化**: Bot 停止中のお知らせもストリームに残り、再起動後に配信される。
- **at-least-once**: 未 ACK エントリは `XAUTOCLAIM` で再配信される。
- **単一消費**: consumer group により、複数 Bot インスタンスでも各エントリは
  一度だけ処理される。
- **重複防止**: ギルド単位のアトミック claim により、再配信・多重 XADD でも
  同一ギルドへの重複送信を防ぐ。
- Dashboard の publish 側が未実装のうちに契約を Streams に確定でき、後の移行が不要。

### Negative

- Pub/Sub より実装が複雑（consumer group 生成、pending 再取得、dead-letter）。
- claim 後・送信完了前にクラッシュしたギルドは、当該エントリでは再送されない
  （at-most-once 寄り）。重複回避を優先した設計上のトレードオフ。
- 恒久的に失敗するギルド（DM 拒否かつフォールバック無し等）は試行上限で打ち切られ、
  そのギルドには届かない。

### Mitigation

- 試行上限（`ANNOUNCEMENT_MAX_DELIVERY_ATTEMPTS`）で無限再試行を防ぐ。
- DM 失敗時はフォールバックチャンネルへ配信する。
- claim 記録・試行回数記録には TTL を設定し、記録の無制限な増加を防ぐ。
- dead-letter 到達時の通知や、打ち切りギルドの可視化は将来の改善課題とする。

## Notes

- Dashboard 側（companion issue）は Pub/Sub ではなく `XADD` で
  `app:announcement:stream` に投入する必要がある。フィールド名は
  `ANNOUNCEMENT_STREAM_FIELD`、値は Announcement の JSON 文字列。
