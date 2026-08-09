# ADR 0005: OpenAPI スペックは 3.1 で書き、nullable キーワードを使わない

- Status: Accepted
- Date: 2026-08-09
- Issue: #599

## Context

ADR 0001 の通り、OpenAPI を外部 API 契約の source of truth とし、orval で Zod スキーマを
生成してレスポンスを検証している。スペックが実レスポンスと乖離すると、検証が正常な
レスポンスを弾き、Embed が黙って展開されなくなる。

OpenAPI 3.0 で「null になりうる `$ref`」を書くのは難しい。3.0.3 の Schema Object は
`nullable` をこう定義している。

> A `true` value adds `"null"` to the allowed type specified by the `type` keyword,
> only if `type` is explicitly defined within the same Schema Object.

`nullable` が効くのは、同じ Schema Object に `type` が明示されている場合だけである。
`$ref` を指すスキーマに `type` は書けないため、`$ref` の隣に `nullable` を置く形は
どう書いても標準上は効かない。実際に使った3つの書き方は、いずれも別の形で壊れる。

| 書き方 | 生成される Zod | 問題 |
| --- | --- | --- |
| `{ "nullable": true, "allOf": [{ "$ref": ... }] }` | `APIUser.nullish()` | orval では意図通り。ただし同じ Schema Object に `type` がないため、標準上は `nullable` が効かない |
| `{ "$ref": ..., "nullable": true }` | `APIUser.nullish()` | 同上に加えて、3.0 の Reference Object は `$ref` 以外のプロパティを許さない。標準準拠のツールは sibling ごと無視する |
| `{ "allOf": [{ "$ref": ... }, { "nullable": true }] }` | `APIUser.and(zod.unknown().nullable())` | orval が `nullable` を落とす。null が `$ref` 側で弾かれ、**実際に壊れた** |

1つ目は #598 で「3.0 の正しい形」として採用したが、標準上の裏付けはなく、orval の挙動に
依存した暫定表現だった。

3.0 でも標準準拠に書く方法自体は存在する。`anyOf` で null 専用のスキーマを合成すればよい
（Alternatives を参照）。ただし「null」と言うためだけに、実データと無関係な `type` と
`nullable` と `enum` の3つを協調させる必要がある。我々はこれを書かず、代わりに壊れた
書き方を3つ書いた。#598 で踏んだ事故は3件。

- `media.videos[].publisher` — 動画ツイートが全滅
- `SocialThread.author` / `SocialConversation.author`
- `community.admin` / `community.creator` — コミュニティ投稿が全滅

壊れた3つの書き方は、一般的な OpenAPI validator では検出できない。`@apidevtools/swagger-parser` は dereference
してから検証するため、`$ref` の sibling は消えた後の姿しか見ない。実際、修正前のスペックも
検証を通ってしまった。

## Decision

スペックは OpenAPI 3.1 で書き、`nullable` キーワードを使わない。null は型として表す。

```json
{ "type": ["string", "null"] }
{ "anyOf": [{ "$ref": "#/components/schemas/APIUser" }, { "type": "null" }] }
```

- 対象は `openapi/` 配下の3スペック全部。`fxtwitter.openapi.json` は orval の入力ではないが、
  `fxtwitter.status-only.openapi.json` を切り出す元ネタなので、3.0 のまま残すと再流入する。
- `tests/unit/openapi/nullableSchema.test.ts` で「`nullable` が1つも残っていない」
  「スペックが 3.1 を宣言している」を検査する。
- orval は 8.22.0 のままとする。3.1 の扱いに新しいバージョンは必要ない。

### 3.1 化そのものは事故を防がない。防ぐのは構造テストである

3.1 に上げても旧形式は書けてしまう。3.1 の Schema Object は JSON Schema 2020-12 の方言で、
未知のキーワードを annotation として受け入れるため、`nullable` を書いてもエラーにならない。
手元で検証した結果は以下の通り。

| 3.1 スペックに書いた形 | validator | orval 8.22.0 の生成結果 |
| --- | --- | --- |
| `{ "$ref": ..., "nullable": true }` | 通過 | `APIUser.nullish()` |
| `{ "allOf": [{ "$ref": ... }, { "nullable": true }] }` | 通過 | `APIUser.and(zod.unknown().nullable())` — **3.0 と同じく壊れる** |

つまり 3.1 化は間違いを書けなくするわけではない。事故を止めているのは構造テストのほうである。

3.1 化の価値は、**その構造テストを1本の全称ルールにできる**ことにある。

3.0 では `nullable` は正当に必要だった。`type` が明示されたスキーマでの `nullable` は
標準準拠で、実際 170 箇所がこれに当たる。だから「`nullable` を書くな」とは言えず、
「`$ref` に sibling を置くな」「`allOf` の要素に裸の `nullable` を置くな」のように、
既知の壊れた形を列挙するしかなかった。列挙は必ず次の形を取りこぼす。事実、2つ目の
ルールは3件目の事故が起きてから足している。

3.1 では `nullable` はどこに書いても意味を持たない。したがって「1つも現れない」という
単一の全称ルールが、まだ誰も思いついていない誤用まで含めて全部を覆う。
ブロックリストから不変条件に変わる。

## Alternatives

### 3.0 のまま、`anyOf` で標準準拠に書く

3.0 でも、null だけを受理するスキーマを `anyOf` で合成すれば標準に沿って書ける。

```yaml
anyOf:
  - $ref: "#/components/schemas/APIUser"
  - type: string
    nullable: true
    enum: [null]
```

2番目の分岐は同じ Schema Object に `type` があるため `nullable` が有効になり、
`enum: [null]` で null だけに絞られる。手元で検証したところ、
`@apidevtools/swagger-parser` は OAS 3.0.3 として validation に成功し、
orval 8.22.0 は `zod.union([APIUser, zod.literal(null).nullable()])` を生成した。
挙動も正しい（APIUser / null / undefined を受理し、無関係な値を拒否）。

つまり「3.0 には標準準拠の方法が存在しない」というのは誤りで、**存在するが冗長で
間違えやすい**が正しい。3.1 の同じ意味の表現と並べると差がはっきりする。

```yaml
# 3.1
anyOf:
  - $ref: "#/components/schemas/APIUser"
  - type: "null"
```

3.0 版は「null」と言うためだけに、実データと無関係な `type: string` と `nullable` と
`enum` の3つを協調させる必要がある。読み手はこの3行が「null 専用の分岐」だと
読み解かなければならない。実際、我々はこれを書かず、壊れた書き方を3つ書いた。

採用しない。標準準拠であることと、間違えずに書けることは別である。

### 3.0 のまま、書き方を1つに固定して構造テストで強制する

#598 で一度採った。「`$ref` に sibling を置かない」「`allOf` の要素に裸の `nullable` を
置かない」の2ルールを検査し、`{ "nullable": true, "allOf": [{ "$ref": ... }] }` に寄せる。

壊れた書き方を**見つける**ことはできるが、**間違えられなくする**ことはできない。しかも
寄せ先そのものが標準上は null を許可しない暫定表現なので、orval の挙動が変わった時点で
根拠を失う。3つ目の書き間違いが現れれば3つ目のルールを足すことになる。採用しない。

### orval を 8.24.0 に上げてから移行する

当初は 8.24.0 が前提だと考えていたが、8.22.0 でも 3.1 を正しく扱えることを実測で確認した。
バンプは import 形式が変わって全 23 生成ファイルが差分になり、3.1 の差分と混ざって検証
できなくなる。別に分ける（#601）。

### Schema Object の `example` も 3.1 の `examples` に揃える

3.1 で `example` は deprecated だが invalid ではない。差分を `nullable` に絞るため今回は
触らない。

## Consequences

- `nullable` を書いた時点でテストが落ちる。書けなくなるわけではなく、書けば必ず落ちる。
  この保証は 3.1 化ではなく構造テストが与えている。テストを消せば保護も消える。
- `X.nullish()` だった生成物が `zod.union([X, zod.null()]).optional()` になる。挙動は同じだが、
  生成物を読むときの見た目が変わる。
- 上流 FxEmbed が 3.0 でスペックを公開している場合、こちらへ取り込む際に 3.1 へ変換する
  手間が要る。変換は機械的だが、`enum` への `null` 追加など細部は目視確認が必要になる。
- `type: [X, "null"]` は orval が 3.0 の `nullable` と同じに扱う。この形の 170 箇所
  （FxTwitter フル 92、status-only 66、VxTwitter 12）は移行時に生成物の差分が出なかった。
