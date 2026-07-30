---
name: issue-to-merge
description: Drive a GitHub issue from intake to a green, reviewed PR in this repo (rx-twitter). Clarify with Q&A before coding, file cross-linked companion issues, implement TDD following existing patterns, pass the quality gates, triage review feedback honestly, keep CI green, and verify by actually running the code.
---

# issue-to-merge

このリポジトリ（`rx-twitter/rx-twitter`、Dashboard は submodule `rx-twitter/rx-twitter-dashboard`）で、
機能追加・改修を「起票 → 設計 Q&A → TDD 実装 → 品質ゲート → レビュー対応 → CI 緑 → 動作確認」まで
一貫して進めるための手引き。今回うまくいった進め方を再現する。

## When to Use

- Issue を立てたい／既存 Issue の実装に着手する
- レビュー指摘に対応する（PR コメント / review）
- Bot と Dashboard の両方に跨る機能
- 「まず質疑応答してから作って」と頼まれたとき

---

## 貫く原則

- **確かめてから動く**: 推測で実装・起票しない。まず該当コードを読む。分からない設計判断は Q&A で潰す。
- **正直なトリアージ**: レビュー指摘を全部鵜呑みにしない。「直す / スコープ外 / 別issue化 / 反論」を根拠付きで。
- **スコープを割る**: 既存バグ・別関心事は本流に混ぜず別 Issue に切り出す。
- **秘密は相手が扱う**: トークン等の資格情報は自分で持たない。credentialed な実行はユーザーに `! <cmd>` で依頼。
- **default ブランチを汚さない**: `develop` 直ではなく feature ブランチを切る。コミット/PR はユーザーが望んだときだけ。

---

## Phase 1 — Intake & 設計 Q&A（コード前）

1. **現状把握**: 触る周辺を読む。似た実装（サービス/リポジトリ）を1つ「テンプレート」として特定する。
   - 例: 新サービスは `BanService` + `RedisBanRepository` + そのテストを雛形にする。
   - DI は `src/index.ts` のみで配線。他ファイルで `new` による依存解決をしない（AGENTS.md）。
2. **理解を共有**: 見つけた構造・制約を短くまとめてユーザーに提示する（「私の理解」）。
3. **Q&A で設計を確定**: `AskUserQuestion` で分岐を潰す。各設問の先頭に自分の推しを置く。
   - ユーザーが「まず確認したい」と返したら、質問を組み直してから再提示する。
   - 決定は表にして復唱する。

## Phase 2 — Issue 起票

- **cross-repo は companion issue**: Bot 側を親、Dashboard 側を別リポに立てて相互リンク（`owner/repo#N`）。
  - `gh issue create --repo <r> --title ... --label enhancement --body-file <f>`
  - 親を先に作り番号を得て、子に参照を入れ、親にも子番号を追記する。
- 既存 Issue のスレッドに未回答の質問があれば、決定事項をコメントで**回答**する。
- 本文は「背景/目的・現状・決定事項(表)・技術メモ/制約・スコープ(チェックリスト)・非スコープ・関連」で構成。

## Phase 3 — TDD 実装

- feature ブランチを切る: `git checkout -b feat/<issue>-<slug>`。
- **テスト先行**（t-wada スタイル）。テストは `tests/unit/` に src と同じ構造で。外部依存はモック。
- 既存パターンを踏襲（命名・レイヤー・エラーハンドリング）。Core は外部依存ゼロ、Adapter/Infra で実装。
- **shared を変えたら `npm run build:shared`**（`@rx-twitter/shared` は dist 解決。忘れると compile/テストが古い型を見る）。
- 実装したら随時、下の品質ゲートを回す。

### 品質ゲート（コミット前に必ず、AGENTS.md）

```bash
npm run lint          # oxlint src/ tests/  — 警告/エラー ゼロ
npm run compile:test  # tsc -p . --noEmit   — 型エラー ゼロ
npm run build         # build:shared → clean → tsc → tsc-alias
npm run test:unit     # vitest（全ユニット）
```

- 実 Redis が要る統合テストは `RUN_REDIS_INTEGRATION=1` のときだけ走る設計にする（未設定で skip → ローカル/CI で Redis 無しでも壊れない）。ローカル検証は Docker の使い捨て Redis で:
  ```bash
  docker run -d --name twrx-test-redis -p 6390:6379 redis:8.2.2-alpine
  RUN_REDIS_INTEGRATION=1 REDIS_URL=redis://127.0.0.1:6390 npx vitest run tests/integration/<x>.test.ts
  docker rm -f twrx-test-redis
  ```

## Phase 4 — コミット

- **Conventional Commits**（`feat` `fix` `refactor` `docs` `test` `ci` `chore` …）、scope 可。焦点を絞って分割（feat / docs / test / ci を別コミットに）。
- 末尾に `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`。
- pre-commit フック（lint-staged: oxfmt/oxlint/tsc）が走る。整形差分は取り込まれる。
- push・PR はユーザーの指示があってから。PR base は `develop`。

## Phase 5 — レビュー対応

- 指摘ごとに**トリアージ表**を出す: `#`, 指摘, 判断（直す/スコープ外/既存の別問題/反論）。
- **直す**: 明確に正しい correctness/安全の指摘。
- **別issue化**: 既存コードの問題・別関心事（例: 既存の fallback 既定、リスナーリーク、CI 穴）は本流に混ぜず新 Issue に。
- **設計フォークは相談**: 実装形やアーキが大きく変わる判断（例: 単一 vs マルチインスタンス）は `AskUserQuestion` でユーザーに委ねてから着手（手戻り防止）。
- **反論も辞さない**: 過剰・的外れな指摘には根拠を添えて別案を出す。頭ごなしに従わない。
- 対応後: ADR / PR 本文を現行設計に更新し、PR にトリアージ表で**返信コメント**。

## Phase 6 — ADR（重要な設計判断）

- アーキ選択や、レビューで方針転換した場合は `docs/adr/NNNN-<slug>.md` を追加（既存の番号・体裁に合わせる）。
- Status / Date / Issue、Context / Decision / Consequences(Positive/Negative/Mitigation) を書く。
- 前提（例: 単一インスタンス）とトレードオフ（例: at-least-once で重複可能性）を明記する。

## Phase 7 — CI を緑にする

```bash
git push
gh run watch <run-id> --repo rx-twitter/rx-twitter --exit-status
gh pr checks <pr> --repo rx-twitter/rx-twitter
```

よくある落とし穴と対処:

- **shared/dist のキャッシュ古い**: CI が `packages/shared/dist` を lock ハッシュだけでキャッシュ → shared ソース変更が反映されず compile が落ちる。→ 該当ジョブで `npm run build:shared` を常時実行する。
- **skip されてたテストが起動して落ちる**: Redis サービスを足すと、到達性で起動する既存 E2E が動いて失敗することがある。→ 実 Redis が要るテストは**独立ジョブ**に隔離し、既存の skip 挙動を壊さない。
- **codecov/patch が赤**: 新規ファイルのカバレッジ不足。→ 未カバーの分岐（ループ/reclaim/起動系など）をモック注入の単体テストで埋める。ブロッキングループはモックを小さく遅延させて busy-loop を避ける。

## Phase 8 — 動作確認（テストで終わらない）

- 実コードを実際に走らせて挙動を見る。依存は Docker で用意。
- **秘密はユーザーが扱う**: Discord トークン等が要る実行は、手順を渡してユーザーに `!` で実行してもらう。
- Bot は outbound only で、compose の Redis はポート非公開。ホストから `redis-cli -u $REDIS_URL` は届かない → **コンテナ内で実行**する:
  ```bash
  docker exec TwitterRX_Redis redis-cli XADD app:announcement:stream '*' announcement '{...}'
  ```
- 外向き・不可逆・全体配信のような操作は、**影響範囲を警告**してから（例: 全ギルドのオーナーに一斉 DM → テストサーバ限定を促す）。

---

## Anti-patterns

- コードを読まずに Q&A や実装に入る。
- レビュー指摘を機械的に全部実装する（過剰実装・的外れ対応）。
- 既存バグを本流 PR に混ぜてスコープを膨らませる。
- shared を変えて `build:shared` を忘れる。
- CI を見ずに「たぶん緑」で放置する。
- ユーザーのトークンを自分で使う／credentialed な実行を勝手に走らせる。
