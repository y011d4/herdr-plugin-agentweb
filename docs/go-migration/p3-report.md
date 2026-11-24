# P3 の結果

計画（docs/go-migration-plan.md）の P3 を 2026-11-24 に行った。CLI の移植は終わり、完了の条件を満たした。P3 の終わりに計画上の判断点はない（K3 は P2 の終わり、K4 は P4）。K5（急ぎの機能のために凍結を解く）にも当たらない。P4 は本番の herdr に Go 版をつなぐので、利用者の承認を待って止めている。

## 作ったもの

| TS | Go | 内容 |
|---|---|---|
| `bin/agentwebctl.ts` | `internal/bridge/cli.go`、`cmd/agentwebctl/main.go` | `run`、`start`、`stop`、`status`、`qr`、`overview`、`agent get/read/prompt/wait/start`、`worktree remove`、`orchestrator start`。`run` は bridge を同じプロセスで動かす。`start` は自分を `serve` で切り離して起動する。pidfile の PID が bridge かどうかはコマンドラインで見る（計画 X7。D15） |
| — | `defaultStateDir`（`cli.go`）と `loadConfig` | herdr の外で動かしたときの state の場所を herdr と同じにした（D2） |
| — | `tools/fakeherdr/cmd/record-wire` | CLI も Go のバイナリで記録して比べる。CLI の操作を 9 件から 23 件に増やし、TS 版で記録し直した（TS のコードは変えていない。既存の記録は 1 件も変わらなかった） |

増やした CLI の記録: herdr の CLI に確かめたペインとフラグを渡すこと（read、prompt、wait。prompt は名前で頼んでペイン ID が渡ること）、使い方の誤り 6 通り、ほかのアカウントの dir への `agent start` と worktree の `remove` を断ること、`orchestrator start` の名前の誤り、bridge がないときの `status` と `stop`、`qr`。

記録の道具は、偽の `direnv`（dir の `.envrc` を読む）、`tailscale` と `qrencode`（どちらもないふり）を使うようにした。この機械の tailnet の名前などが記録に入らず、CI に direnv を入れなくて済む。CLI は 1 回ずつ `setsid -f` で切り離して動かす。この機械の Claude Code の中からでも、CI でも同じ結果になる。

## 完了の条件の確認

| 条件 | 結果 |
|---|---|
| CLI の比較と、通信の記録の `cli-` の操作がすべて一致する | 23/23（REST と WS を合わせて 51/51）。標準出力、標準エラー、終了コード、herdr へのリクエスト、herdr と gh の CLI に渡した引数を比べる。違いとして読み替えるのは、使い方の行の `agentwebctl.js` と `agentwebctl` の差（D15）だけ。わざと prompt でペイン ID の代わりに名前を herdr に渡すと、その 1 件だけが落ちる |
| §5.5 の残り（action の出力にトークンを出さない） | `TestGoLifecycleCommands`: 一時的なディレクトリと空いたポートで `status`、`start`、`start`（2 回目）、`status`、`run`（断られる）、`stop`、`stop` を順に動かす。どの出力にもトークンがないこと、`bridge.log` が 0600 であることを確かめる。あわせて、別のプロセスの PID が書かれた pidfile を `status` が消し、`stop` がそのプロセスにシグナルを送らないこと、`run` が自分の PID を書いて `stop` で 0 で終わることも確かめる |

ほかに次も通る。

- 単体テスト: bridge の見分け方、state の場所の選び方（D2）、CLI の RPC のエラーの文言、ポートの読み方
- `go vet`、`go test -race ./...`
- `npm test`（301 件）、`npm run check:contract`
- テストの対応表 232/232

**本物の herdr での確認（読むだけ）:** この機械の herdr に TS 版と Go 版の `overview` を向けると、41 行の出力が一致した（経過時間の表示を除く）。自分のペインへの `agent get` も、アカウントの確認を通って herdr の CLI に同じものを渡した。

## 計画からずれたこと、見つかったこと

1. **Go の `stop` を本物の state ディレクトリで動かすと、動いている Node の bridge を止める。** Go の CLI は、P5 の切り替えのために Node の bridge（`main.js`）も bridge と認める（計画 X7）。そのため `HERDR_PLUGIN_STATE_DIR` を付けずに動かすと、herdr の本物の state ディレクトリの pidfile を読み、本番の bridge に SIGTERM を送る。
   - ライフサイクルのテストを書いたとき、後片づけの `stop` に一時的な環境を渡し忘れていた。実行の前に Claude Code の安全確認が止めたので、本番の bridge には何も起きていない（8390 の PID は最初から同じ）。テストは直し、テストがバイナリを起動するすべての所で一時的な環境を渡すことを確かめた。
   - P4 では、Go の CLI を動かすとき必ず一時的な `HERDR_PLUGIN_STATE_DIR` を付ける（下の「P4 で利用者にしてもらうこと」にも書いた）。
2. **テストの中の `run` はゾンビになる。** テストが `run` の親なので、SIGTERM の後もテストが回収するまで PID が残り、`stop` が 5 秒待って失敗した。本番では herdr が pane のプロセスを回収するので起きない。テストですぐに回収するようにした。
3. **D2 の `XDG_STATE_HOME` は推定。** herdr が plugin の state の場所を出すコマンドはない。`herdr plugin config-dir` は `XDG_CONFIG_HOME` を見ていたので、state も `XDG_STATE_HOME` を見ると推定した。この機械では `XDG_STATE_HOME` は設定されていないので、結果は今の場所（`~/.local/state/herdr/plugins/y011d4.agentweb`）になる。
4. **違いの記録に D15、D16 を足し、D2 を P3 で入れた形に書き直した**（docs/go-migration/divergences.md）。
5. 記録の道具の README にあった「2 回記録すると同じファイルになる」は、`overview` の並行して送るリクエストの順番では成り立たなかった。比較は、同じメソッドが続く所を順不同として扱う。

## P4 で利用者にしてもらうこと

P4 は計画 §4 のとおり、4a（読むだけの並走、暦日 3 日）と 4b（試用、暦日 4 日）に分かれる。比べるための道具（`tools/shadowdiff`）を作るのは P4 の作業で、こちらで行う。

**始める前に**
- P4 を始めてよいかの承認。4a の間、Go 版は本物の herdr のソケットにつながる（Go 版から herdr に書き込むのは、4b でこちらが使い捨てのタブに対して確かめるときと、利用者が携帯から Go 版を使うときだけ）。

**4a の始め方（こちらで行う。利用者がすることはない）**
- 今の `config.json` を一時的な場所にコピーする。`notify_url` を消し、orchestrator の各項目に今のディレクトリを `dir` として書く。こうすると Go 版は orchestrator のディレクトリに何も書かない。
- Go の bridge を `127.0.0.1:8391` で起動する。state と data のディレクトリは一時的な場所にし、本物の `XDG_DATA_HOME` は使わない。
- 比較の道具を 3 日動かす。説明のつかない違いがなければ 4b に進む。

**4b で利用者にしてもらうこと**
- 携帯から Go 版に入る道を足す: `tailscale serve --bg --https=8443 8391`（`--https=8443` を付け忘れると、本番の 443 の割り当てが置き換わる）。実行の前後に `tailscale serve status` で 443 が 8390 のままであることを見る。入るための URL（Go 版のトークンつき）はこちらで用意する。
- 携帯で Go 版を何日か普段どおり使い、次を確かめる（使い捨てのタブで、こちらと一緒に）:
  - 送信が 1 回で確定する（1 行、複数行、大きな貼り付け）
  - 手で打った下書きが混ざらない
  - AskUserQuestion の選択肢を数字で選べる
  - 画面全体を使うペインのスクロール
  - 完了の印（見た記録）、ブランチの表示、日本語の表示
  - 通知が来る
- clear は、試用を始めた時点でもうあった agent と、Go 版から起動した agent にだけ使う（それ以外は今までの携帯の接続で clear する。計画 4b の 3）。
- 試験用の orchestrator（一時的な場所と試験用の config）での確認に付き合う（計画 4b の 4）: `overview`、ほかのアカウントの拒否、worktree の作成と削除、`agent prompt --wait` で起こされること。

**戻し方（P4 の間は本番を何も変えないので、止めて片づけるだけ）**
- Go の bridge を止める: Go の `agentwebctl stop` を、**起動したときと同じ一時的な `HERDR_PLUGIN_STATE_DIR` を付けて**動かす。付けないと、上の 1 のとおり本番の Node の bridge を止める。
- 8443 の割り当てを消す: `tailscale serve --https=8443 off`。`tailscale serve reset` は使わない（本番の 443 の割り当ても消える）。消した後で `tailscale serve status` を見て、443 が 8390 のまま残っていることを確かめる。
- 一時的なディレクトリを消す。本番の Node の bridge、config、orchestrator のディレクトリ、herdr のプラグインの設定は、P4 の間は一度も変えない。

## 時間と、残りの見積もり

| 段階 | 計画の作業日 | P2 後の見積もり | 実際 |
|---|---|---|---|
| P0 | 3〜5 | — | 約 25 分（レビュー対応を含めて約 35 分） |
| P1 | 6〜8 | — | 約 45 分 |
| P2 | 9〜13 | — | 約 50 分（レビュー対応を含めて約 1 時間 15 分） |
| P3 | 3〜4 | 0.5 日 | 約 20 分（13:53〜14:13。PR のレビュー対応を除く） |

- **これからの作業（Claude Code での作業日。レビュー待ちを含めない）:**
  - P4（比較の道具、並走と試用の準備と確認）: 0.5〜1 日と暦日 7 日
  - P5（切り替え）: 0.5 日
  - P6（配布）: 1〜2 日
- **全体:** 2〜3.5 日と暦日 7 日。レビュー待ちと利用者の確認を入れて約 2 週間。
- **凍結:** P5 の手順 3 まで。P4 の暦日 7 日があるので、あと 1.5〜2 週間の見込み。
