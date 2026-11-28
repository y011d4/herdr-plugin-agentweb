# orchestrator

orchestrator は、あなたが話しかける Claude Code のエージェントです。
仕事をほかのエージェントに任せ、結果を報告します。
[設定](../reference/config)の `orchestrators` に並べておくと、アプリを開いたときにそのうちの 1 つの **Home** が開きます。

## orchestrator のディレクトリ {#its-directory}


`orchestrators` の各項目について、プラグインはディレクトリ `~/.local/share/herdr-yoicks/orchestrators/<name>/` (`$XDG_DATA_HOME` があればその下) を持ちます。
ブリッジの起動時と、その orchestrator を起動するたびに、次のファイルを書きます:

- `CLAUDE.md` — orchestrator の名前を書き、下の 2 つのファイルを読み込みます。
- `rules.md` — プラグインに同梱の規則 ([`orchestrator/rules.md`](https://github.com/y011d4/herdr-yoicks/blob/main/orchestrator/rules.md)) です。
  ワーカーの起動、その後の追い方、報告、終わった後の片付けの方法を書いています。
- `.claude/settings.json` — orchestrator の権限です (下を参照)。
- `local.md` — **あなたのもの**: この orchestrator だけの規則です (どのリポジトリを受け持つか、答える言語、調べもの用の安い起動プロファイル…)。
  一度だけ空で作られ、上書きされることはありません。
  あなた自身の権限には `.claude/settings.local.json` を使ってください。

orchestrator は、そのディレクトリで開く新しい herdr のワークスペースで、その `env` を付けて起動します。
続いてプラグインは、`env` が指定する Claude アカウントで起動したことを確かめ、違えば止めます。
direnv のようなディレクトリごとの道具は要りません。
**Clear** (エージェントのメニュー) は、同じアカウントで起動し直します。

## 何に触れられるか {#what-it-can-reach}

orchestrator は、ワーカーを `yoicks` だけで動かします。
`yoicks` は、その orchestrator 自身の Claude アカウントの外には触れません。
アカウントとは、エージェントのプロセスの `CLAUDE_CONFIG_DIR` (既定は `~/.claude`) のことです。
アカウントが違うもの、またはアカウントがわからないものは、隠されるか断られます。
コマンドの一覧は [`yoicks` のコマンド](../reference/cli) にあります。

プラグインが書く `.claude/settings.json` は、orchestrator をこれらのコマンドに絞ります。
`"defaultMode": "dontAsk"` (許可されていないものは尋ねずに断る) にし、これらのコマンドだけを許可し、herdr の CLI とほかのアカウントの transcript を拒否します。
`dontAsk` でも読み取り専用のコマンドは動きますが、よく使う読み取りのコマンド (`cat`、`ls`、`grep`、`git -C`…) は、orchestrator のディレクトリの外のパスに対してはもともと断ります。
Claude Code 2.1.322 の時点では `tree`、`du`、`fd`/`fdfind`、`lsof` は通るので、これらも拒否しています。
存在の確認 (`test -e`、`realpath`) には今も答えが返ります。
(Claude Code の `blockReadsOutsideWorkingDirectories` は使いません。
これを使うと `yoicks` 自体も断られます。`yoicks` のパスや `--cwd`/worktree のパスはディレクトリの外にあり、どの許可の規則でもこれは外せません。)
ワーカー自体は普通のエージェントで、権限はいつもどおりあなたに確認します。
この境界は、それぞれの orchestrator、つまりそれぞれのアカウントが何を見られるかについてのものです。

## ヘッドレス {#headless}

orchestrator は、ペインを持たずに、ブリッジ自身の `claude -p` として動かすこともできます。
[ヘッドレスの orchestrator](./headless) を参照してください。
