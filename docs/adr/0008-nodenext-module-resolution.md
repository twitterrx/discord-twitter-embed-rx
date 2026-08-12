# ADR 0008: モジュール解決を NodeNext に揃え、エイリアスを Node subpath imports で解決する

- Status: Accepted
- Date: 2026-08-13
- Issue: #614

## Context

`moduleResolution: "bundler"` を使っていたが、このプロジェクトにバンドラは無い。
`package.json` は `"type": "module"`、実行は `node dist/index.js` である。

ソースは Node ESM が解決できない形を書いていた。

```
from "./tweetText"          拡張子なし（手書き 23 箇所）
from "./generated/model"    ディレクトリ import（model はディレクトリ）
from "@/utils/logger"       エイリアス（手書き 100 箇所 / 36 ファイル）
```

橋渡しは `tsc-alias --resolve-full-paths` が担っていた。これは利便性ではなく
**正しさのために必須**の後処理で、外れれば本番で `ERR_MODULE_NOT_FOUND` になる。

この構成の問題は、**型検査が実行時の真実を語らないこと**である。TS は bundler 規則で、
Node は ESM 規則で解決する。不一致は原理的に消せず、検知することしかできない。
#591 で追加した `verify:dist` は検知器であって、負債の返済ではなかった。

### 当初「移行できない」とした判断は誤りだった

#591 では「orval（`npm run gen:api`）が拡張子なしで生成するため、NodeNext にすると
生成のたびに壊れる」として現状維持を選んだ。これは誤りである。orval は tsconfig を読んで
`.ts` → `.js` を付ける実装を持つ。

```js
// @orval/core
const NODE_NEXT_MODULES = new Set(["nodenext", "node16"]);
function getImportExtension(fileExtension, tsconfig) {
  if (NODE_NEXT_MODULES.has(module) || NODE_NEXT_MODULES.has(moduleResolution)) { ... }
  return fileExtension.replace(/\.ts$/, "");   // ← bundler 時はこちら
}
```

拡張子なしで生成されていたのは orval の制約ではなく、tsconfig が `bundler` だったからに
過ぎない。移行を阻む最大の根拠が成立していなかった。

## Decision

### 1. `module` / `moduleResolution` を NodeNext にする

型検査と実行時のモジュール解決規則を一致させる。相対 import には `.js` を明示し、
ディレクトリ import は `./foo/index.js` へ展開する。

`.js` が指す先は `.ts` だが、ESM の仕様では**出力後のファイル名**で書くのが正しい。
`packages/shared` は既にこの流儀である。

### 2. エイリアスは Node subpath imports で解決する

`@/*` を `#/*` へ改め、`package.json` の `imports` フィールドで宣言する。
`#` で始まる指定子は Node がランタイムで解決するため、後処理が要らない。

```json
{ "imports": { "#/*": "./dist/*" } }
```

tsc は指定子を書き換えないので、`#/utils/logger.js` は dist にそのまま残り、Node が
`./dist/utils/logger.js` へ解決する。これにより **`tsc-alias` を依存から外せる**。

型検査側は `tsconfig.json` の `paths` で解決する。

| 宣言 | 対象 | 用途 |
| --- | --- | --- |
| `tsconfig.json` の `paths` | `#/*` → `./src/*` | コンパイル時（tsc） |
| `package.json` の `imports` | `#/*` → `./dist/*` | 実行時（Node） |
| `vitest.config.ts` の `alias` | `#` → `./src` | テスト時（Vite） |

### 3. orval の残る穴は後処理で埋める

NodeNext 下でも orval はディレクトリを指す import（`from './model'`）に拡張子を付けない。
2 箇所だけ残るため、`scripts/fix-generated-imports.mjs` を `gen:api` の後段に置く。
実在するファイルを見て `.js` / `/index.js` を決め、冪等に動く。orval 側が対応したら
この後処理は不要になる。

### 4. `verify:dist` は役割を変えて残す

`tsc-alias` が消えても、エイリアスの宣言が 2 箇所に分かれている以上、片方だけ書き換えると
型検査は通って実行時に落ちる。`scripts/check-dist-resolution.mjs` はこの食い違いを
検査する役割に改めた。

**このスクリプト自身も、壊して確かめてから採用している。** 当初の実装は `dist` を決め打ちして
おり、`imports` を `./build/*` に書き換えても検査が通ってしまった（Node は
`ERR_MODULE_NOT_FOUND`）。実際の `imports` 宣言を読んで解決するよう直し、同じ壊し方で
65 件を検出することを確認した。

## Consequences

### Positive

- 型検査が通れば実行時にも解決できる。両者の規則が一致したため、#591 の時点で
  原理的に消せなかった不一致が無くなった。
- ビルドの正当性がサードパーティの後処理に依存しなくなった（`tsc-alias` を削除）。
- `compile` スクリプトが `npm run clean && tsc -p .` まで簡素になった。
- `packages/shared` と Bot 本体で import の流儀が揃った。

### Negative

- **相対 import に `.js` を書く必要がある**。指す先は `.ts` なので直感に反する。
  ESM の仕様どおりではあるが、慣れるまで摩擦がある。
- エイリアスの宣言が 3 箇所（tsconfig / package.json / vitest.config.ts）に分かれる。
  ビルド後処理を無くした代わりに、宣言の同期という別の約束事が生まれた。
- orval の穴を埋める後処理スクリプトを 1 つ抱える。

### Mitigation

- 宣言の食い違いは `npm run verify:dist` が CI の build ジョブで検査する。
- `.js` の流儀と 3 箇所の宣言は AGENTS.md のコーディング規約に表で記載した。
- orval の後処理は冪等で、`gen:api` に組み込んであるため実行忘れが起きない。
  CI の `gen-api-check` が生成物の最新性を検証している。

## 検証

- `tsc -p . --noEmit`: 0 errors（移行前、NodeNext に切り替えただけの状態では 191 errors）
- `npm run test:unit`: 531 passed
- 実 Redis での統合・E2E: 22 passed / 15 skipped
- `node dist/index.js`: 全モジュールが解決され、Discord トークン不足という設定エラーで停止
  （`ERR_MODULE_NOT_FOUND` ではない）
- **本番 Docker イメージ**をビルドして起動し、同じく設定エラーで停止することを確認
  （runner ステージは `package.json` を含むため `imports` が効く）
- `gen:api` を 2 回実行して同じ結果に収束することを確認

## Alternatives considered

- **`paths` + `tsc-alias` のまま NodeNext へ移る**: `.js` は明示されるが、エイリアス解決は
  後処理に依存したままで、負債の本体が残る。
- **エイリアスを廃してすべて相対 import にする**: 後処理も subpath imports の宣言も不要で
  最も単純だが、深い相対パス（`../../../utils/logger.js`）が 100 箇所生まれ、可読性が落ちる。
- **`bundler` を維持する**: #591 の判断。型検査が実行時の真実を語らない状態が続く。
  検知器で保有を安全にはできても、返済にはならない。
