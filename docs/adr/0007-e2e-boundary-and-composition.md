# ADR 0007: E2E は Discord と fetch だけを差し替え、依存グラフはテスト側で組む

- Status: Accepted
- Date: 2026-08-13
- Issue: #608

## Context

ADR 0006 で `tests/e2e/` を廃止した。置かれていた 2 つのテストが名前どおりのものでは
なかったためである。結果として、Bot の主要フローを通しで検証するテストが存在しない状態が
残った。#608 はこれを埋める。

既存の `tests/unit/adapters/discord/MessageHandler.test.ts`（748 行）は、協力者を全て
`vi.fn()` に差し替えている。

```typescript
processor      = { extractUrls: vi.fn().mockReturnValue([...]), ... }
twitterAdapter = { fetchTweet: vi.fn().mockResolvedValue(createMockTweet()) }
embedBuilder   = { build: vi.fn().mockReturnValue([]) }
```

`MessageHandler` が「どういう順で何を呼ぶか」は検証できるが、URL 抽出が返した文字列を
Adapter が実際に解釈でき、そこから組んだ `Tweet` で表示が組めるかという**協調**は
どのテストも見ていない。層ごとの単体テストが全て緑でも、繋いだ瞬間に壊れうる。

## Decision

### 1. 差し替えるのは外周の 2 箇所だけ

| | 対象 |
| --- | --- |
| 本物 | `TweetProcessor`、`TwitterAdapter`（Vx→Fx フォールバック含む）、`ComponentsV2Builder`、`DiscordEmbedBuilder`、`ChannelConfigService`、`MediaHandler`、Redis |
| 偽物 | Discord（`Message` / `Client`）、`fetch`（外部 Twitter API） |

内側は本番と同じ実装を動かす。差し替えを増やすほど E2E は単体テストへ近づき、
存在意義が薄れる。

### 2. 外部 API は `ITwitterAdapter` ではなく `fetch` 層で差し替える

`ITwitterAdapter` ごと差し替えると、生成クライアントのパースも `Tweet` への変換も
フォールバックの分岐も通らない。守備範囲が既存の単体テストとほとんど重なる。

`fetch` を差し替えれば、

```
生成クライアント → orvalFetch → VxTwitterAdapter / FxTwitterAdapter → TwitterAdapter
```

が全て本物のまま動く。既に `tests/unit/vxtwitter/apiHttpBoundary.test.ts` が同じ手法を
使っている。

`VxTwitterAdapter` / `FxTwitterAdapter` の `transformUrl` は `x.com` を
`api.vxtwitter.com` / `api.fxtwitter.com` へ書き換えるため、ホスト名で応答を出し分ければ
**「vx が 5xx を返して fx へフォールバックする」経路も意図的に再現できる**。fx 側には
`tests/fixtures/fxtwitter/` の実 API payload をそのまま使う。

想定外のホストへの `fetch` は reject する。黙って通すと、テストが気付かないうちに実
ネットワークへ出る。

### 3. 依存グラフはテスト側で組む

`src/index.ts` は読み込み時点で全配線を実行し、そのまま Discord へログインする。
テストから `import` できない。したがってテストが `index.ts` と同じ順で組み直す。

### 4. 新しいテストは壊して確かめてからコミットする

通ることではなく、**壊したときに落ちること**を確認する。#590 と #607 で、緑のまま何も
検証していないテストが 2 度見つかっている。本 ADR のテストは、以下の 3 つを一時的に
壊して、狙ったテストだけが落ちることを確認してからコミットした。

| 壊した箇所 | 落ちたテスト |
| --- | --- |
| `ChannelConfigService` のホワイトリスト判定を常に true | ホワイトリスト外のチャンネルでは処理しない |
| `TwitterAdapter` の 5xx フォールバック分岐を削除 | vx が 5xx を返すと fx へフォールバックして展開する |
| `ComponentsV2Builder` の本文組み立てを空文字に | vx から取得した内容で Components v2 のメッセージを返す |

## Consequences

### Positive

- 層をまたいだ協調が実際に検証されるようになった（7 ケース、CI で毎 PR 実行）。
- Vx→Fx のフォールバックが、モックの戻り値ではなく HTTP ステータスから駆動されて
  検証される。
- FxTwitter の保存済み fixture が、パースだけでなく表示の組み立てまで通して使われる。
- 外向き通信が全て遮断されるため、E2E がネットワーク都合で落ちない。

### Negative

- **`src/index.ts` 側の配線ミスは捕まらない**。テストは自分で組んだグラフを見ている
  だけで、本番の合成が正しいことは保証しない。引数の順序違いのような配線ミスは
  型で防がれるが、同じ型の依存を取り違えた場合は検知できない。
- Discord のフェイクは `Message` の一部しか再現していない。discord.js 側の挙動変化
  （API バージョン差異、ペイロード検証の厳格化）は検知できない。

### Mitigation

- 配線の共有は、`index.ts` から合成を関数へ切り出せば解消する。本番コードの
  リファクタを伴うため本 PR では見送った。必要になった時点で切り出す。
- Discord のペイロード検証は、`ContainerBuilder` を `toJSON()` まで落として中身を
  確かめることで、少なくとも組み立て結果の妥当性は見ている。

## Alternatives considered

- **`ITwitterAdapter` を差し替える**: 実装は単純だが、Adapter の変換もフォールバックも
  通らず、既存の単体テストに上乗せされる価値がほとんど無い。
- **偽の API サーバーを Hono で立てる**: より実態に近いが、Adapter が URL をハード
  コードで変換するため、ベース URL の差し替え口を本番コードへ開ける必要がある。
  テストのために本番へ穴を開ける判断は、得られるものに見合わないと考えた。
- **`tests/integration/` に置く**: 新しいディレクトリとスクリプトを増やさずに済むが、
  Bot 全体を通すテストと部分結合のテストが同じ場所に混ざる。ADR 0006 が
  「着手時に `tests/e2e/` を規約ごと再導入する」としていた方針に従った。
