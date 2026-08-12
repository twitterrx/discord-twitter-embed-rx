# E2E テスト

Bot の主要フローを通しで検証するテストを置く。

```
メッセージ受信 → URL 判定 → 投稿情報の取得 → 表示の組み立て → 送信
```

## 何を本物にして、何を偽物にするか

E2E の値打ちは、この線引きで決まる。

| | 対象 |
| --- | --- |
| **本物** | `TweetProcessor`、`TwitterAdapter`（Vx→Fx のフォールバック含む）、`ComponentsV2Builder`、`DiscordEmbedBuilder`、`ChannelConfigService`、`MediaHandler`、Redis |
| **偽物** | Discord（`Message` / `Client`）、`fetch`（外部 Twitter API） |

差し替えるのは**外周の 2 箇所だけ**。内側は本番と同じ実装が動く。

`tests/unit/adapters/discord/MessageHandler.test.ts` は協力者を全て `vi.fn()` に
差し替えるため、`MessageHandler` の手順は検証できても、URL 抽出が返した文字列を
Adapter が解釈でき、その `Tweet` から表示が組めるかという**協調**は見ていない。
E2E が埋めるのはそこ。

### 外部 API は `fetch` 層で差し替える

`ITwitterAdapter` ごと差し替えると、生成クライアントのパースも `Tweet` への変換も
フォールバックの分岐も通らず、単体テストと守備範囲がほとんど重ならない。

`twitterApiStub.ts` はホスト名でルーティングする。`transformUrl` が `x.com` を
`api.vxtwitter.com` / `api.fxtwitter.com` へ書き換えるため、**vx を 5xx にして fx へ
落とす経路も意図的に作れる**。

```typescript
stubTwitterApi({
  vx: { kind: "status", status: 500 },
  fx: { kind: "fixture", name: "status-text-only" }, // 実 API の保存済み payload
});
```

想定外のホストへの `fetch` は reject する。黙って通すと、テストが気付かないうちに
実ネットワークへ出てしまう。

## 実行方法

実 Redis が要るため `RUN_REDIS_INTEGRATION=1` のときだけ実行する。

```bash
docker run -d --rm --name twrx-test-redis -p 6390:6379 redis:8.2.2-alpine
RUN_REDIS_INTEGRATION=1 REDIS_URL=redis://127.0.0.1:6390 npm run test:e2e
docker rm -f twrx-test-redis
```

フラグ無しでは `skipped` として残る。空振りの緑にはしない（ADR 0006）。

CI では `integration-redis` ジョブが Redis サービス付きで `tests/integration` と
併せて実行する。

## 書くときの約束

- **依存の有無は `describe.skipIf(!RUN)` で表明する**。早期 `return` で緑にしない。
- **被験体と同じ Redis 接続（`@/db/init` の `redis`）でデータを用意する**。別クライアントで
  書くと「書いたのに読めない」状態を作り込む。
- **書いたテストが本当に噛んでいるか確かめる**。本番コードを一時的に壊して、狙った
  テストが落ちることを確認してからコミットする。通ったことより、壊したときに落ちる
  ことのほうが情報量が多い。
- **外部の実リソースの中身の値に依存しない**。対象が消えてもエラー応答で緑を返しうる。

## 既知の限界

`src/index.ts` は読み込み時点で Discord へログインするため、テストから `import` できない。
依存グラフは**テスト側で index.ts と同じ順に組み直している**。したがって
**index.ts 側の配線ミスはこのテストでは捕まらない**。

配線を関数へ切り出して本番とテストで共有すれば解消するが、本番コードのリファクタを
伴うため見送っている。経緯は ADR 0007 を参照。

## ファイル

| ファイル | 役割 |
| --- | --- |
| `messageFlow.test.ts` | メッセージ受信から送信までのシナリオ |
| `twitterApiStub.ts` | 外部 Twitter API を `fetch` 層で差し替える |
| `discordFake.ts` | `Message` / `Client` のフェイク。送信内容を記録する |
