# `yoicks` のコマンド

orchestrator は、次のコマンド (プラグインの `bin/yoicks`) でワーカーを動かします。
どのコマンドも、呼び出し元の Claude アカウントの外には触れません ([orchestrator](../guide/orchestrators#what-it-can-reach) を参照):

- `overview` — このアカウントのほかのエージェントを、読み取り専用のテキストでまとめます (場所、起動ディレクトリ、ステータス、最後の依頼、最後の返答、実行中のツール呼び出し)。
- `agent get|read|prompt|wait <target> [flags]` — そのエージェントに対して `herdr agent …` を実行します。
  ほかのアカウントのエージェントには断ります。
  出力とフラグは herdr のものです。
- `agent start <name> --cwd <dir> [--profile <launch profile>] [--worktree <branch> [--base <ref>]]` —
  `launch_profiles` のエージェントを orchestrator のアカウントで起動します。
  起動先は、すでに `dir` にあるワークスペースの新しいタブです (無ければ新しいワークスペース)。
  direnv の `.envrc` がほかのアカウントを指定している場所では断ります。
  `--worktree` を付けると、そこにあるリポジトリの新しい worktree で起動します。worktree はリポジトリの隣に作られます (`<repo>-wt-<branch>`)。
  herdr は worktree に環境変数を渡せないので、worktree のアカウントはディレクトリから決まる必要があります。
  リポジトリより上にある `.envrc` (たとえば組織のディレクトリごとに 1 つ) があれば、それが worktree にも効きます。
  起動したエージェントのアカウントは確認され、合わなければまた止めます。
  そのとき、新しい worktree は残します。エージェントがすでに書き込んだかもしれないからです。
  エージェントが終了すると (`/exit` でも、自分から終わっても)、ブリッジはそのエージェントのために開いたタブを閉じます (そのタブのシェルには `YOICKS_WORKER=1` の印があります)。
  そのため、終わったワーカーが idle のシェルを残すことはありません。worktree のタブは `worktree remove` で一緒に閉じます。
- `worktree remove <checkout path>` — 終わったワーカーのリンクされた worktree とそのブランチを消します。
  消すのは、そこにエージェントが残っておらず、コミットされていないファイルも追跡されていないファイルもなく、ブランチがマージ済み (`origin/HEAD` の祖先、または squash merge の場合は `gh` で調べたマージ済みの PR の head) のときだけです。
  detached HEAD のまま残った worktree (デプロイしたものをチェックアウトしたワーカーの worktree) は、そのコミットが `origin/HEAD` にあれば消します。
  ディレクトリの名前が示すブランチ (`<repo>-wt-<branch>`。reflog でも、そのブランチから始まったことがわかるもの) は、そのブランチもマージ済みのときだけ消します。
  そうでなければブランチは残し、答えにそう書きます。
  worktree にシェルが残っていても、削除は妨げられません。herdr がそのワークスペースを閉じます。
- `orchestrator start <name>` — 設定した orchestrator を起動します。Home の **Start** と同じです。
  これはあなたのためのコマンドで、orchestrator のためのものではありません。orchestrator の許可リストには入っていません。
