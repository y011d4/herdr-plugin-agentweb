# P1 の結果と K2 の判断

計画（docs/go-migration-plan.md）の P1 を 2026-11-24 に行った。結論は **K2 を通過、P2 に進める**。利用者の指示により、P2 には進まずここで止めている。

## 作ったもの

ソケット、HTTP、WS を使わない部分を、TS のモジュールと 1 対 1 のファイルにして `internal/bridge/` に移した。

| TS | Go | テスト |
|---|---|---|
| `server/types.ts`（と共有の型） | `types.go` | — |
| `server/state.ts` | `state.go` | 39/39 |
| `server/agent-lifecycle.ts`、`server/config.ts` | `agent_lifecycle.go`、`config.go` | 44/44、6/6 |
| `server/transcript-normalize.ts`、`server/transcript.ts`、`server/overview.ts` | `transcript_normalize.go`、`transcript.go`、`overview.go` | 17/17、18/18、14/14 |
| `server/prompt-identity.ts`、`server/auth.ts`、`server/pane-profile-store.ts`、`server/ndjson.ts`、`server/notify.ts` | 同名の `.go` | 15/15、13/13、5/5、10/10、2/2 |
| `server/worktree-resolve.ts` | `worktree_resolve.go` | 36/36 |
| `server/account.ts`、`server/orchestrator.ts` | `account.go`、`orchestrator.go` | 6/6、7/7 |

- **テストの対応表との突き合わせ:** `go test -json ./internal/bridge/ | go run ./tools/testmap -check docs/go-migration/test-map.md` で **232/232**。名前の道筋（`describe › it`）まで一致したものだけを数える。
- **P0 の herdr-client:** 仮の state を本物の `state.go` に置き換えた。10 本のシナリオの記録すべてと、フォーカスとタブ名まで一致する（P0 で付けていた `SkipModel` は消した）。
- **web との契約（計画 §6 の T3'）:** `internal/bridge/contract_test.go` が、Go の JSON（State、WS のメッセージ 7 通り、TimelineItem の全種類）を `testdata/contract/` と型注釈つきの `web/test/contract.gen.ts` に書き出す。`npm run check:contract`（tsc。CI で実行）で web の型と突き合わせる。
  - 最初の実行で、bridge が前から送っている `orchestratorPaneId` が web の `AppState` にないことが見つかり、足した。型だけの変更で、ビルドした JS は変わらない。
  - `web/test/contract.test.ts` は、そのデータを web の描画関数に通す。
- **両方の言語にある同じ処理（計画 §6）:** 共有の入力と期待値を作った。どちらか片方だけを直すとテストが落ちる。
  - `testdata/vectors/prompt.json`: `parsePrompt`
  - `testdata/vectors/injected-turns.json`: Claude Code が自分で書く user の行の見分け方
- **web のテスト:** 291 件から 301 件に増えた（契約、vectors）。
- **進め方:** 共有の型と `state.go` を先に書いた。そのうえでモジュールを依存の閉じた組に分け、5 つの agent に別の worktree で並行して移植させてから、取り込んだ。agent の worktree は片づけてある。

## 完了の条件の確認

| 条件 | 結果 |
|---|---|
| 対応表で N/N | 232/232 |
| `go test -race` が通る | 通る（`internal/bridge` は約 17 秒） |
| 契約のテストが Go と web の両方で通る | Go の書き出しが記録と一致し、tsc と web のテストが通る |

## 計画からずれたこと

- **P2 の範囲が小さくなった:** 計画では P2 だった account の /proc と direnv、transcript の /proc の読み出し、worktree の git の実行を P1 で移した。テストの対応表にあるテストがそれらを使うため。P2 に残るのは、herdr-client の仕上げ、HTTP、WS、静的ファイル、`serve` である。
- **違いの記録に D6〜D9 を足した**（`docs/go-migration/divergences.md`）。どれも壊れた入力や珍しい環境でだけ出る差である。
  - D6: 文字数で切るときにサロゲートペアを割らない。
  - D7: 型の崩れたイベント。
  - D8: launch profile を部分一致で選ぶ順番。
  - D9: JSON の U+2028・U+2029、時刻の形など。

## P2 への申し送り

1. **HTTP の本文:** `StartAgentInput` と `CreateWorktreeInput` は `jsField(body, "…")` で組み立てる。JSON の null（TS では 400）と、項目なし（TS では既定値）を区別するため。
2. **`placeWorktreeNextToRepo`:** 復号した JSON の map を受け取る形になっている（並行して作った `CreateWorktreeInput` と名前がぶつかるのを避けたため）。HTTP 層でつなぐ。
3. **`refreshWorktrees`:** すぐに返り、変化があれば別の goroutine から `onChange` を呼ぶ。herdr-client はそれを actor に送り直す。
4. **`sendNtfyNotification`:** 送り終わるまで戻らないので、`go` で呼ぶ。
5. **JSON の書き出し:** HTML のエスケープをしない（`marshalRaw`、または `SetEscapeHTML(false)` の encoder）。Marshaler の中でエスケープすると、外の encoder では戻せない。
6. **`PaneAccountCache`:** `Refresh` と `Accounts`（写し）を使う。`onChange` はロックを放してから呼ばれる。broadcast の側も §3.7 のロックの順番を守る。
7. **orchestrator の rules:** rules.md の中身は引数で渡す。P2 でリポジトリの根に `embed.go` を作って埋め込む。
8. **transcript の行の読み込み:** キーの順番を保つ自前の JSON デコーダを使っている。2 MiB の末尾で約 70 ms かかる（V8 の約 3 倍）。チャットを最初に開くときだけの時間なので、そのままにする。

## 時間と、残りの見積もり

| 段階 | 計画の作業日 | P0 後の見直し | 実際 |
|---|---|---|---|
| P0 | 3〜5 | — | 約 25 分（レビュー対応を含めて約 35 分） |
| P1 | 6〜8 | 0.5〜1 日 | 約 45 分（11:02〜11:45。うち agent の並行作業が約 25 分） |

- **これからの作業（Claude Code での作業日。レビュー待ちを含めない）:**
  - P2（herdr-client の仕上げ、HTTP 約 1,000 行、WS、`serve`、通信の記録との突き合わせ）: 0.5〜1 日
  - P3（CLI）: 0.5 日
  - P4（並走と試用）: 0.5〜1 日と暦日 7 日
  - P5: 0.5 日
  - P6: 1〜2 日
- **全体:** 3〜5 日と暦日 7 日。レビュー待ちを入れて約 2 週間。
- **凍結:** 今から P5 の手順 3 まで、1.5〜2 週間の見込み。

## K2 の判断

**通過。P2 に進んでよい。** K2 の基準は「P1 に 16 作業日以上かかった」または「全体の見積もりが 60 作業日を超える」で、どちらにも当たらない（P1 は 1 時間足らず、残りは 3〜5 作業日と暦日 7 日）。

あわせて、P2 の危ないところへの備えも揃っている。
- herdr-client の土台は、本物の state の上で TS 版と同じ動きをしている。
- web と Go の JSON の食い違いは tsc で見つかるようになった。
