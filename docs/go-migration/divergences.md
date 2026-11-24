# 違いの記録

計画（docs/go-migration-plan.md）の原則 2 にもとづく記録。Go 版が TS 版と違う動きをしてよいのは、ここに理由と一緒に書いたものだけである。並走や記録との比較でこれ以外の違いが出たら、Go 版を直す。

## 意図して変える

| # | 違い | 理由 | 段階 |
|---|---|---|---|
| D1 | herdr からの応答とイベントを行ごとに読む。TS 版は届いた塊ごとに UTF-8 に戻すので、塊の境目で分かれた多バイト文字が壊れる（`server/herdr-client.ts:80,232`） | TS 版の不具合。Go 版は `bufio` で行を読むので起きない | P0（試作で済み） |
| D2 | herdr の外から CLI と bridge を動かしたときの state の既定の場所を、herdr と同じ `$XDG_STATE_HOME`（なければ `~/.local/state`）`/herdr/plugins/y011d4.agentweb` にする（計画 P-7）。そこに token がなく、TS 版の既定の場所 `~/.local/state/herdr-agentweb` にだけあるときは、そちらを使い続ける。herdr が `XDG_STATE_HOME` を見るかは確かめていない（herdr を起動し直さないと確かめられない。`config-dir` は `XDG_CONFIG_HOME` を見ていたので、同じと推定した） | TS 版では herdr から起動したときと場所が違い、token が 2 つできる（P0 で発見）。herdr の外からつないでいた携帯の接続は切らない | P3 |
| D3 | WS の送信が詰まった接続は閉じる。Node は際限なく溜める | coder/websocket の `Write` は止まるため、接続ごとに上限つきのバッファを持つ（計画 §3.7）。携帯は再接続して最新の State を受け取る | P2 |
| D4 | ntfy への送信で `HTTP_PROXY` などを使う。Node の fetch は使わない | Go の HTTP クライアントの既定。外に出るのは `notify_url` だけなのは変わらない | P2 |
| D5 | herdr の CLI を、どこでも「`HERDR_BIN_PATH` があればそれ、なければ PATH」で探す（計画 X6） | TS 版は通知と agent のコマンドで探し方が違う | P6 |
| D6 | 文字数で切り詰めるとき、絵文字などの 2 単位の文字を半分に割らない（`jsSlice`）。TS 版は割った片方を残す | 割った片方は不正な文字で、JSON にすると壊れる。日本語などほかの文字では TS 版と同じ結果になる | P1 |
| D7 | 型の崩れたイベントの扱い: `tab_renamed` の `label` が文字列でなければ無視する（TS 版は数値をそのままラベルにする）。`pane_focused` に `pane_id` がなければ `focused.paneId` を null にする（TS 版は JSON からその項目が消える） | herdr はどちらも文字列で送る（schema）。壊れた入力でだけ起きる | P1 |
| D8 | 検出した agent の種類が launch profile の名前に完全には一致しないとき、部分一致で選ぶ順番: 既定の 3 つ（claude、codex、opencode）の次は名前順。TS 版は config.json に書いた順 | Go の map には順番がない。部分一致が 2 つ以上の独自 profile に当たるときだけ違う | P1 |
| D9 | 壊れた入力や珍しい環境でだけ出る細かい差: JSON の中の U+2028・U+2029 は Go が必ずエスケープする（TS はしない。読めば同じ値）。transcript の時刻は RFC 3339 だけ読む（Claude Code が書く形。`Date.parse` はほかの形も読む）。JSON の入れ子が 1 万段を超える transcript の行は飛ばす。rules.md の置換で `$` を特別扱いしない（TS の `replaceAll` は `$&` などを置き換え、許可リストとずれていた）。`.envrc` が残した子が管を握ったままのとき、`dirAccount` は 1 秒で諦める（TS は 15 秒）。agentwebctl の場所がわからないときは何にも当たらない空の許可を書く。config.json に float64 の範囲を超える数（`1e400` など）があると、Go は config.json 全体を読まずに既定で動く（TS の `JSON.parse` はその数を Infinity として読み、ほかの項目は使う。P4 の roborev の指摘） | どれも実際の herdr と Claude Code の出力では起きない。比べるときは JSON を読んでから比べる | P1 |
| D10 | token を作り直すとき、0600 の一時ファイルに書いてから置き換える。TS 版は古いファイルに書いてから 0600 にする | 古い token ファイルが壊れていて、しかもほかの人が読める権限だった場合に、新しい token が一瞬読める（roborev の指摘）。bridge は自分ではそういうファイルを作らないので、TS 版は凍結の決まりにより直さず、切り替えの後の堅牢化とする | P1 |
| D11 | 本文が 64 KB を超えたリクエストに 413 を返してから接続を閉じる。TS 版は `req.destroy()` で先に接続を切るので、413 は届かず、クライアントには空の応答になる（P2 で確かめた: curl は "Empty reply from server"） | 拒否するのは同じ。web は 64 KB を超える本文を送らない | P2 |
| D12 | 静的ファイルは、バイナリに埋め込んだビルド済みのもの（`embed.go` の拡張子のパターン）だけを返す。TS 版は `web/` の下のファイルを何でも返していた（`web/src/*.ts` や `web/test/` も） | 計画 P-4 のとおり。web が読むのはビルド済みのファイルだけ。開発では `AGENTWEB_WEB_DIR` でディスクから返せる | P2 |
| D13 | リクエストのパスを、送られてきた形のまま扱う。TS 版は WHATWG の URL で `.` と `..`（`%2e` を含む）を解決してから扱う。WS 以外へのアップグレード要求とトークンのないアップグレード要求に返す 404・401 に、Go の HTTP サーバーが付けるヘッダー（Content-Length など）が付く | ブラウザは解決してから送るので、手で作ったリクエストでだけ違う。どちらでも `/api` はトークンが要り、静的ファイルはディレクトリの外に出ない（`http_test.go` で確かめる） | P2 |
| D14 | 細かい差: herdr のソケットにつながらないときなどのエラーの `message` の文言（Go の net の文言。`code` と HTTP の状態は同じ）。`/api/profiles` の並べ替えで、ASCII 以外の文字を含む名前の位置（TS の `localeCompare` は ICU の照合順。Go は ASCII の名前だけ同じ順に並べ、ほかは ASCII の後ろに符号位置の順で置く。web の新しい agent の選択欄は先頭の profile を選んだ状態で開くので、ASCII の名前では TS と同じ順にした。計画 L5 の「ASCII では差が出ない」は、大文字と記号の順で誤りだった）。`lines` や `after` に int の範囲を超える数を渡すと、`lines` は 400、`after` は無視する（TS はそのまま herdr やファイルの読み出しに渡す） | 文言は、herdr に届かないときに web のエラーのトースト（例: Stop failed）に出る。`code` と HTTP の状態は同じなので、web の動きは変わらない。範囲外の数は web の使い方では起きない。並べ替えは、launch profile の名前（config のキー）に ASCII 以外の文字を使ったときだけ、選択欄の並びと最初に選ばれている profile が変わる（例: `áb` は TS では `claude` の前、Go では後ろ）。選び直さずに起動すると、TS とは違う profile で agent が起動しうる。組み込みの profile はどれも ASCII で、そういう名前は利用者が config に書いたときだけ現れる。ICU の照合順をすべて写すには golang.org/x/text が要り、依存を増やさない方針（計画の原則 4）に反するので、記録にとどめる | P2 |
| D15 | CLI の作りの違い: 使い方の行で自分を `agentwebctl` と名乗る（TS は `agentwebctl.js`。通信の記録の比較ではこの差だけを読み替える）。`run` は bridge を同じプロセスで動かし、自分の PID を `bridge-run.pid` に書く（TS は node の子を起動してその PID を書く）。`start` は自分自身を `serve` で切り離して起動する。pidfile の PID が bridge かどうかは、コマンドラインが `agentwebctl serve` か `agentwebctl run` か（Linux は `/proc/<pid>/cmdline`、ほかは `ps`）で見て、P5 の手順 6 までは、同じチェックアウトの TS の bridge も認める。バイナリが `<root>/bin/agentwebctl` にあるときの `<root>/dist/server/main.js` と `<root>/server/main.ts` で、TS が見ていたのと同じ道である。Linux では、名前を変えたバイナリやシンボリックリンク経由で起動したものも、`/proc/<pid>/exe` が自分と同じなら認める（TS は名前の違いを考えなかった）。macOS などの `ps` の出力には引数の区切りがないので、`agentwebctl serve|run` は末尾の一致で見て（計画 X7）、TS の bridge は認めない（node とエントリのパスを区切れないため。TS の bridge を Go に切り替えるのは P5 のこの Linux の機械だけで、TS のコードは P6 の配布の前に消える） | 計画 P3 と X7 のとおり。Go の CLI は同じチェックアウトの Node の bridge も止められる（P5 の切り替えで要る）。そのぶん、本物の state ディレクトリで Go の CLI を動かすと危ない。同じチェックアウトのバイナリなら動いている Node の bridge を止め、別のチェックアウトのバイナリなら「動いていない」とみなして pidfile を消す（TS の CLI も、別のチェックアウトから動かすと同じ）。P4 では必ず一時的な `HERDR_PLUGIN_STATE_DIR` を付ける | P3 |
| D16 | TS 版が処理されない例外で落ちていた所（`worktree remove` と `agent start` で snapshot が取れないとき）は、エラーを 1 行出して終了コード 1 で終わる（TS はスタックトレースを出して 1）。接続の口でのエラーの文言は Go の net のもの（D14 と同じ）。`qr` の pane は、Enter を待つ間に標準入力が閉じたら終わる | どれも herdr が止まっているときなどの異常な場合だけ。終了コードは同じ | P3 |

## TS 版のまま残す（切り替えの後に直す候補）

移植ではまず TS 版と同じ動きにする（直すと記録と比べられなくなる）。次の 2 つは roborev が P0 の試作で指摘した。TS 版にも同じ問題がある。

| # | 動き | 起きる条件 | 直し方の候補 |
|---|---|---|---|
| K1 | 重なった snapshot の応答を、届いた順に当てる。先に頼んだ snapshot の応答が後に届くと、新しい State（例: agent の名前の変更）を古いもので上書きしうる | 2 つの snapshot が同時に出ていて、応答の順番が入れ替わる | 応答に番号を振り、古い番号の応答はバッファの処理だけして State には当てない |
| K2 | 購読が切れたときに出ていた snapshot が、切断の後に「つながっている」State を出す。再接続が失敗し続けると、古いデータがつながっている扱いのまま残る | 購読の切断と snapshot の応答が重なる | snapshot を頼んだときの `coverageEpoch` を覚え、変わっていたら `Connected` を false のままにする |
| K3 | herdr が worktree を付けていないワークスペースに cwd から補った worktree が、次の補完では herdr が付けたものと同じ扱いになる。そのディレクトリが git でなくなっても、次の snapshot までは古い worktree とブランチが表示に残る | 補ったワークスペースのディレクトリが、snapshot と snapshot の間に git のリポジトリでなくなる | worktree が herdr のものか補ったものかを覚えておき、補ったものは git の結果で上書きする（roborev の指摘） |
