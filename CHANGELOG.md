# Changelog

## [3.0.0](https://github.com/rx-twitter/rx-twitter/compare/v2.8.0...v3.0.0) (2026-08-01)


### ⚠ BREAKING CHANGES

* **discord:** v2 では動画をダウンロードせず、元の URL を MediaGallery へ直接埋め込む。アップロード上限の影響を受けなくなるため、上限超過による リンクボタンへの退避も発生しない。大きい動画もそのまま表示される。
* **discord:** 埋め込みの既定表示が Components v2 になる。動画は同じ Container 内へ収まり、これまでの別メッセージ投稿を行わない。スポイラーは ボタン方式からネイティブのぼかしへ変わる。従来の表示に戻す場合は guild 設定の embedVersion を v1 にする。
* **media:** media_max_file_size を設定していない環境では、添付上限が 5242800 バイトから 24.50MiB 以上へ引き上がる（Tier0 で約 4.9 倍）。これまで URL 送信に回されていた動画がファイルとして添付されるようになり、帯域と ディスク使用量が増える。抑えたい場合は media_max_file_size を明示すること。

### Features

* **config:** GuildConfig に embedVersion を追加する ([d761791](https://github.com/rx-twitter/rx-twitter/commit/d7617911e57c926874e14bdd24bbe789bd4e0548)), closes [#548](https://github.com/rx-twitter/rx-twitter/issues/548)
* **config:** GuildConfig に embedVersion を追加する（[#548](https://github.com/rx-twitter/rx-twitter/issues/548) の 1/4） ([db6dc33](https://github.com/rx-twitter/rx-twitter/commit/db6dc3360d1e56700586e65923ce2380ca2821bc))
* **discord:** Components v2 のツイート表現を追加する ([5b02a87](https://github.com/rx-twitter/rx-twitter/commit/5b02a87fa3e7b1aa5d84d0ca5c0ac846b81edb84)), closes [#548](https://github.com/rx-twitter/rx-twitter/issues/548)
* **discord:** Components v2 のツイート表現を追加する（[#548](https://github.com/rx-twitter/rx-twitter/issues/548) の 3a） ([ef06236](https://github.com/rx-twitter/rx-twitter/commit/ef06236c1136b173dede38fe67a19b5101d89c94))
* **discord:** v2 は動画URLを直接埋め込みダウンロードをやめる ([986afa2](https://github.com/rx-twitter/rx-twitter/commit/986afa24cb45f69ad3597da990a18b5bc7db52e2)), closes [#548](https://github.com/rx-twitter/rx-twitter/issues/548)
* **discord:** 動画URLを直接ギャラリーへ埋め込めるようにする ([0f9ef57](https://github.com/rx-twitter/rx-twitter/commit/0f9ef57e853540534ad779fba20a92711aa747e6)), closes [#548](https://github.com/rx-twitter/rx-twitter/issues/548)
* **discord:** 埋め込みを Components v2 で送信する ([4e9e8bc](https://github.com/rx-twitter/rx-twitter/commit/4e9e8bcfe82e6689c13aee271cb12f6eedf5c959)), closes [#548](https://github.com/rx-twitter/rx-twitter/issues/548)
* **media:** 添付上限を guild のブーストレベルから決定する ([a30298a](https://github.com/rx-twitter/rx-twitter/commit/a30298a1c5067f1562c0e789e2a42afcf187d667)), closes [#548](https://github.com/rx-twitter/rx-twitter/issues/548)
* **owner:** 埋め込み方式の使用状況を表示するコマンドを追加する ([af48315](https://github.com/rx-twitter/rx-twitter/commit/af48315734cb7fd1171c943d216682715555321c)), closes [#548](https://github.com/rx-twitter/rx-twitter/issues/548)
* **owner:** 埋め込み方式の使用状況を表示するコマンドを追加する（[#548](https://github.com/rx-twitter/rx-twitter/issues/548) の 4/4） ([a269437](https://github.com/rx-twitter/rx-twitter/commit/a269437835d2ebc00356d9eca7841ae593c70817))


### Bug Fixes

* **discord:** v2 ヘッダのリンクを区別できるようにし余白を詰める ([6d8ace7](https://github.com/rx-twitter/rx-twitter/commit/6d8ace7f8bf223887563b72bafae504d314e5452))
* **discord:** v2 ヘッダのリンクを区別できるようにし余白を詰める ([fa7f4f4](https://github.com/rx-twitter/rx-twitter/commit/fa7f4f4409ff642111bddf8f6bf512f684f0aff1)), closes [#548](https://github.com/rx-twitter/rx-twitter/issues/548)
* **discord:** アイコン未設定のツイートが展開されない問題を修正する ([b732cf8](https://github.com/rx-twitter/rx-twitter/commit/b732cf863fbc647d25ffd791708b93c7459274d6))
* **discord:** スポイラーを Container 全体へ適用しアイコン無しに対応する ([1af2cd4](https://github.com/rx-twitter/rx-twitter/commit/1af2cd4023616af77e8b8714454ecf4914bd2348)), closes [#548](https://github.com/rx-twitter/rx-twitter/issues/548)
* **discord:** ヘッダと本文を同じ TextDisplay にまとめて余白を詰める ([fe8930b](https://github.com/rx-twitter/rx-twitter/commit/fe8930b6494913284f876205c5abf8cd699b9bb3)), closes [#548](https://github.com/rx-twitter/rx-twitter/issues/548)
* **discord:** 動画のダウンロード失敗を URL へフォールバックする ([d2e5235](https://github.com/rx-twitter/rx-twitter/commit/d2e5235c2889a7aad155b077e89518a7cbfe8a3d)), closes [#548](https://github.com/rx-twitter/rx-twitter/issues/548)
* **discord:** 動画を File ではなく MediaGallery に入れる ([3368446](https://github.com/rx-twitter/rx-twitter/commit/33684462d89d64003c8b7639340128cd46e683fa)), closes [#548](https://github.com/rx-twitter/rx-twitter/issues/548)
* **discord:** 空文字の iconUrl で Embed 生成が失敗する問題を修正する ([fd7795f](https://github.com/rx-twitter/rx-twitter/commit/fd7795f78880e20dd04495dbf167f4905722b8d4)), closes [#583](https://github.com/rx-twitter/rx-twitter/issues/583)
* **media:** Tier0/Tier1 の添付上限を 10MiB に修正する ([57dc2de](https://github.com/rx-twitter/rx-twitter/commit/57dc2deb3654653bac09490b37b3e06d8af58153)), closes [#548](https://github.com/rx-twitter/rx-twitter/issues/548)
* **media:** 添付上限からマージンを差し引かない ([cb68d3d](https://github.com/rx-twitter/rx-twitter/commit/cb68d3d7b1555788a28054129fce8c1570d06f33)), closes [#548](https://github.com/rx-twitter/rx-twitter/issues/548)
* **owner:** Redis 障害を既定値 v2 と混同せず判定不能として示す ([cf327a8](https://github.com/rx-twitter/rx-twitter/commit/cf327a80f08cf4bb8d94c4954111e1457df7c797)), closes [#548](https://github.com/rx-twitter/rx-twitter/issues/548)
* **owner:** 判定不能を含めた内訳が矛盾しないようにする ([874004d](https://github.com/rx-twitter/rx-twitter/commit/874004d4cf192f1bdc5217ba6da675b6195a9139)), closes [#548](https://github.com/rx-twitter/rx-twitter/issues/548)
* **scripts:** プレビューの一時ファイルを送信後に削除する ([5754a93](https://github.com/rx-twitter/rx-twitter/commit/5754a939ea058ee3cfae6befbbd63a2e6ae6211b)), closes [#548](https://github.com/rx-twitter/rx-twitter/issues/548)

## [2.8.0](https://github.com/rx-twitter/rx-twitter/compare/v2.7.0...v2.8.0) (2026-08-01)


### Features

* **codex:** GitHub PRレビュースキルを追加 ([8940efd](https://github.com/rx-twitter/rx-twitter/commit/8940efdb7fd3cdc60c7bc3c0a83c98d3041779ab))
* **codex:** GitHub PRレビュースキルを追加 ([c90e05c](https://github.com/rx-twitter/rx-twitter/commit/c90e05c431ed54d1a93e404ce130f0ae4ec600f0))


### Bug Fixes

* **config:** フォールバック既定を allow に統一しドキュメントと一致させる ([250bd6f](https://github.com/rx-twitter/rx-twitter/commit/250bd6f565ce07a6d72154798990975115794cac))
* **config:** フォールバック既定を allow に統一し誤設定を警告する ([6bf60aa](https://github.com/rx-twitter/rx-twitter/commit/6bf60aa63e7b3b3e810403ef92771fa3b13a4468)), closes [#549](https://github.com/rx-twitter/rx-twitter/issues/549)
* **discord:** spoiler ボタンの待ち受けを collector に置き換えリスナーリークを解消 ([25dfd2b](https://github.com/rx-twitter/rx-twitter/commit/25dfd2b13e0c6b8f44a288220b22879c824fc0fc))
* **discord:** spoiler ボタンの待ち受けを collector に置き換える ([82748d7](https://github.com/rx-twitter/rx-twitter/commit/82748d7c51a418be430fc1a2e6fc7c787f4c9148)), closes [#550](https://github.com/rx-twitter/rx-twitter/issues/550)
* **fxtwitter:** API の返り値を入力型から出力型に正す ([77ede6c](https://github.com/rx-twitter/rx-twitter/commit/77ede6c3e48eb73b412f3469ecc69914d218b8a5)), closes [#559](https://github.com/rx-twitter/rx-twitter/issues/559)
* **fxtwitter:** 型ガードで Twitter 以外の status を弾き、弾いた理由をログに残す ([5cc291f](https://github.com/rx-twitter/rx-twitter/commit/5cc291f5cb8b43b2dbe86e3a6fd81f0f2a8aa0c6))
* **fxtwitter:** 型ガードで Twitter 以外の status を弾く ([2a39df5](https://github.com/rx-twitter/rx-twitter/commit/2a39df51cf43ffb4d98d2f3c247a920629838092)), closes [#563](https://github.com/rx-twitter/rx-twitter/issues/563)
* **http:** 同期 throw でタイマーが残りプロセスが落ちる問題を修正 ([6fbd646](https://github.com/rx-twitter/rx-twitter/commit/6fbd646c49abd1d0e90f32da9319480a7bbcf182)), closes [#575](https://github.com/rx-twitter/rx-twitter/issues/575)
* **http:** 成功したリクエストのタイマーを解除し幽霊 ERROR ログを止める ([d68800f](https://github.com/rx-twitter/rx-twitter/commit/d68800fdd6ac445f757891f8a8ab36d2ed90fbdc))
* **http:** 成功したリクエストのタイマーを解除し幽霊 ERROR を止める ([a774c5c](https://github.com/rx-twitter/rx-twitter/commit/a774c5c630bbb20be1ed3858cac15ead942481a4)), closes [#575](https://github.com/rx-twitter/rx-twitter/issues/575)
* **logging:** JSON以外のレスポンスをwarnで記録しスタックトレースを外す ([#566](https://github.com/rx-twitter/rx-twitter/issues/566)) ([99dbdab](https://github.com/rx-twitter/rx-twitter/commit/99dbdab998a5e28156beba471e071c0aa8e6ad2a))

## [2.7.0](https://github.com/rx-twitter/rx-twitter/compare/v2.6.0...v2.7.0) (2026-07-30)


### Features

* **announcement:** お知らせDM機能 Phase1（Redis Streams 配信） ([865f0da](https://github.com/rx-twitter/rx-twitter/commit/865f0da8eae5bae0e133325e3a96f236308b20f0))
* **announcement:** お知らせDM機能 Phase1（Redis Streams 配信） ([03a9084](https://github.com/rx-twitter/rx-twitter/commit/03a9084933aeef74d9078cd05590cd9abc07eb74)), closes [#425](https://github.com/rx-twitter/rx-twitter/issues/425)


### Bug Fixes

* **announcement:** DLQ保存失敗の握り潰しとNOGROUP未回復を修正 ([4a11134](https://github.com/rx-twitter/rx-twitter/commit/4a11134791dc7e475b1e2e2e849c3018524f1593)), closes [#425](https://github.com/rx-twitter/rx-twitter/issues/425)
* **announcement:** PR [#552](https://github.com/rx-twitter/rx-twitter/issues/552) レビュー対応（配信保証・DLQ・health） ([262ab64](https://github.com/rx-twitter/rx-twitter/commit/262ab64a2d853920b688c49d3f70937f69cb0e27))

## [2.6.0](https://github.com/rx-twitter/rx-twitter/compare/v2.5.0...v2.6.0) (2026-07-26)


### Features

* 投票付きポストのEmbed表示に対応 ([977c4fc](https://github.com/rx-twitter/rx-twitter/commit/977c4fcb1265fa1315527201ba0f93ba839e9d14))
* 投票付きポストのEmbed表示に対応 ([2a4120a](https://github.com/rx-twitter/rx-twitter/commit/2a4120a9025ce018756d20c0f37f53bdb2e61960))
* 記事URLのベストエフォート展開に対応 ([a880555](https://github.com/rx-twitter/rx-twitter/commit/a880555eaf36b0d5ee1e7ff50049b5d4ad94de62))
* 記事URLのベストエフォート展開に対応 ([c269170](https://github.com/rx-twitter/rx-twitter/commit/c26917009c09fbfe133960c77647392b315a6179))

## [2.5.0](https://github.com/rx-twitter/rx-twitter/compare/v2.4.5...v2.5.0) (2026-07-22)


### Features

* OpenAPIスペックに必須フィールド・animated_gif・5XXレスポンスを反映 ([41e710d](https://github.com/rx-twitter/rx-twitter/commit/41e710d29415352a64c20139f8bb9f8743cd117f))
* Orvalでfxtwitter/vxtwitterのZod検証付きfetchクライアントを生成 ([2f40d41](https://github.com/rx-twitter/rx-twitter/commit/2f40d418c4e0e2cabe6ea4b1f6fb1b5c9de7e3bf))
* Orvalでfxtwitter/vxtwitterのZod検証付きfetchクライアントを生成 ([465b55a](https://github.com/rx-twitter/rx-twitter/commit/465b55a59ab1b10348da170c94c1396ae817ab8c))
* Zod検証処理を導入 ([cc3182d](https://github.com/rx-twitter/rx-twitter/commit/cc3182df4b18d7aca8e9f6574d64a46eae64ee36))


### Bug Fixes

* APIレスポンス検証と生成DTO型の整合性を修正 ([09efa8e](https://github.com/rx-twitter/rx-twitter/commit/09efa8e0111d8e0e4dc1ba4c31244dcd6e0364fc))

## [2.4.5](https://github.com/rx-twitter/rx-twitter/compare/v2.4.4...v2.4.5) (2026-07-19)


### Bug Fixes

* **discord:** Embed内のメンションエスケープ表示を修正 ([fc3228b](https://github.com/rx-twitter/rx-twitter/commit/fc3228b4933e58c249d4831615e3b70cd2522f68))
* **discord:** Embed内のメンションエスケープ表示を修正 ([5904ccb](https://github.com/rx-twitter/rx-twitter/commit/5904ccb91fcec2176afa45ffdb915eb3ea39a182))

## [2.4.4](https://github.com/rx-twitter/rx-twitter/compare/v2.4.3...v2.4.4) (2026-07-13)


### Bug Fixes

* **discord:** Embed内のメンション装飾を修正 ([9f91a8e](https://github.com/rx-twitter/rx-twitter/commit/9f91a8e6c07da9de4e4124891c0b2d8d1211ac64))
* **discord:** Embed内のメンション装飾を修正 ([528913e](https://github.com/rx-twitter/rx-twitter/commit/528913eacba284ffcf9c4aeff81229bc356a36df))
* Embed内のメンション装飾を修正 ([64ee859](https://github.com/rx-twitter/rx-twitter/commit/64ee859928e16aeb0342a80734f899b29eacddfa))

## [2.4.3](https://github.com/rx-twitter/rx-twitter/compare/v2.4.2...v2.4.3) (2026-07-13)


### Bug Fixes

* logの出力先を修正 ([b1666af](https://github.com/rx-twitter/rx-twitter/commit/b1666af5ee834ffe8af2af7cd9ccb6c5e988c7f9))
* logの出力先を修正 ([3232d2a](https://github.com/rx-twitter/rx-twitter/commit/3232d2ad47bb68504fa3759af9a18a0e3c46a61c))

## [2.4.2](https://github.com/rx-twitter/rx-twitter/compare/v2.4.1...v2.4.2) (2026-07-07)


### Bug Fixes

* suppressEmbedsを遅らせた ([bb73d15](https://github.com/rx-twitter/rx-twitter/commit/bb73d15055ba63d773550a07c46c22c6b676405e))
* suppressEmbedsを遅らせた。[#63](https://github.com/rx-twitter/rx-twitter/issues/63)の軽減 ([3aede93](https://github.com/rx-twitter/rx-twitter/commit/3aede935d23be0b5f118e40d0322ade7be43ade4))
* suppressEmbedsを遅らせた。[#63](https://github.com/rx-twitter/rx-twitter/issues/63)の軽減。 ([75ab51f](https://github.com/rx-twitter/rx-twitter/commit/75ab51f6b1b084f57b4c17b9a139401c955b6760))

## [2.4.1](https://github.com/rx-twitter/rx-twitter/compare/v2.4.0...v2.4.1) (2026-07-04)


### Bug Fixes

* **deps:** update dependency js-yaml to v5 ([a824717](https://github.com/rx-twitter/rx-twitter/commit/a82471706bccf7ce6612155acc8de5af56ba5bcc))
* **deps:** update dependency js-yaml to v5 ([c2a8b52](https://github.com/rx-twitter/rx-twitter/commit/c2a8b52cd08ffe90e7342337a1d1e3e557ac48f0))
* **deps:** update dependency redis to v6 ([a36d3fa](https://github.com/rx-twitter/rx-twitter/commit/a36d3fa2e6cfca523d42280ef34b0f2c1812492b))
* **deps:** update dependency redis to v6 ([dffed48](https://github.com/rx-twitter/rx-twitter/commit/dffed487e251f0010c358e8122f930d656b9ada3))
* DMのintentを設定 ([0099925](https://github.com/rx-twitter/rx-twitter/commit/009992580d009549f7a4c4049d8b1b57ded167d3))
* DMのintentを設定 ([a9269c8](https://github.com/rx-twitter/rx-twitter/commit/a9269c8f32c6692f5b207f7d9e5298c9babd88a7))

## [2.4.0](https://github.com/twitterrx/discord-twitter-embed-rx/compare/v2.3.0...v2.4.0) (2026-06-18)


### Features

* **adapters:** media_extended/media.all のフォールバック対応と animated_gif 統一 ([977b36a](https://github.com/twitterrx/discord-twitter-embed-rx/commit/977b36ac855dc4e88599a73545c7ee3837e271bd))
* vxTwitter/FxTwitterのメディアURL取得をmedia_extended/media.allに変更 ([e9e8b56](https://github.com/twitterrx/discord-twitter-embed-rx/commit/e9e8b56529cc98bae0bc7a5d8ead785ff248a1c4))
* vxTwitter/FxTwitterのメディアURL取得をmedia_extended/media.allに変更 ([a496a3d](https://github.com/twitterrx/discord-twitter-embed-rx/commit/a496a3dc04295dd14103392c5c6afb6174c28df9))


### Bug Fixes

* Media型のoptionalフィールド修正とフォールバック時のtype判定修正 ([052bd53](https://github.com/twitterrx/discord-twitter-embed-rx/commit/052bd53fcb71f2a650890679e214ff541b85d801))

## [2.3.0](https://github.com/twitterrx/discord-twitter-embed-rx/compare/v2.2.0...v2.3.0) (2026-06-11)


### Features

* ユーザーBAN・サーバーBAN・脱退機能を追加 ([#473](https://github.com/twitterrx/discord-twitter-embed-rx/issues/473)) ([50ad1a3](https://github.com/twitterrx/discord-twitter-embed-rx/commit/50ad1a3b2a8ca256c481c8b5f3549e2e17830db6))

## [2.2.0](https://github.com/twitterrx/discord-twitter-embed-rx/compare/v2.1.0...v2.2.0) (2026-05-09)


### Features

* 1メッセージあたりの最大URL処理数機能を追加 ([d6194e7](https://github.com/twitterrx/discord-twitter-embed-rx/commit/d6194e74e93abdadcc75febff21a61395f3736d5))
* 1メッセージあたりの最大URL処理数機能を追加 ([7807b5a](https://github.com/twitterrx/discord-twitter-embed-rx/commit/7807b5a749d002281323b5be201ac830aa86b718))
* 1メッセージあたりの最大URL処理数機能を追加 ([3099f95](https://github.com/twitterrx/discord-twitter-embed-rx/commit/3099f95b9dc91ea6a69640dbc37f3ed4ca7c7035))
* 定数追加 ([3900c9d](https://github.com/twitterrx/discord-twitter-embed-rx/commit/3900c9d186f525221acea983f87e07d356c0515e))
* 定数追加 ([834c6ce](https://github.com/twitterrx/discord-twitter-embed-rx/commit/834c6ce271ebe89e33a3d370b0527b0d7fa06c20))
* 定数追加 ([e320783](https://github.com/twitterrx/discord-twitter-embed-rx/commit/e3207831e74244526e6c467ef9119bd8c66f8ff7))

## [2.1.0](https://github.com/t1nyb0x/discord-twitter-embed-rx/compare/v2.0.1...v2.1.0) (2026-03-31)


### Features

* axiosで通信していた箇所をfetchに変更 ([77e53b4](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/77e53b49c6036eb8138a73eb52acc2ab8ed893e9))

## [2.0.1](https://github.com/t1nyb0x/discord-twitter-embed-rx/compare/v2.0.0...v2.0.1) (2026-03-30)


### Bug Fixes

* Embedの構築処理を修正 ([8e7972c](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/8e7972ce567a3f19d373e2022db2170da6a3f698))

## [2.0.0](https://github.com/t1nyb0x/discord-twitter-embed-rx/compare/v1.16.0...v2.0.0) (2026-03-30)


### ⚠ BREAKING CHANGES

* ダッシュボード機能実装

### Features

* feat:  ([509a8d2](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/509a8d2c44cc16ea2a1d993f4c5ce22e384617f2))
* add dashboard as git submodule ([6f19081](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/6f19081681fc1cef36f95e6d6c774ef8fc0a92a9))
* add shared types package for Bot and Dashboard ([cc38f5b](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/cc38f5b5d8ea64e92fb9a65f013c2946ee7a4960))
* Dashboard UI実装 ([5186804](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/5186804a7a9023b56966c24c7d0458d00719e1d0))
* Dashboard UI実装 ([97b1744](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/97b1744f03793c6a8e30e4cab2d7bef8fc747026))
* Dashboard ロギング充実化 ([63646c6](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/63646c6a6874bc4a6fdbdc832bd8125e897d91a0))
* GC実装、E2Eテスト作成 ([5912b7e](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/5912b7e12e43912e7f4d8ad4e99619e6627071f1))
* ダッシュボード機能実装 ([08ac961](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/08ac96102c798f290bdb97b16d8eb72de629f098))
* ダッシュボード機能更新 ([54a7f85](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/54a7f85bcd2da423dbc6eeeda65615c77bbdba8e))
* ダッシュボード機能更新 ([359e6c9](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/359e6c9364e4669d3877ca1c22864685fd29994a))
* デプロイ設定周り作成 ([c938dc7](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/c938dc7036224c9512aa2a3d74dad71c4bfa16a2))
* メッセージ受診時の低頻度channelsリフレッシュ実装 ([0318677](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/03186778fa0e269fd14be82dc724a1b497453579))
* 基盤構築 ([4f98024](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/4f98024f10ed75c1278ff0577f0f5e0aacbd88f5))


### Bug Fixes

* Redisのポート開放を削除 ([f54ab2d](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/f54ab2d2b6911875052bc69573ca0545de10ffd7))
* Redis書き込みタイミング修正 ([08fcbe9](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/08fcbe906fc355bc7b0ef798e69a0e4127ebfda7))
* Redis書き込みタイミング修正 ([9d1c1ae](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/9d1c1ae305da708bd3ad8fbdf9dbf4d008e2830d))
* タイムアウト、サイズ制限追加 ([c9d7aa0](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/c9d7aa0e2336f073967fbf33550f1daee73c97ee))
* 型エラー修正 ([74b35d5](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/74b35d5c6aab4561b7c8bda4ed18c20c4cf13c39))

## [Unreleased]

### Added

- **Dashboard v2.0 (Phase 4 - Deployment)**
  - Docker Compose 3コンテナ構成（Bot / Dashboard / Redis）
  - nginx リバースプロキシ対応（compose.yml.with-nginx）
  - named volume 方式による永続化
  - Oslo + Arctic への認証システム移行

### Changed

- **認証ライブラリの移行** (P0対応)
  - lucia-auth から Oslo (セッション管理) + Arctic (OAuth2) へ移行
  - 移行理由: lucia-auth の非推奨化に対応し、より軽量で保守性の高いライブラリへ移行
  - セッション管理: Oslo の Session API を使用
  - OAuth2: Arctic の Discord Provider を使用
  - Cookie 属性・TTL は従来通り維持（7日間、HttpOnly, Secure, SameSite=Lax）

### Technical Notes

Oslo + Arctic への移行による変更点：
- セッションIDの生成: `generateSessionId()` (Oslo の encodeBase32LowerCaseNoPadding 使用)
- セッション検証: `validateSession()` (Redis から直接取得・検証)
- OAuth2フロー: Arctic の `createAuthorizationURL()` / `validateAuthorizationCode()` を使用
- Cookie 管理: `getSessionCookieAttributes()` でセキュア属性を制御

---

## [1.16.0](https://github.com/t1nyb0x/discord-twitter-embed-rx/compare/v1.15.0...v1.16.0) (2026-01-10)


### Features

* ロギング処理改修 ([d425902](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/d425902344b9839317db25c759c91123b5beedab))

## [1.15.0](https://github.com/t1nyb0x/discord-twitter-embed-rx/compare/v1.14.1...v1.15.0) (2026-01-09)


### Features

* [@screen](https://github.com/screen)_name をリンク化する処理を追加 ([f503bd8](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/f503bd8a30a12b99f132ef36a348c0741f000273))
* [@screen](https://github.com/screen)_name をリンク化する処理を追加 ([eb590aa](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/eb590aa9fa19052e24db70c58103b407e7782637))

## [1.14.1](https://github.com/t1nyb0x/discord-twitter-embed-rx/compare/v1.14.0...v1.14.1) (2026-01-07)


### Bug Fixes

* 投稿URL削除時Bot側で投稿したメディアURL投稿を含めて削除するように修正 ([bed3dc2](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/bed3dc2db27776d85d429f82752ab9028646df3d))
* 投稿URL削除時Bot側で投稿したものをメディア投稿を含めて消すように。 ([6bf9590](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/6bf95903a193bccefacd88eaaf90b19a9eecfdf0))

## [1.14.0](https://github.com/t1nyb0x/discord-twitter-embed-rx/compare/v1.13.4...v1.14.0) (2026-01-06)


### Features

* SPOILER時動画投稿・URL投稿をしないように ([9a36404](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/9a3640422285b9e147c01b8235bc8f75dc7877e9))


### Bug Fixes

* エフェメラルで動画URLを出すように変更 ([b17fcaf](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/b17fcaf7e99a1fc77840df2da230004479dba339))
* エフェメラルに動画を表示するように ([8cff910](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/8cff91086239fc07a7d05eabe8806ba75dc3317f))

## [1.13.4](https://github.com/t1nyb0x/discord-twitter-embed-rx/compare/v1.13.3...v1.13.4) (2025-12-15)


### Bug Fixes

* vxtwitterリクエストエラー時のフォールバック対応実装 ([fe9c6ba](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/fe9c6bab5701f99946dcc33f4a7ca214d1be0c5a))
* vxtwitterリクエストエラー時のフォールバック対応実装 ([acd1356](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/acd13563067dfd983bddbedb09108b1cb51f714b))

## [1.13.3](https://github.com/t1nyb0x/discord-twitter-embed-rx/compare/v1.13.2...v1.13.3) (2025-11-22)


### Bug Fixes

* trigger release-please ([6ae1064](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/6ae1064fa77edc12732e1b24a717f8c67d399841))

## [1.13.2](https://github.com/t1nyb0x/discord-twitter-embed-rx/compare/v1.13.1...v1.13.2) (2025-11-01)


### Bug Fixes

* trigger release-please ([9649388](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/9649388182b31b47b269655ae6b1ff534fe4f4a6))
* trigger release-please ([094ff91](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/094ff91238f112e3286d57c1e9e6ac5f19812474))

## [1.13.1](https://github.com/t1nyb0x/discord-twitter-embed-rx/compare/v1.13.0...v1.13.1) (2025-09-12)


### Bug Fixes

* **deps:** update dependency @discordjs/builders to v1.11.3 ([38ab990](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/38ab990fd6fd7f6506536860eec3cf506eaf9521))
* **deps:** update dependency @discordjs/builders to v1.11.3 ([5d7774f](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/5d7774f7b4a72f728d236f689af0baa734f66d77))
* **deps:** update dependency discord.js to v14.22.1 ([b1cf086](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/b1cf086616bbfe51fb484ca35e1a21ed8d10188c))
* **deps:** update dependency discord.js to v14.22.1 ([d178b7f](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/d178b7f1a1f3ad6769e8fcfc5a73ae56770fea2f))
* **deps:** update dependency redis to v5.8.2 ([574664d](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/574664ddbd95e9d3157837630ec1e590665425ac))
* **deps:** update dependency redis to v5.8.2 ([3af81f1](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/3af81f1f537302c712d1e4a09e735b35f8a46d66))

## [1.13.0](https://github.com/t1nyb0x/discord-twitter-embed-rx/compare/v1.12.0...v1.13.0) (2025-08-05)


### Features

* Redis導入 ([9d57fb9](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/9d57fb9dc0278ba4ad19d160dd36d31c1107b8a6))
* Redis導入, 元メッセージ削除時にそこに返信している自発言を削除するように ([7f076f5](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/7f076f52ebf43599678bf27913c71873392f123c))
* Redis導入, 元メッセージ削除時にそこに返信している自発言を削除するように ([c92f7ce](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/c92f7ce638f70f2056b6fd7e1c6ca6ad20a202da))


### Bug Fixes

* **deps:** update dependency axios to v1.11.0 ([8f0aaeb](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/8f0aaeb6dbfe6f91486089b726946c8350da4251))
* **deps:** update dependency redis to v5.8.0 ([64e5fb1](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/64e5fb13f8e1702b09771535890bb8bd50e9e6a1))
* **deps:** update dependency redis to v5.8.0 ([27d7ac5](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/27d7ac5a20538f4fc30d6064e0b72346edcfa5d9))

## [1.12.0](https://github.com/t1nyb0x/discord-twitter-embed-rx/compare/v1.11.0...v1.12.0) (2025-08-03)


### Features

* ツイートが入ったメッセージの削除時にそこに紐づいたBot送信内容を削除する ([2153785](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/2153785fb284dacf5e803253e3fc09fefda367a5))
* ツイートが入ったメッセージの削除時にそこに紐づいたBot送信内容を削除する ([d4c22c6](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/d4c22c6d7a758ee4384364ef1c76de30d0fddf3c))
* 入力中を表示するようにした ([4e59b68](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/4e59b68a80bf72a903244c717fdae1652d975178))


### Bug Fixes

* Content-Length取得失敗時はファイルサイズ上限を超えたものとして扱う ([85232ce](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/85232ce401727f6ea16bd919c3d58b86283f3c0f))
* **deps:** update dependency @discordjs/builders to v1.11.2 ([3c0ad0b](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/3c0ad0b55cff281c282d2f96dd3e75e922a8284e))
* **deps:** update dependency axios to v1.10.0 ([238ed68](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/238ed68231fb0eb5f2bdc737f08cb1d7c0239b9c))
* **deps:** update dependency axios to v1.10.0 ([6036a13](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/6036a13a1d0cf3ef10f40f90ff335860c47634df))
* **deps:** update dependency axios to v1.8.2 ([eb3d6b3](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/eb3d6b32736a508a36eec43f3aa65ffaf0836f3b))
* **deps:** update dependency axios to v1.8.2 ([753e02b](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/753e02b8e4d4f0d29e73ffbca7c3a7cdfbd4f4b9))
* **deps:** update dependency axios to v1.8.3 ([0388efb](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/0388efb3df9939ab1ac4e6ddae633130c52bb3c6))
* **deps:** update dependency axios to v1.8.3 ([020f411](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/020f41172b12a58cd9b7c4aaad2383eba194de11))
* **deps:** update dependency axios to v1.8.4 ([0b51147](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/0b5114743d154ca4ddc8d59d3f442ee66741f38c))
* **deps:** update dependency axios to v1.8.4 ([0012b72](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/0012b722ff001488a83d24e6d9f1618dc4f23a59))
* **deps:** update dependency axios to v1.9.0 ([935c9d6](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/935c9d6480df4b76b034d371841556bee724232a))
* **deps:** update dependency discord.js to v14.19.3 ([9025d2d](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/9025d2d8489f0f51d19c955c131cbbaa6e0bed4d))
* **deps:** update dependency discord.js to v14.21.0 ([f028e49](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/f028e499ce0f86e39f22c6b0effdfb7937204566))
* **deps:** update dependency discord.js to v14.21.0 ([f0a605e](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/f0a605e3662d4b2c1c5b0ac540fbf82328ae3923))
* dockerfile ([a23f6e1](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/a23f6e1eaf77d7eb107cd734e5f45ba78758cffc))
* dockerfile ([f361776](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/f361776314fbb800db533369177bbeab3bc22061))
* TweetServiceのメソッドを明示的にreturnするように変更 ([6d48a21](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/6d48a21c5ab8bdef10caa8428c0bd0c8984d1292))
* 入力中表示タイミングを変更 ([cace33f](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/cace33f8aa3fd4290bd161757811ceb75fba5af5))
* 入力中表示タイミングを変更 ([d238d4f](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/d238d4f6dbffe3544d214189d20333f6bc093efc))
* 画像も投稿されてしまう問題を修正 ([e024ff9](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/e024ff91ba690cb4d4445b8fadd4ee99d4b97d2f))

## [1.11.0](https://github.com/t1nyb0x/discord-twitter-embed-rx/compare/v1.10.0...v1.11.0) (2025-03-01)


### Features

* 入力中を表示するようにした ([4e59b68](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/4e59b68a80bf72a903244c717fdae1652d975178))


### Bug Fixes

* Content-Length取得失敗時はファイルサイズ上限を超えたものとして扱う ([85232ce](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/85232ce401727f6ea16bd919c3d58b86283f3c0f))
* dockerfile ([f361776](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/f361776314fbb800db533369177bbeab3bc22061))
* TweetServiceのメソッドを明示的にreturnするように変更 ([6d48a21](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/6d48a21c5ab8bdef10caa8428c0bd0c8984d1292))
* 画像も投稿されてしまう問題を修正 ([e024ff9](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/e024ff91ba690cb4d4445b8fadd4ee99d4b97d2f))

## [1.10.0](https://github.com/t1nyb0x/discord-twitter-embed-rx/compare/v1.9.3...v1.10.0) (2025-02-28)


### Features

* 入力中を表示するようにした ([4e59b68](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/4e59b68a80bf72a903244c717fdae1652d975178))


### Bug Fixes

* Content-Length取得失敗時はファイルサイズ上限を超えたものとして扱う ([85232ce](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/85232ce401727f6ea16bd919c3d58b86283f3c0f))
* TweetServiceのメソッドを明示的にreturnするように変更 ([6d48a21](https://github.com/t1nyb0x/discord-twitter-embed-rx/commit/6d48a21c5ab8bdef10caa8428c0bd0c8984d1292))
