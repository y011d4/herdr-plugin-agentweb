# P2 の結果と K3 の判断

計画（docs/go-migration-plan.md）の P2 を 2026-11-24 に行った。結論は **K3 を通過、P3 に進める**。利用者の指示により、P3 には進まずここで止めている。

## 作ったもの

| TS | Go | 内容 |
|---|---|---|
| `server/herdr-client.ts` | `internal/bridge/herdr_client.go`（P0 の試作を仕上げた） | worktree の情報を snapshot ごとに補い、30 秒ごとに git で更新する。外に見せる State を、`server/main.ts` の `currentState` と同じく「コールバックに渡したもの」にした（下記） |
| `server/http.ts` の REST と静的ファイル | `internal/bridge/http.go` | 全ルート、enum の検査、本文 64 KB の上限、明示の MIME 表、`no-cache`、パスの外に出ない検査。Node の既定のタイムアウト（ヘッダー 60 秒、keep-alive 5 秒、リクエスト全体 5 分）を写した |
| `server/http.ts` の WS | `internal/bridge/ws.go` | deflate（context takeover、1 KB 未満は圧縮しない）、64 KB の上限（超えると 1009）、ping と pong、ペインと transcript の監視、Origin を確かめない。接続ごとの送信 goroutine と上限つきの待ち行列（D3）。`broadcastState` は計画 §3.7 のロックの順番どおり |
| `server/main.ts` | `internal/bridge/serve.go`、`cmd/agentwebctl/main.go`（`serve` だけ）、`embed.go` | web のビルド済みのファイルと `orchestrator/rules.md` を埋め込む。開発用に `AGENTWEB_WEB_DIR` |
| — | `tools/fakeherdr/cmd/record-wire` の変更と `main_test.go` | 通信の記録の道具で Go の bridge も動かし、TS の記録と比べるテスト |

## 完了の条件の確認

| 条件 | 結果 |
|---|---|
| シナリオの記録と一致する | 10/10（P0 からの 10 本。worktree の補完と State の公開の変更の後も一致） |
| 通信の記録のうち REST と WS の操作に一致する | 28/28（`cli-` 以外すべて）。`TestGoBridgeMatchesWireRecordings` が Go のバイナリを作り、記録の道具で同じ操作をして比べる。わざと Ctrl+U を 29 回にすると、文章の送信の 3 件が落ちることを確かめた |
| §5.2 の CLI 以外のテスト | HTTP: 全ルートでトークンなしは 401、enum の誤りなどで 400 になり herdr に何も送らない（24 通り）、本文 64 KB と 64 KB + 1 バイト、静的ファイル（MIME、`Cache-Control`、パスの外）。WS: deflate、1009、ping と pong、ペインの監視の開始・停止・`pane_gone`、transcript の監視（追記、session の切り替えでの `reset`、`available:false`）、詰まった接続だけが閉じられること、`broadcastState` を 50 並行で呼んでも最後に届くのが最新の State であること。herdr-client: 再接続の待ち時間（倍になる、30 秒で頭打ち、つながると戻る）、切断の前に頼んだ `agent.list` の答えを捨てること（epoch。条件を外すと落ちることを確かめた） |
| §5.5 のうちサーバー側の項目 | トークン（上記）、既定の待ち受けが loopback であること（`TestTheDefaultListenAddressIsLoopback`）、静的ファイル（上記）、transcript の読み出しの範囲（P1 のテスト）、アカウントが判定できない agent の clear を断り何も開かないこと、`launch_profiles` にない起動を断り、起動するプログラムは profile からだけ取ること |
| サイズと RSS（判断には使わない） | 下記 |

`go vet`、`go test -race ./...`、`npm test`（301 件）、`npm run check:contract` が通る。テストの対応表は 232/232 のまま。

### サイズと RSS

| | 値 |
|---|---|
| バイナリ（web と rules.md を埋め込み） | 12.6 MB。`-trimpath -ldflags "-s -w"` で 8.4 MB |
| RSS（偽の herdr、ペイン 3 つ） | 起動直後 9.8 MB、`/api/state` を 200 回と WS を 1 本使った後 11.3 MB |
| 参考: 動いている Node の bridge（本物の herdr） | 84 MB（最大 96 MB）。負荷が違うので比べる値ではない |

手元の確認は、別のポート（8393、TS 版の比較に 8394）と使い捨ての state、config、data、HOME で行い、終わったら止めた。8390 の bridge と本体のチェックアウトには触っていない。

## 計画からずれたこと、見つかったこと

1. **外に見せる State を TS と同じにした。** P0 の試作は、herdr-client の中で State が変わるたびに公開していた。TS の `/api/state` と WS は、herdr-client の中の State ではなく、`main.ts` がコールバックで受け取った `currentState` を使う。そのため、フォーカスのイベントなど、配信を起こさない変化は次の配信まで `/api/state` に出ない。Go もコールバックに渡すときだけ公開するようにした（並走で `/api/state` を比べたときに、フォーカスで差が出ないようにするため）。
2. **違いの記録に D11〜D14 を足した**（docs/go-migration/divergences.md）。D11 は本文が 64 KB を超えたときの答え方で、TS 版は 413 を返す前に接続を切っていた（P2 で TS 版を動かして確かめた）。D12〜D14 は、埋め込んだファイルだけを返すこと、手で作った URL の扱い、エラーの文言などの細かい差である。web に見えるのは、herdr に届かないときのエラーのトーストの文言と、launch profile の名前に ASCII 以外の文字を使ったときの選択欄の並び（最初に選ばれる profile が変わりうる）の 2 つ。エラーの文言は web の動きを変えない。並びのほうは、選び直さずに起動すると TS とは違う profile で agent が起動しうる（そういう名前の profile を書いたときだけ）。
3. **通信の記録の比較は go test のキャッシュに気をつける。** テストの中で別のプロセスとしてバイナリを作るので、Go のソースを変えてもキャッシュされた合格が出ていた。テストがソースのファイルを `os.Stat` で見るようにして、変えたら必ず走り直すようにした。
4. **書いたテストが一度、10 分の上限まで止まった。原因はテストの書き方で、直した。** 詰まった WS の接続が閉じられることを確かめるテストで、読む側の goroutine が送る側に追いつかないと、読む側の待ち行列もあふれて閉じられ、テストが待ち続けていた。CPU を 1 つにする（`GOMAXPROCS=1`）と毎回再現した。読む側を送る側と同じ goroutine で読むように書き直し、`-race` で 40 回、`GOMAXPROCS=1` と `-race` で `internal/bridge` 全体が通ることを確かめた。bridge の不具合ではない（あふれた接続を閉じるのは D3 のとおりの動き）。
5. **計画 L5 の「`localeCompare` の並べ替えは ASCII の名前では差が出ない」は誤りだった（roborev の指摘）。** ICU の照合順は、大文字と小文字を区別せずに比べてから小文字を先にし、記号は `_` が `-` より前に来るなど、バイト順と違う。web の新しい agent の選択欄は先頭の profile を選んだ状態で開くので、たとえば `Zoo` という profile があると既定が変わる。ICU の順を表にして、ASCII の名前では TS と同じ順に並べるようにした（Node の並べ替えの結果と突き合わせるテストつき）。

## P3 への申し送り

1. `cmd/agentwebctl` は今 `serve` しかない。P3 で `run`、`start`、`stop`、`status`、`qr`、`overview`、`agent`、`worktree`、`orchestrator` を足す。`run` は `bridge.Serve` を同じプロセスで呼べばよい（pidfile を書く処理を足す）。
2. 通信の記録の比較は、`bridgeCmd` を Go のバイナリにすると `cli-` の操作を飛ばす。P3 では CLI の実行（今は `node bin/agentwebctl.ts`）も Go のバイナリに向けて、`cli-` を比べる対象に入れる。CLI の記録は、`claude` の祖先から切り離して（`setsid`）取る必要がある（P0 で確認）。
3. `orchestrator start` は `startOrchestrator(rpc, def, agentweb.Rules)` をそのまま使える。
4. 偽の herdr を単独で動かすコマンドはない（P2 の手元の確認では使い捨てのものを作って消した）。P4 の並走には要らない（本物の herdr を使う）。
5. unix ソケットのパスは 108 バイトまで。scratchpad の下は長すぎるので、偽の herdr のソケットは `/tmp` の短いディレクトリに置く（テストも同じ）。
6. **Go の bridge を本物の data ディレクトリで動かさない（P3 が入るまでは特に）。** `serve` は起動のたびに、管理する orchestrator の `rules.md` と `.claude/settings.json` を、自分の実行ファイルのパスで書き直す（TS 版と同じ動き）。P2 のバイナリには `serve` しかないので、本物の `XDG_DATA_HOME` で動かすと、動いている orchestrator の許可リストが CLI のない Go のバイナリを指してしまう（Node の bridge を起動し直すまで戻らない）。計画の原則 1 のとおり、P5 まで Go の bridge は一時的な `XDG_DATA_HOME` で動かす（P4a は orchestrator を `dir` つきの管理しない扱いにする）。roborev の指摘（P2 の PR）。

## 時間と、残りの見積もり

| 段階 | 計画の作業日 | P1 後の見積もり | 実際 |
|---|---|---|---|
| P0 | 3〜5 | — | 約 25 分（レビュー対応を含めて約 35 分） |
| P1 | 6〜8 | — | 約 45 分 |
| P2 | 9〜13 | 0.5〜1 日 | 約 50 分（12:38〜13:25。PR のレビュー対応を除く） |

- **これからの作業（Claude Code での作業日。レビュー待ちを含めない）:**
  - P3（CLI）: 0.5 日
  - P4（並走と試用）: 0.5〜1 日と暦日 7 日
  - P5: 0.5 日
  - P6: 1〜2 日
- **全体:** 2.5〜4 日と暦日 7 日。レビュー待ちを入れて約 2 週間。
- **凍結:** 今から P5 の手順 3 まで、1.5〜2 週間の見込み。

## K3 の判断

**通過。P3 に進んでよい。** K3 の基準は「シナリオか通信の記録との説明のつかない違いが、直しても 2 回続けて 5 件以上残る」で、説明のつかない違いは 0 件である（シナリオ 10/10、通信の記録 28/28。違いの記録にあるものは D11〜D14 を含めて、記録との比較には出ない）。herdr-client か http の設計を見直す理由はない。
