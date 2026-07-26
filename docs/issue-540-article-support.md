# Issue #540 記事ポスト対応 設計

## ステータス

実装済み

## 背景

Xの記事には、次の2種類のURLがある。

- 記事を共有したポスト: `https://x.com/{screenName}/status/{statusId}`
- 記事本体: `https://x.com/i/article/{articleId}`

VxTwitter/FxTwitterは、記事付きポストの取得時には記事タイトル、プレビュー、
カバー画像などを返す。一方、記事本体URLを直接指定しても取得できず、
記事IDから共有元ポストを検索する無償かつ安定した公開APIもない。

## 要件

- 有料のX APIは使用しない。
- 記事付きポストURLでは、既存のVxTwitter/FxTwitterから取得できる範囲を表示する。
- Botが過去に観測した記事は、記事本体URLからも共有元ポストを解決する。
- 未観測の記事本体URLは、誤った情報を表示せず、共有元ポストURLの送信を案内する。
- Redisや解決処理の失敗で、通常のポスト展開を停止しない。

## 対象範囲

### 対象

- `Tweet`モデルへの記事プレビュー追加
- VxTwitter/FxTwitterレスポンスから記事プレビューへの変換
- 記事プレビューのDiscord Embed表示
- 記事IDと共有元ポストURLのRedis保存
- 記事本体URLの抽出と、保存済み対応関係による解決
- キャッシュミス時の案内

### 対象外

- X APIの有料プラン
- 非公開GraphQL APIやログインCookieを使うスクレイピング
- 記事本文全体の再現
- 未観測の記事IDから共有元ポストを探索する処理

## ドメインモデル

`Tweet`に、外部API間で共通して取得できるプレビュー情報を追加する。

```typescript
export interface TweetArticle {
  id?: string;
  title: string;
  previewText: string;
  imageUrl?: string;
}

export interface Tweet {
  // 既存フィールド
  article?: TweetArticle;
}
```

VxTwitterの記事オブジェクトには記事IDがないため、ポスト本文に含まれる
`x.com/i/article/{articleId}`から補完する。IDを特定できない場合も、
ポストURLからの記事プレビュー表示は行うが、Redisへの対応関係保存は行わない。

## URL処理

`TweetProcessor`は次を抽出する。

- ポストURL
- 記事本体URL

記事本体URLからは`articleId`を抽出する。`MessageHandler`は記事本体URLを受け取ると、
`ArticlePostService`へ共有元ポストURLの解決を依頼する。

```text
記事本体URL
  ├─ Redisヒット → 共有元ポストURLを既存TwitterAdapterへ渡す
  └─ Redisミス   → 共有元ポストURLの送信を案内する
```

## 対応関係の保存

記事付きポストを正常取得し、`article.id`が得られた場合に次を保存する。

```text
key:   app:article:{articleId}:post
value: 共有元ポストURL
TTL:   90日
```

記事と共有元ポストの対応は同一IDについて安定しているため、再観測時はTTLを更新する。
保存・読取エラーはstructured metadata付きで記録し、呼び出し元には例外を伝播しない。

## Embed表示

- タイトル: 記事タイトル
- URL: 共有元ポストURL
- 本文:
  - ポスト本文が記事URLだけ、または空の場合は記事プレビュー
  - コメント付きポストの場合はポスト本文と記事プレビュー
- 画像: 通常メディアがなければ記事カバー画像
- 著者、時刻、メトリクスなど既存情報は維持する

Discordの上限に合わせ、タイトルは256文字、本文は4096文字へ切り詰める。

## 失敗時の扱い

- VxTwitterに記事情報がなくてもFxTwitterへの既存フォールバックを利用する。
- FxTwitterにも記事情報がなければ通常ポストとして表示する。
- Redis障害時も記事付きポストのEmbedは表示する。
- 記事本体URLが解決できなかった場合は、元メッセージのEmbedを抑制せず案内を返す。
- 複数URLのうち1件以上を展開できた場合のみ、元メッセージのEmbedを抑制する。

## テスト方針

- `TweetProcessor`: 記事URL抽出、記事ID抽出
- Twitter adapters: 記事プレビュー変換、VxTwitterの記事ID補完
- FxTwitter schema: 未知の記事本文要素を許容し、プレビュー取得を継続
- `ArticlePostService`: 保存、解決、例外時の継続
- Redis repository: キー、TTL、キャッシュミス
- `EmbedBuilder`: 記事タイトル、プレビュー、画像、長さ制限
- `MessageHandler`: キャッシュヒット、ミス、観測時保存、Embed抑制条件
