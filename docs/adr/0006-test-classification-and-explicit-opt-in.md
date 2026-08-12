# ADR 0006: テストは実態で分類し、依存が要るテストは明示フラグでオプトインする

- Status: Accepted
- Date: 2026-08-12
- Issue: #590

## Context

`tests/e2e/` には 2 つのテストが置かれていたが、いずれも名前どおりのものではなかった。

**`channel-config.test.ts`** は `ChannelConfigService` → `RedisChannelConfigRepository` → Redis を
直接組み立てて叩くもので、Bot の起動・Discord イベント受信・メッセージハンドラ・Discord への
応答をひとつも通っていない。E2E ではなく結合テストである。

さらにこのテストは**実 Redis で一度も通ったことがなかった**。テスト用ヘルパーが独自に
`createClient()` した接続へ書き込む一方、被験体である Repository は `@/db/init` の共有 `redis`
から読んでいた。この共有クライアントは誰も `connect()` していないため、全ての読み出しが
`The client is closed` となり `kind: "error"` を返す。実 Redis を繋いで実行すると 6 件中 5 件が
失敗した。「設定未作成時の既定は deny」というアサーションも誤りで、実装（`resolveFallbackPolicies`）
の既定は可用性優先の allow である。

**`dashboard-api.test.ts`** は起動済み Dashboard へ HTTP を投げるものだが、Dashboard は別リポジトリ
（`rx-twitter/rx-twitter-dashboard`）で管理されている。本リポジトリに置き続けると、実装の管理場所と
テストの修正責任が分離し、別リポジトリの変更で本リポジトリの CI が落ちうる。

両者が問題として表面化しなかったのは、依存が無いときに早期 return する書き方をしていたためである。

```typescript
if (!redisAvailable) {
  console.warn("Skipping: Redis not available");
  return; // テストは緑になる。何も検証していないのに
}
```

CI の `test` ジョブは `npm run test:coverage`（対象は全ディレクトリ）を実行しており、Redis も
Dashboard も居ない環境で `tests/e2e/` は毎回走っていた。つまりこれらは**毎回、中身ゼロで緑**に
なっていた。壊れたテストと、通っているテストが、レポート上で区別できていなかった。

## Decision

### 1. ディレクトリはテストの実態で分ける

- `tests/unit/` — 外部依存をモックする単体テスト
- `tests/integration/` — 実 Redis・実 API を含む結合テスト
- `tests/e2e/` — **廃止する**

`channel-config.test.ts` は `tests/integration/` へ移し、被験体と同じ接続（`@/db/init` の `redis`）
でテストデータを書くよう作り直す。`dashboard-api.test.ts` は本リポジトリから削除し、Dashboard
リポジトリへ移送する（`rx-twitter/rx-twitter-dashboard#130`）。

Bot 全体を通す本来の E2E（Discord/X API をスタブ、Redis は実コンテナ）は将来別途検討する（#608）。
対象が無い状態で空のディレクトリと `test:e2e` スクリプトを残さないため、スクリプトも削除する。

### 2. 依存が要るテストは `skipIf` で明示的にオプトインする

早期 return をやめ、`describe.skipIf(!RUN)` で依存の有無を表明する。

```typescript
const RUN = process.env.RUN_REDIS_INTEGRATION === "1";

describe.skipIf(!RUN)("チャンネル設定 (integration, real Redis)", () => { ... });
```

実行されなかった場合、レポートには `skipped` として残る。「実行されていない」と「検証して通った」を
取り違えなくなる。既存の `announcement-stream.test.ts`（`RUN_REDIS_INTEGRATION`）および
`fxtwitterContract.test.ts`（`RUN_LIVE_API_TESTS`）と同じ規約に揃える。

### 3. 結合テストは被験体と同じ接続でデータを用意する

テスト専用のクライアントを別途立てて書き込まない。書き込みと読み出しで別の接続を使うと、
本件のように「書いたのに読めない」構成をテスト側が作り込んでしまい、検証したいはずの結合が
検証されない。

### 4. CI は実 Redis テストを名指しで実行する

`integration-redis` ジョブ（Redis サービス付き）で対象ファイルを列挙する。`tests/integration` を
丸ごと指定しない — このディレクトリにはネットワーク依存の `http-client` / `twitter-api` が同居して
おり、巻き込むとジョブが外部都合で落ちるため（これらの扱いは #607）。

## Consequences

### Positive

- 実 Redis でチャンネル設定の結合が実際に検証されるようになった（10 件、CI で毎 PR 実行）。
- 壊れていたテストと誤ったアサーション（deny/allow）が是正された。
- 未実行がレポート上 `skipped` として可視化され、緑の意味が回復した。
- Dashboard の変更で本リポジトリの CI が落ちる経路が無くなった。
- 各リポジトリのテストがそのリポジトリ単体で完結する。

### Negative

- Bot 全体を通す E2E が現時点で存在しない。メッセージ受信から Embed 送信までの経路は、
  ユニットテストの合成でしか担保されていない。
- Redis 統合テストは CI で名指し実行のため、新しくファイルを足したときに CI への追加を
  忘れるとローカルでしか走らない。

### Mitigation

- Bot 全体の E2E は #608 で構想を起票済み。着手時に `tests/e2e/` を規約ごと再導入する。
- 実 Redis テストの追加手順（`skipIf` 規約と CI ジョブへの追記）を AGENTS.md のテスト節に記載した。

## Alternatives considered

- **移動のみ行い、壊れた実装は別 Issue にする**: 分類は整うが、CI に組み込めないため
  「曖昧な skip をやめる」という本 Issue の完了条件を満たせない。分類の是正は、テストが実際に
  動いてはじめて意味を持つと判断した。
- **`tests/e2e/` を将来構想の README 付きで残す**: 対象ゼロのディレクトリとスクリプトが残り、
  「E2E がある」という誤った印象を与える。着手時に作り直す方が安い。
