# P0 の結果と K1 の判断

計画（docs/go-migration-plan.md）の P0 を 2026-11-24 に行った。結論は **K1 を通過、P1 に進める**。利用者の指示により、P1 には進まずここで止めている。

## 作ったもの

| もの | 場所 | 内容 |
|---|---|---|
| 偽の herdr | `tools/fakeherdr/` | Unix ソケットで herdr のふりをする。1 接続 1 リクエスト、購読は ack（遅らせる・返さないも可）のあとに一致するイベントだけを流す、受けたリクエストを全部記録する。`World` が snapshot と `agent.list` を答える |
| herdr-client のシナリオ | `tools/fakeherdr/scenarios.go` | 10 本。snapshot 中の状態変化（古い状態と新しい状態の 2 通り）、snapshot の重なり、ack の前の取りこぼし、ペイン集合の変化、古い購読が新しい購読の ack の前に切れる、購読の切断と再接続、ack が来ない（10 秒で諦める）、フォーカスと名前の変更 |
| TS 版のシナリオの記録 | `testdata/scenarios/*.json`、`tools/scenario-ts/run.ts`、`tools/fakeherdr/cmd/record-scenarios` | TS の herdr-client が各シナリオで出した状態変化、State、接続の変化 |
| Go の herdr-client の試作 | `internal/bridge/herdr_client.go`（State は `state_spike.go` の仮のもの） | 計画 §3.7 の actor。10 本すべてで TS の記録と一致 |
| 操作ごとの通信の記録 | `testdata/wire/*.json`（37 操作）、`tools/fakeherdr/cmd/record-wire` | TS の bridge と CLI が、操作ごとに herdr に送ったリクエストと、HTTP の応答、WS のメッセージ、CLI の出力 |
| テストの対応表 | `docs/go-migration/test-map.md`、`tools/testmap` | Go に移すテスト N = 232、TS に残るテスト 59（合計 291） |
| CI | `.github/workflows/ci.yml` の `go` ジョブ、`.github/dependabot.yml` | web のビルド → `go vet` → `go test -race` → govulncheck（v1.9.0 に固定）。Dependabot に gomod を追加（7 日の待ちつき） |

## 完了の条件の確認

| 条件 | 結果 |
|---|---|
| 確認 A の答えが出ている | 出た（下記） |
| 記録が `testdata/` にある | シナリオ 10 本、操作 37 件。2 回取って同じ内容になることを確かめた |
| actor の試作がシナリオの記録と一致する | 10/10 一致。`-race` で 3 回続けて通った。わざと壊した 2 通り（drain でのリセットを外す、`replayedPanes` を外す）は、それぞれ `status-during-snapshot-new` と `overlapping-snapshots` で落ちた。比較が空振りしていないことの確認になる |
| Go の骨組みで CI が通る | 手元で `go vet`、`go test -race ./...`、govulncheck、`npm test`（291 件）が通った。GitHub Actions の結果は PR に書く |

## 確認 A（herdr からバイナリを起動する）の答え

使い捨てのプラグイン `y011d4.agentweb-gospike` で確かめた。手元からの link と、使い捨てのブランチを使った GitHub からのインストールの 2 通りで試し、終わったら両方とも消した。

- **action と pane:** `command = ["./bin/…", …]` の相対パスで起動できる。カレントディレクトリはプラグインのルート。渡る環境変数は `HERDR_PLUGIN_ROOT`、`HERDR_PLUGIN_STATE_DIR`、`HERDR_PLUGIN_CONFIG_DIR`、`HERDR_SOCKET_PATH`、`HERDR_BIN_PATH`、`HERDR_PANE_ID`、`HERDR_WORKSPACE_ID`、`HERDR_TAB_ID`、`HERDR_PLUGIN_CONTEXT_JSON` など。pane にはさらに `HERDR_PLUGIN_ENTRYPOINT_ID` が渡る。
- **`[[build]]`（GitHub からのインストール）:** カレントディレクトリはプラグインのルート（サブディレクトリを指定すればそのサブディレクトリ）。`HERDR_*` の変数は渡らない。ネットワークに出られる（api.github.com が 200）。`curl`、`wget`、`sha256sum`、`shasum` がある。チェックアウトには `.git` があり HEAD はそのコミットだが、**タグはない**。計画 §8.2 の「タグではなく `release/checksums.txt` の行で落とすかを決める」で正しい。
- **インストール先:** herdr 0.9.5 では `~/.config/herdr/plugins/github-installations/<id>-<hash>/<世代>/checkout/<サブディレクトリ>`。更新のたびに世代のディレクトリが変わるので、**バイナリの絶対パスは更新ごとに変わる**。orchestrator の許可リストは bridge の起動時に書き直されるが、動いている orchestrator は再起動するまで古いパスのままになる（計画 P-2 に追記した）。

## P0 で見つかったこと

1. **state ディレクトリが 2 つある（今の TS 版からの不具合）。** herdr から起動すると `HERDR_PLUGIN_STATE_DIR` は `~/.local/state/herdr/plugins/y011d4.agentweb` になる。一方、CLI を herdr の外から手で動かすと、その変数がないので `~/.local/state/herdr-agentweb` を使う。この機械には両方があり、それぞれ token を持っている。手で `agentwebctl qr` を動かすと、動いている bridge とは違う token を出しうる。凍結中なので TS 版は直さず、Go 版で「`herdr plugin` の state ディレクトリを herdr に聞く」形に直し、違いの記録に書く（計画 P-7 に追記した）。
2. **`herdr plugin uninstall` はインストール先のディレクトリを残す。** README のアンインストールの手順に書く（計画 §8.4 に追記した）。
3. **CLI のアカウントの判定は、テストを動かす側の祖先にも反応する。** `ownAccount` は親をたどって最初の `claude` のアカウントを使うので、Claude Code の中から CLI のテストを動かすと、そのセッションのアカウントを拾う。記録は `setsid -f` で切り離して取った。P3 の Go の CLI のテストも、切り離して動かすか、判定の入口を差し替えられるようにする（計画 P3 に追記した）。
4. **version manager の shim（mise）は、HOME を変えると動かない。** 記録の道具は、先に本物の node の場所を聞いてから使う。

## 時間と、残りの見積もりの見直し

P0 の実装（偽の herdr、記録の道具 2 つ、actor の試作、テストの対応表、CI）は、Claude Code で約 25 分だった。書いた Go は空行を除いて約 2,400 行。計画では 3〜5 作業日と見積もっていた。

この差は、計画の「作業日」が人の手での作業を前提にしていたことによる。ただし、残りが同じ割合で縮むとは考えない。

- P0 は仕様がはっきりした道具づくりだった。P1 以降は既存のコード約 4,600 行とテスト 232 件の移植で、TS との違い（L2〜L9）を一つずつ確かめる必要がある。
- http.ts（977 行）と WS にはもとからテストがなく、P2 では通信の記録と合わせながら直す往復が増える。
- P4 の並走と試用は暦日で 7 日かかり、縮まない。
- PR ごとのレビュー（roborev と利用者）の待ち時間がある。

| 段階 | 計画の作業日 | 見直し（Claude Code での作業。レビュー待ちを含まない） |
|---|---|---|
| P1 | 6〜8 | 0.5〜1 日 |
| P2 | 9〜13 | 1〜2 日 |
| P3 | 3〜4 | 0.5 日 |
| P4 | 3〜4（と暦日 7 日） | 0.5〜1 日と暦日 7 日 |
| P5 | 2 | 0.5 日 |
| P6 | 4〜6 | 1〜2 日 |
| 合計 | 27〜37 と暦日 7 日 | 4〜7 日と暦日 7 日。レビュー待ちを入れて 2〜3 週間 |

凍結（P0 の手順 4 から P5 の手順 3 まで）は、この見直しで **2〜3 週間**の見込みになる。計画の 5〜7 週間より短い。

## K1 の判断

**通過。P1 に進んでよい。** 根拠は次の 2 つ。

1. **配れる:** herdr はプラグインのルートからの相対パスでバイナリを起動でき、`[[build]]` はネットワークに出られて検証に要る道具もある。計画 §8 の配り方（リリースから落としてチェックサムで検証する）はそのまま使える。
2. **一番危ない部分を移せる:** herdr-client の再接続とバッファの処理は、Go の actor で TS 版と同じ結果になった。比較の仕組みが、通知を失う誤りと二重に出す誤りの両方を捕まえることも確かめた。

P1 に入る前に決めておくことはない。凍結はこの P0 の記録（手順 4）から始まっている。
