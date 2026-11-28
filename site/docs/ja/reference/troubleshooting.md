# 対応状況と困ったとき

## 対応状況 {#compatibility}

| | 状況 |
| --- | --- |
| Linux amd64 | 対応。日常的に使っています |
| Linux arm64 | 対応。CI が arm64 でテスト (偽の herdr を相手にしたブリッジの動作を含む) を回しています。本物の herdr ではまだ動かしていません |
| macOS arm64 / amd64 | 試験的。両方ともビルドしますが、CI で単体テストを回しているのは arm64 だけです。本物の herdr ではまだ動かしていません。[既知の制限](#known-limitations) を参照 |
| herdr | 0.9.5 (ソケットの protocol 22) で確認。ほかの protocol では、ブリッジが `bridge.log` に警告を出し、`status` にも表示します |
| Claude Code | 2.1.322 で確認: orchestrator の権限の規則と、チャット表示が読む transcript の形 |

Windows は対象外です (herdr が動きません)。バイナリは静的にリンクしている (`CGO_ENABLED=0`) ので、
glibc でも musl でも、どの Linux ディストリビューションでも動きます。

## 既知の制限 {#known-limitations}

- **macOS では Claude アカウントの確認ができません。** エージェントの Claude アカウントは Linux の
  `/proc` から読みます。macOS では、ペインのアカウントが要るコマンド (`overview`、`agent …`、
  `worktree remove`) は断られ、orchestrator の Home にはそのアカウントのものではなく全エージェントが並び、
  **Clear** はアカウントを確かめずに起動し直し、CLI は自分の `CLAUDE_CONFIG_DIR` を呼び出し元のアカウントと
  みなします。
- **npm で入れた Claude Code** は `node` として動くので、`yoicks` はそれを呼び出し元の orchestrator の
  Claude のプロセスと見分けられず、自分の `CLAUDE_CONFIG_DIR` で代わりにします。orchestrator には
  Claude Code のネイティブインストーラーで入れたものを使ってください。
- **チャット表示の transcript** は `~/.claude/projects` と `~/.config/claude/<name>/projects` から探します。
  Linux では、ほかの `CLAUDE_CONFIG_DIR` を使うエージェントもプロセスの環境変数から見つけますが、
  macOS では見つけられず、そのペインは端末の表示のままになります。

## 困ったとき {#troubleshooting}

- `curl -s http://127.0.0.1:8390/healthz` が `{"ok":true,"herdrConnected":true}` を返すはずです。応答が
  なければブリッジが動いていません (起動して `bridge.log` を読んでください)。`"herdrConnected":false` なら、
  herdr のソケット (`$HERDR_SOCKET_PATH`、既定は `~/.config/herdr/herdr.sock`) につながっていません。
- `herdr plugin action invoke y011d4.yoicks.status` は、プラグインと herdr の版、herdr の protocol
  (確認済みでなければ警告つき)、herdr がプラグインに渡す PATH で見つかった任意のコマンドを表示します。
  出力は `herdr plugin log list --plugin y011d4.yoicks` の `stdout` で読めます。
- デタッチしたブリッジのログは state ディレクトリ (`~/.local/state/herdr/plugins/y011d4.yoicks`) の
  `bridge.log` です。動いている版、つながった herdr、エラーが出ます。トークンは書かれません (古いブリッジが
  書いた行のトークンも `start` が伏せます) が、パスやエージェントが出るので、ほかの人に見せないでください。
- 更新した後もスマホに古いアプリが出るときは、閉じて開き直してください (service worker が裏で新しい版を
  取得します)。
- 接続ペインに URL だけが出て QR コードが出ないときは、`qrencode` を入れてください。
