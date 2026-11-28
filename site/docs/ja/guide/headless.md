# ヘッドレスの orchestrator

項目に `"mode": "headless"` を付けると、その orchestrator は herdr のペインの中のエージェントではなく、ブリッジ自身の `claude -p` として動きます (Claude のサブスクリプションでのみ動きます。ブリッジは API キーでの課金を断ります)。
そのとき Home はチャットだけになります。
作業中にもメッセージを送れます。
"doing now" の行の ■ で中断できます。
質問には回答パネルが出ます。
ステータスバーには、使用量 (`5h · 7d · fable · ctx`。fable は Fable で動いている間だけ)、動いているモデル (Claude Code の `/model` の一覧から選ぶと、ターンの合間に、または次の起動から切り替わります)、起きた問題とそれぞれの対処が表示されます。
そこの **Compact** (ターンの合間だけ。要約に残してほしいことを任意で書けます) は、Claude Code の `/compact` をその場で実行します。
セッションは要約から続き、"doing now" の行に `compacting…`、終わると `compacted: ctx 64% → 12%` と出ます。
コンテキストの 70% 以上を使うと、ctx と Compact がオレンジになります。提案だけで、自動では実行しません (上限の近くでは Claude Code が自分で compact します)。
チャットには、compact で会話が区切られた位置に `[yoicks] compacted` と出ます。
また、あなたのためのやることリスト (`todo` ツール) を持ち、Home の "Needs you" の下に出します。
マージする PR、ログイン、まだ伝えていない判断など、あなたにしかできないことです。
それぞれ期日が来たときに一度だけ知らせます。✓ で 1 つ済みにします。
Home ごとの切り替えボタン (と PC のサイドバーの見出し) には、そこであなたを待っているものの数が出ます。
herdr のペインはありません。PC では、同じ Home をブラウザで開いてください。
アプリを閉じている間も知らせを受けるには、`notify_url` (ntfy) を設定します。
TUI に戻すには、`"mode": "headless"` を外し、ブリッジを再起動して、その Home で **Start** をタップします (新しいセッションになります)。
同じ手順は Home の警告と Settings にも出ます。

## Claude Code の確認 {#checking-claude-code}


ヘッドレスの orchestrator は、Claude Code の `claude -p` のストリームのうち、ドキュメントにない部分に頼っています。
init のキー、中断、権限のツール、transcript、使用量のイベントです。
ライブテストは、本物の `claude` を相手にこれらを確かめます。
haiku、使い捨てのディレクトリ、既定のアカウント (`CLAUDE_CONFIG_DIR` なし)、偽の herdr を使い、セッション 1 つと再開 1 回で、短いターンを 6 回ほど行います。
項目ごとに `PASS`/`FAIL` の行を表示し、終わると自分の `~/.claude/projects/` のエントリを消します。
このテストがバイナリに入ることはありません (`claudelive` タグ)。CI では vet だけを行います。

```bash
go test -tags claudelive -count=1 -run TestClaudeLive -v ./internal/bridge
```

`scripts/claude-canary.sh` は、link したチェックアウトからこのテストを定期的に実行し、結果を `<state dir>/canary.json` に書きます。
ヘッドレスの orchestrator があるブリッジは、このファイルを毎分読みます。
結果は state の `claudeCheck` に入ります。
確認が失敗すると、ヘッドレスの orchestrator それぞれに警告が出ます。
"not verified" という版の警告は、最後の確認の結果も伝えます。
失敗した確認は、それぞれ一度だけ通知されます (ntfy、PC、アプリ)。
スクリプトがテストを実行するのは、Claude Code の版が最後の確認のときと違うときか、その確認から 24 時間たったときだけです (`--force` を付けるとすぐに実行します)。
1 時間ごとの systemd のユーザータイマーがスクリプトを実行します:

```bash
sh scripts/claude-canary.sh install   # writes ~/.config/systemd/user/yoicks-claude-canary.{service,timer}
systemctl --user daemon-reload && systemctl --user enable --now yoicks-claude-canary.timer
```

スクリプトがタイマーを自分で有効にすることはありません。
確認 1 回には haiku の短いセッション 1 つを使います (数万トークンで、ほとんどはキャッシュ)。
1 日に 1 回ほどと、Claude Code の更新ごとに 1 回です。
少ない量ですが、週ごとの利用枠の一部を使います。
利用枠が残り少ないときは、`config.json` の `"canary": false` か `systemctl --user disable --now yoicks-claude-canary.timer` で止めてください。
