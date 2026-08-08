# ADR 0005: OpenAPI スペックは 3.1 で書き、nullable キーワードを使わない

- Status: Accepted
- Date: 2026-08-09
- Issue: #599

## Context

ADR 0001 の通り、OpenAPI を外部 API 契約の source of truth とし、orval で Zod スキーマを
生成してレスポンスを検証している。スペックが実レスポンスと乖離すると、検証が正常な
レスポンスを弾き、Embed が黙って展開されなくなる。

OpenAPI 3.0 には「null になりうる `$ref`」を正しく書く方法が実質1つしかない。

```json
{ "nullable": true, "allOf": [{ "$ref": "#/components/schemas/APIUser" }] }
```

ここから外れた2つの書き方は、どちらも検証を壊す。しかも壊れ方が静かで、生成された
Zod を読まない限り気づけない。

| 書き方 | 生成される Zod | 問題 |
| --- | --- | --- |
| `{ "$ref": ..., "nullable": true }` | `APIUser.nullish()` | orval では動く。3.0 の Reference Object は `$ref` 以外のプロパティを許さないため、標準準拠のツールは `nullable` を無視する。無視されれば null が弾かれる |
| `{ "allOf": [{ "$ref": ... }, { "nullable": true }] }` | `APIUser.and(zod.unknown().nullable())` | orval が `nullable` を落とす。null が `$ref` 側で弾かれる |

#598 でこの事故を3回踏んだ。

- `media.videos[].publisher` — 動画ツイートが全滅
- `SocialThread.author` / `SocialConversation.author`
- `community.admin` / `community.creator` — コミュニティ投稿が全滅

一般的な OpenAPI validator では検出できない。`@apidevtools/swagger-parser` は dereference
してから検証するため、`$ref` の sibling は消えた後の姿しか見ない。実際、修正前のスペックも
検証を通ってしまった。

## Decision

スペックは OpenAPI 3.1 で書き、`nullable` キーワードを使わない。null は型として表す。

```json
{ "type": ["string", "null"] }
{ "anyOf": [{ "$ref": "#/components/schemas/APIUser" }, { "type": "null" }] }
```

3.1 は `nullable` を廃止しているため、上記2つの間違いは構文として存在できなくなる。

- 対象は `openapi/` 配下の3スペック全部。`fxtwitter.openapi.json` は orval の入力ではないが、
  `fxtwitter.status-only.openapi.json` を切り出す元ネタなので、3.0 のまま残すと再流入する。
- `tests/unit/openapi/nullableSchema.test.ts` で「`nullable` が1つも残っていない」
  「スペックが 3.1 を宣言している」を検査する。
- orval は 8.22.0 のままとする。3.1 の扱いに新しいバージョンは必要ない。

## Alternatives

### 3.0 のまま、正しい書き方を構造テストで強制する

#598 で一度採った。「`$ref` に sibling を置かない」「`allOf` の要素に裸の `nullable` を
置かない」の2ルールを検査する。

間違いを**見つける**ことはできるが、**間違えられなくする**ことはできない。3.0 の表現力の
限界そのものは残るため、3つ目の書き間違いが現れれば3つ目のルールを足すことになる。採用しない。

### orval を 8.24.0 に上げてから移行する

当初は 8.24.0 が前提だと考えていたが、8.22.0 でも 3.1 を正しく扱えることを実測で確認した。
バンプは import 形式が変わって全 23 生成ファイルが差分になり、3.1 の差分と混ざって検証
できなくなる。別に分ける（#601）。

### Schema Object の `example` も 3.1 の `examples` に揃える

3.1 で `example` は deprecated だが invalid ではない。差分を `nullable` に絞るため今回は
触らない。

## Consequences

- `nullable` を書いた時点でテストが落ちる。間違った書き方に到達できない。
- `X.nullish()` だった生成物が `zod.union([X, zod.null()]).optional()` になる。挙動は同じだが、
  生成物を読むときの見た目が変わる。
- 上流 FxEmbed が 3.0 でスペックを公開している場合、こちらへ取り込む際に 3.1 へ変換する
  手間が要る。変換は機械的だが、`enum` への `null` 追加など細部は目視確認が必要になる。
- `type: [X, "null"]` は orval が 3.0 の `nullable` と同じに扱う。この形の 158 箇所は移行時に
  生成物の差分が出なかった。
