# Issue #541: 投票表示対応の設計

- Issue: https://github.com/rx-twitter/rx-twitter/issues/541
- 対象ブランチ: `feat/issue-541-poll-support`
- Status: Implemented

## 背景

現在の Bot は vxTwitter / FxTwitter のレスポンスに含まれる投票情報を Core の
`Tweet` モデルへ変換していないため、Discord Embed に投票の選択肢が表示されない。

Issue の再現用ポストを確認すると、API ごとのレスポンスは次のように異なる。

- vxTwitter は `pollData.options` に選択肢名、得票数、得票率を返す。
- FxTwitter は `poll.choices` に同等の情報を返すが、同名の選択肢を重複排除する。
- 再現用ポストでは、vxTwitter は同名の 2 選択肢を保持し、FxTwitter は 1 選択肢だけを返す。

Bot のデフォルト構成では VxTwitterAdapter がプライマリ、FxTwitterAdapter が
フォールバックである。

## 目的

- 通常の投票付きポストで、選択肢、得票数、得票率を Discord Embed に表示する。
- 同名の選択肢を Bot 内で重複排除せず、API が返した順序のまま表示する。
- 投票のない既存ポストの表示を変更しない。
- 外部 API の DTO を Core や Discord Adapter に漏らさない。

## スコープ外

- Discord 上から投票する機能
- 投票終了時刻や残り時間の表示
- 定期的な再取得による得票結果の更新
- FxTwitter が上流で重複排除した選択肢の復元
- 引用ポスト内の投票表示

FxTwitter のレスポンスだけでは、重複排除された選択肢の名前、個数、順序を復元できない。
そのため、VxTwitter から取得できた場合は正確な選択肢を表示し、FxTwitter への
フォールバック時は FxTwitter が返した内容を best-effort で表示する。

## ドメインモデル

`src/core/models/Tweet.ts` に API 非依存の投票モデルを追加する。

```typescript
export interface Tweet {
  // 既存フィールド
  poll?: TweetPoll;
}

export interface TweetPoll {
  options: TweetPollOption[];
}

export interface TweetPollOption {
  label: string;
  votes: number;
  percentage: number;
}
```

`poll` は投票が存在し、有効な選択肢が 1 件以上ある場合だけ設定する。`options` は配列の
順序と重複を保持する。終了時刻は vxTwitter から取得できず、プロバイダー間で一貫した
表示にできないため、今回の共通モデルには含めない。

## API Adapter の変換

### VxTwitterAdapter

`pollData.options` を次のように変換する。

| vxTwitter | Core |
| --- | --- |
| `name` | `label` |
| `votes` | `votes` |
| `percent` | `percentage` |

VxTwitter の OpenAPI では各フィールドが optional であるため、3 フィールドが揃った
選択肢だけを有効とする。空配列または有効な選択肢がない場合は `poll` を設定しない。
変換処理で `Set` などを使わず、同名の選択肢を保持する。

### FxTwitterAdapter

`poll.choices` を次のように変換する。

| FxTwitter | Core |
| --- | --- |
| `label` | `label` |
| `count` | `votes` |
| `percentage` | `percentage` |

FxTwitter の OpenAPI では各フィールドが必須である。空配列の場合は `poll` を設定しない。
上流ですでに重複排除された選択肢は復元しない。

### 引用ポスト

既存の再帰変換により引用ポストの `Tweet` にも `poll` は保持される。ただし、現在の
Embed は引用ポストについて作者、本文、URL だけを表示するため、今回の表示対象は
トップレベルのポストだけとする。

## Discord Embed

既存の 3 つのメトリクスフィールドの後に、投票がある場合だけ 1 フィールドを追加する。

表示例:

```text
:bar_chart: poll
1. 千冬ちゃん — 0 votes (0%)
2. 千冬ちゃん — 0 votes (0%)
```

- 行頭に番号を付け、同名の選択肢が複数あることを判別可能にする。
- 得票数と得票率は API の数値をそのまま表示する。
- 投票全体を 1 フィールドにまとめ、既存のメディアギャラリー構成を維持する。
- 複数メディアの場合、投票フィールドは本文と同様に先頭 Embed だけへ設定する。
- Discord Embed の field value 上限に合わせ、投票フィールドは最大 1,024 文字に
  切り詰める。超過時は末尾を `...` とする。

## テスト方針

### VxTwitterAdapter

- 投票情報を Core モデルへ変換できる。
- 同名の選択肢を順序どおり保持する。
- `pollData` がない場合は `poll` が `undefined` になる。
- 空の `options` または必須値が欠けた選択肢だけの場合は `poll` が `undefined` になる。

### FxTwitterAdapter

- 投票情報を Core モデルへ変換できる。
- API が返した選択肢の順序を保持する。
- `poll` がない場合または `choices` が空の場合は Core の `poll` が `undefined` になる。

### DiscordEmbedBuilder

- 投票フィールドに番号、ラベル、得票数、得票率が表示される。
- 同名の選択肢が別々の行に表示される。
- 投票がない場合は既存の 3 フィールドだけが生成される。
- 複数メディアの場合は先頭 Embed だけに投票フィールドが含まれる。
- 投票フィールドが 1,024 文字を超えない。

## ADR の要否

追加 ADR は作成しない。

今回の変更は、既存の ADR 0001 で決定済みの「外部 API DTO を Adapter で Bot 内部の
安定したドメイン契約へ変換する」という責務境界に従うもので、新しいアーキテクチャ上の
選択や責務変更を伴わないためである。

## 変更ファイル

- `src/core/models/Tweet.ts`
- `src/adapters/twitter/VxTwitterAdapter.ts`
- `src/adapters/twitter/FxTwitterAdapter.ts`
- `src/adapters/discord/EmbedBuilder.ts`
- `tests/unit/adapters/twitter/VxTwitterAdapter.test.ts`
- `tests/unit/adapters/twitter/FxTwitterAdapter.test.ts`
- `tests/unit/adapters/discord/EmbedBuilder.test.ts`

OpenAPI と生成コードには投票フィールドがすでに存在するため、今回の変更対象には含めない。

## 受け入れ条件

- 再現用ポストを VxTwitter 経由で取得したとき、同名の 2 選択肢が Discord Embed に
  別々の行として表示される。
- 投票のないポストの Embed JSON が投票対応前と同等である。
- `npm run lint`、`npm run compile:test`、関連する unit test、`npm run build` が通過する。

## 検証結果

- 全 unit test: 20 files / 258 tests passed
- `npm run lint`: passed
- `npm run compile:test`: passed
- `npm run build`: passed
- Issue の再現用ポスト: 同名の 2 選択肢を保持し、想定どおりの投票フィールドを生成
